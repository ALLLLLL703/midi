import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { extname, join } from "node:path";
import { chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { AppError } from "../util/app-error.js";
import { ensureWritableDirectory, resolveAllowedFile } from "../util/path-security.js";
import type { HttpsDownloader } from "./https-downloader.js";

export interface ResolvedSource {
  readonly path: string;
  readonly sourceKind: "local" | "url";
  cleanup(): Promise<void>;
}

function parseRemoteSource(source: string): URL | undefined {
  try {
    const url = new URL(source);
    if (url.protocol !== "https:") {
      throw new AppError("HTTPS_REQUIRED", "Remote audio sources must use HTTPS.");
    }
    return url;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
      throw new AppError("INVALID_SOURCE_URL", "The remote audio source URL is invalid.");
    }
    return undefined;
  }
}

/** Resolves local and remote audio sources into a temporary local file path. */
export class SourceResolver {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly downloader: HttpsDownloader,
  ) {}

  public async resolve(source: string, signal?: AbortSignal): Promise<ResolvedSource> {
    await ensureWritableDirectory(this.config.outputDirectory);
    const url = parseRemoteSource(source);
    if (!url) {
      const originalPath = await resolveAllowedFile(source, this.config.allowedInputDirectories);
      const directory = join(this.config.outputDirectory, ".inputs");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const suffix = extname(originalPath).slice(0, 16) || ".audio";
      const path = join(directory, `${randomUUID()}${suffix}`);
      const input = await open(
        originalPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const openedPath = await realpath(`/proc/self/fd/${input.fd}`);
        await resolveAllowedFile(openedPath, this.config.allowedInputDirectories);
        const inputStat = await input.stat();
        if (!inputStat.isFile()) {
          throw new AppError("INPUT_NOT_REGULAR_FILE", "The local audio source must be a regular file.");
        }
        if (inputStat.size > this.config.downloadMaxBytes) {
          throw new AppError(
            "INPUT_TOO_LARGE",
            `The local audio source exceeds ${this.config.downloadMaxBytes} bytes.`,
          );
        }
        if (signal?.aborted) throw new AppError("CANCELLED", "Audio staging was cancelled.");
        let copiedBytes = 0;
        const limiter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            copiedBytes += chunk.length;
            callback(
              copiedBytes > this.config.downloadMaxBytes
                ? new AppError(
                    "INPUT_TOO_LARGE",
                    `The local audio source exceeds ${this.config.downloadMaxBytes} bytes.`,
                  )
                : null,
              chunk,
            );
          },
        });
        await pipeline(
          input.createReadStream({ autoClose: false }),
          limiter,
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
          { signal },
        );
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      } finally {
        await input.close();
      }
      return { path, sourceKind: "local", cleanup: () => rm(path, { force: true }) };
    }

    const candidateSuffix = extname(url.pathname);
    const suffix = /^\.[a-z\d]{1,10}$/i.test(candidateSuffix) ? candidateSuffix : ".audio";
    const path = join(this.config.outputDirectory, ".downloads", `${randomUUID()}${suffix}`);
    await this.downloader.download(url, path, signal);
    return {
      path,
      sourceKind: "url",
      cleanup: () => rm(path, { force: true }),
    };
  }
}
