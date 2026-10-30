/** Sliding-window failure counter (per IP, per inbox). In memory by design: it only needs to survive minutes. */
export class FailureTracker {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs = 60_000) {}

  record(key: string, now: number): void {
    const arr = this.prune(key, now);
    arr.push(now);
    this.hits.set(key, arr);
  }

  blocked(key: string, now: number): boolean {
    return this.prune(key, now).length >= this.max;
  }

  private prune(key: string, now: number): number[] {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length === 0) this.hits.delete(key);
    else this.hits.set(key, arr);
    return arr;
  }
}
