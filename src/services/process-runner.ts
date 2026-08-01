import { spawn } from "node:child_process";
import { AppError } from "../util/app-error.js";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    arguments_: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult>;
}

const MAX_CAPTURED_CHARACTERS = 1024 * 1024;

/** Runs a process without a shell and captures bounded diagnostic output. */
export class NodeProcessRunner implements ProcessRunner {
  public run(
    command: string,
    arguments_: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AppError("CANCELLED", `${command} was cancelled before it started.`));
        return;
      }
      const child = spawn(command, arguments_, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let terminationError: AppError | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let fallbackTimer: NodeJS.Timeout | undefined;

      const killProcessTree = (processSignal: NodeJS.Signals): void => {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, processSignal);
          } else {
            child.kill(processSignal);
          }
        } catch {
          // The process may have exited between the state check and the signal.
        }
      };
      const terminate = (error: AppError): void => {
        if (terminationError || child.exitCode !== null || child.signalCode !== null) return;
        terminationError = error;
        killProcessTree("SIGTERM");
        forceKillTimer = setTimeout(() => {
          killProcessTree("SIGKILL");
          fallbackTimer = setTimeout(() => {
            cleanup();
            reject(error);
          }, 2_000);
        }, 2_000);
      };
      const onAbort = (): void => {
        terminate(new AppError("CANCELLED", `${command} was cancelled.`));
      };
      const timeoutTimer = setTimeout(() => {
        terminate(new AppError("PROCESS_TIMEOUT", `${command} exceeded the configured timeout.`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-MAX_CAPTURED_CHARACTERS);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_CAPTURED_CHARACTERS);
      });
      child.once("error", (error) => {
        cleanup();
        reject(new AppError("PROCESS_START_FAILED", `Failed to start ${command}: ${error.message}`, { cause: error }));
      });
      child.once("close", (exitCode) => {
        cleanup();
        if (terminationError) {
          reject(terminationError);
          return;
        }
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
}
