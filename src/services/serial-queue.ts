/** Runs asynchronous jobs one at a time while allowing the queue to recover from failures. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
