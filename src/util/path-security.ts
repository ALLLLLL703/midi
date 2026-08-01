import { access, chmod, lstat, mkdir, realpath } from "node:fs/promises";
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
  await chmod(directory, 0o700);
  try {
    await access(directory, constants.W_OK);
  } catch (error) {
    throw new AppError("OUTPUT_NOT_WRITABLE", `Output directory is not writable: ${directory}`, {
      cause: error,
    });
  }
}

/** Creates a private, non-symlink child directory under a dedicated output root. */
export async function ensurePrivateSubdirectory(root: string, name: string): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new AppError("INVALID_PRIVATE_DIRECTORY", "Private directory name is invalid.");
  }
  await ensureWritableDirectory(root);
  const canonicalRoot = await realpath(root);
  const directory = resolve(canonicalRoot, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AppError("UNSAFE_PRIVATE_DIRECTORY", `Private work path is not a real directory: ${directory}`);
  }
  const canonicalDirectory = await realpath(directory);
  if (!isWithin(canonicalRoot, canonicalDirectory)) {
    throw new AppError("UNSAFE_PRIVATE_DIRECTORY", "Private work directory escaped the output root.");
  }
  await chmod(canonicalDirectory, 0o700);
  return canonicalDirectory;
}
