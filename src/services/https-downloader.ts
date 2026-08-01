import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { request } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { dirname } from "node:path";
import ipaddr from "ipaddr.js";
import { AppError } from "../util/app-error.js";

const MAX_REDIRECTS = 5;

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const resolved = Array.isArray(addresses) ? addresses : [addresses];
    if (resolved.length === 0 || resolved.some(({ address }) => !isPublicAddress(address))) {
      callback(new AppError("PRIVATE_NETWORK_BLOCKED", "The URL resolves to a non-public network address."), "", 0);
      return;
    }
    if (options.all) {
      callback(null, resolved);
      return;
    }
    const selected = resolved.find(({ family }) => !options.family || family === options.family) ?? resolved[0];
    if (!selected) {
      callback(new AppError("DNS_LOOKUP_FAILED", "The URL host did not resolve."), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  });
};

function openPublicHttps(url: URL, signal: AbortSignal): Promise<import("node:http").IncomingMessage> {
  if (url.protocol !== "https:") {
    throw new AppError("HTTPS_REQUIRED", "Remote audio sources must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new AppError("URL_CREDENTIALS_BLOCKED", "URLs containing credentials are not allowed.");
  }
  return new Promise((resolve, reject) => {
    const request_ = request(url, { lookup: publicLookup, signal }, resolve);
    request_.once("error", reject);
    request_.end();
  });
}

async function followRedirects(
  initialUrl: URL,
  signal: AbortSignal,
): Promise<import("node:http").IncomingMessage> {
  let url = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await openPublicHttps(url, signal);
    const location = response.headers.location;
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.resume();
      url = new URL(location, url);
      continue;
    }
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new AppError("DOWNLOAD_HTTP_ERROR", `Audio download returned HTTP ${response.statusCode ?? "unknown"}.`);
    }
    return response;
  }
  throw new AppError("TOO_MANY_REDIRECTS", "Audio download exceeded the redirect limit.");
}

export interface HttpsDownloader {
  download(url: URL, destination: string): Promise<void>;
}

/** Downloads public HTTPS content with redirect, timeout, and byte limits. */
export class SecureHttpsDownloader implements HttpsDownloader {
  public constructor(
    private readonly maxBytes: number,
    private readonly timeoutMs: number,
  ) {}

  public async download(url: URL, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await followRedirects(url, controller.signal);
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > this.maxBytes) {
        response.resume();
        throw new AppError("DOWNLOAD_TOO_LARGE", `Audio download exceeds ${this.maxBytes} bytes.`);
      }
      let received = 0;
      const limiter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          callback(
            received > this.maxBytes
              ? new AppError("DOWNLOAD_TOO_LARGE", `Audio download exceeds ${this.maxBytes} bytes.`)
              : null,
            chunk,
          );
        },
      });
      await pipeline(response, limiter, createWriteStream(destination, { flags: "wx" }));
    } catch (error) {
      await rm(destination, { force: true });
      if (controller.signal.aborted) {
        throw new AppError("DOWNLOAD_TIMEOUT", "Audio download exceeded the configured timeout.", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
