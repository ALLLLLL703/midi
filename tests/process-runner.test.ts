import { describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../src/services/process-runner.js";

describe("NodeProcessRunner", () => {
  it("returns stdout, stderr, and the exit code", async () => {
    const result = await new NodeProcessRunner().run(
      process.execPath,
      ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
      5_000,
    );

    expect(result).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("escalates a timeout when a process ignores SIGTERM", async () => {
    const startedAt = Date.now();
    await expect(
      new NodeProcessRunner().run(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        50,
      ),
    ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 7_000);

  it("terminates a running process when the MCP request is cancelled", async () => {
    const controller = new AbortController();
    const running = new NodeProcessRunner().run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      10_000,
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 50);

    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("does not misreport a signal exit as a timeout", async () => {
    const result = await new NodeProcessRunner().run(
      process.execPath,
      ["-e", "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10)"],
      500,
    );

    expect(result.exitCode).toBe(1);
  });
});
