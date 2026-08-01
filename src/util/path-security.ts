import { access, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppError } from "./app-error.js";

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

/** Resolves a file and rejects path or symlink escapes from configured roots. */
export async function resolveAllowedFile(
  inputPath: string,
  allowedDirectories: readonly string[],
): Promise<string> {
  let candidate: string;
  try {
    candidate = await realpath(inputPath);
  } catch (error) {
    throw new AppError("INPUT_NOT_FOUND", `Input file does not exist: ${inputPath}`, {
      cause: error,
    });
  }

  const roots = await Promise.all(
    allowedDirectories.map(async (directory) => {
      try {
        return await realpath(directory);
      } catch {
        return resolve(directory);
      }
    }),
  );
  if (!roots.some((root) => isWithin(root, candidate))) {
    throw new AppError(
      "INPUT_OUTSIDE_ALLOWED_DIRECTORIES",
      "The input file is outside the configured allowed directories.",
    );
  }
  return candidate;
}

/** Creates the dedicated output directory and verifies it is writable. */
export async function ensureWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  try {
    await access(directory, constants.W_OK);
  } catch (error) {
    throw new AppError("OUTPUT_NOT_WRITABLE", `Output directory is not writable: ${directory}`, {
      cause: error,
    });
  }
}
