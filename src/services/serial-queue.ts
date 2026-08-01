import { AppError } from "../util/app-error.js";

/** Runs asynchronous jobs one at a time while allowing the queue to recover from failures. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const start = (): Promise<T> => {
      if (signal?.aborted) {
        throw new AppError("CANCELLED", "The queued transcription was cancelled.");
      }
      return job();
    };
    const result = this.tail.then(start, start);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
