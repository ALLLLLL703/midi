import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { rm } from "node:fs/promises";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { AppError } from "../util/app-error.js";
import { resolveAllowedFile } from "../util/path-security.js";
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

  public async resolve(source: string): Promise<ResolvedSource> {
    const url = parseRemoteSource(source);
    if (!url) {
      const path = await resolveAllowedFile(source, this.config.allowedInputDirectories);
      return { path, sourceKind: "local", cleanup: () => Promise.resolve() };
    }

    const suffix = extname(url.pathname).slice(0, 16) || ".audio";
    const path = join(this.config.outputDirectory, ".downloads", `${randomUUID()}${suffix}`);
    await this.downloader.download(url, path);
    return {
      path,
      sourceKind: "url",
      cleanup: () => rm(path, { force: true }),
    };
  }
}
