import { spawn } from "node:child_process";
import { AppError } from "../util/app-error.js";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(command: string, arguments_: readonly string[], timeoutMs: number): Promise<ProcessResult>;
}

const MAX_CAPTURED_CHARACTERS = 1024 * 1024;

/** Runs a process without a shell and captures bounded diagnostic output. */
export class NodeProcessRunner implements ProcessRunner {
  public run(
    command: string,
    arguments_: readonly string[],
    timeoutMs: number,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-MAX_CAPTURED_CHARACTERS);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_CAPTURED_CHARACTERS);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new AppError("PROCESS_START_FAILED", `Failed to start ${command}: ${error.message}`, { cause: error }));
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new AppError("PROCESS_TIMEOUT", `${command} exceeded the configured timeout.`));
          return;
        }
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
}
