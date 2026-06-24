export type LifecycleGateOperation = () => Promise<void> | void;

export type LifecycleGatePendingState = {
  starting: boolean;
  stopping: boolean;
};

export class LifecycleGate {
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  public getPendingState(): LifecycleGatePendingState {
    return {
      starting: this.startPromise !== undefined,
      stopping: this.stopPromise !== undefined
    };
  }

  public start(operation: LifecycleGateOperation): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    const stopPromise = this.stopPromise;
    this.startPromise = Promise.resolve()
      .then(async () => {
        if (stopPromise) {
          await stopPromise;
        }
        await operation();
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }

  public stop(operation: LifecycleGateOperation): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const startPromise = this.startPromise;
    this.stopPromise = Promise.resolve()
      .then(async () => {
        if (startPromise) {
          try {
            await startPromise;
          } catch {
            // Stop must still be able to clean up a partially-started runtime.
          }
        }
        await operation();
      })
      .finally(() => {
        this.stopPromise = undefined;
      });
    return this.stopPromise;
  }
}
