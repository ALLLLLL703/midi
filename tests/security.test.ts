import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { isPublicAddress, SecureHttpsDownloader } from "../src/services/https-downloader.js";
import { ensurePrivateSubdirectory, resolveAllowedFile } from "../src/util/path-security.js";
import { SourceResolver } from "../src/services/source-resolver.js";
import type { RuntimeConfig } from "../src/config/runtime-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "midi-mcp-"));
  temporaryDirectories.push(path);
  return path;
}

describe("resolveAllowedFile", () => {
  it("allows a real file inside an allowed directory", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "song.wav");
    await writeFile(input, "audio");

    await expect(resolveAllowedFile(input, [root])).resolves.toBe(input);
  });

  it("rejects files outside allowed directories", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const input = join(outside, "secret.wav");
    await writeFile(input, "audio");

    await expect(resolveAllowedFile(input, [root])).rejects.toMatchObject({
      code: "INPUT_OUTSIDE_ALLOWED_DIRECTORIES",
    });
  });

  it("rejects a symlink that escapes an allowed directory", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(root, "nested"));
    const target = join(outside, "secret.wav");
    const link = join(root, "nested", "linked.wav");
    await writeFile(target, "audio");
    await symlink(target, link);

    await expect(resolveAllowedFile(link, [root])).rejects.toMatchObject({
      code: "INPUT_OUTSIDE_ALLOWED_DIRECTORIES",
    });
  });
});

describe("public address classification", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"])(
    "blocks %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("SecureHttpsDownloader", () => {
  it("blocks a private destination at the connection lookup and leaves no file", async () => {
    const root = await temporaryDirectory();
    const destination = join(root, "downloads", "audio.wav");
    const downloader = new SecureHttpsDownloader(1024, 1000);

    await expect(downloader.download(new URL("https://127.0.0.1/audio.wav"), destination)).rejects.toMatchObject({
      code: "PRIVATE_NETWORK_BLOCKED",
    });
    await expect(readFile(destination)).rejects.toThrow();
  });
});

describe("SourceResolver", () => {
  it("copies local audio into a private snapshot and removes it on cleanup", async () => {
    const root = await temporaryDirectory();
    const output = await temporaryDirectory();
    const input = join(root, "song.wav");
    await writeFile(input, "original audio");
    const config: RuntimeConfig = {
      muscriptorCommand: "muscriptor",
      demucsCommand: "demucs",
      demucsDevice: "auto",
      basicPitchCommand: "basic-pitch",
      allowedInputDirectories: [root],
      outputDirectory: output,
      downloadMaxBytes: 1024,
      downloadTimeoutMs: 1000,
      processTimeoutMs: 1000,
    };
    const resolver = new SourceResolver(config, {
      download: () => Promise.reject(new Error("not expected")),
    });

    const resolved = await resolver.resolve(input);
    await writeFile(input, "changed");
    expect(await readFile(resolved.path, "utf8")).toBe("original audio");
    expect((await stat(resolved.path)).mode & 0o777).toBe(0o600);
    await resolved.cleanup();
    await expect(readFile(resolved.path)).rejects.toThrow();
  });

  it("rejects non-HTTPS remote sources before downloading", async () => {
    const root = await temporaryDirectory();
    const config: RuntimeConfig = {
      muscriptorCommand: "muscriptor",
      demucsCommand: "demucs",
      demucsDevice: "auto",
      basicPitchCommand: "basic-pitch",
      allowedInputDirectories: [root],
      outputDirectory: root,
      downloadMaxBytes: 1024,
      downloadTimeoutMs: 1000,
      processTimeoutMs: 1000,
    };
    const resolver = new SourceResolver(config, {
      download: () => Promise.reject(new Error("not expected")),
    });

    await expect(resolver.resolve("http://example.com/song.wav")).rejects.toMatchObject({
      code: "HTTPS_REQUIRED",
    });
  });

  it("applies the configured byte limit to local audio snapshots", async () => {
    const root = await temporaryDirectory();
    const output = await temporaryDirectory();
    const input = join(root, "large.wav");
    await writeFile(input, "too large");
    const config: RuntimeConfig = {
      muscriptorCommand: "muscriptor",
      demucsCommand: "demucs",
      demucsDevice: "auto",
      basicPitchCommand: "basic-pitch",
      allowedInputDirectories: [root],
      outputDirectory: output,
      downloadMaxBytes: 4,
      downloadTimeoutMs: 1000,
      processTimeoutMs: 1000,
    };
    const resolver = new SourceResolver(config, {
      download: () => Promise.reject(new Error("not expected")),
    });

    await expect(resolver.resolve(input)).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
  });
});

describe("ensurePrivateSubdirectory", () => {
  it("rejects a pre-existing symbolic-link work directory", async () => {
    const output = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(output, ".lead-vocal"));

    await expect(ensurePrivateSubdirectory(output, ".lead-vocal")).rejects.toMatchObject({
      code: "UNSAFE_PRIVATE_DIRECTORY",
    });
  });
});
