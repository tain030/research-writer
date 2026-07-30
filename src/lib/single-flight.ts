export class SingleFlight<T> {
  private current: Promise<T> | null = null;

  run(task: () => Promise<T>): Promise<T> {
    if (this.current) return this.current;

    const pending = task();
    const tracked = pending.finally(() => {
      if (this.current === tracked) this.current = null;
    });
    this.current = tracked;
    return tracked;
  }

  get active(): boolean {
    return this.current !== null;
  }
}
