export class DeferredLatest {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;

  schedule<T>(
    delayMs: number,
    produce: () => T,
    apply: (value: T) => void,
  ): void {
    this.cancel();
    const revision = this.revision;
    this.timer = setTimeout(() => {
      this.timer = null;
      const value = produce();
      if (revision === this.revision) apply(value);
    }, delayMs);
  }

  cancel(): void {
    this.revision += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
