// Attempts per key in a sliding window (#114): failed logins per email and
// per IP, reset-link requests. In memory: a restart forgets them, which only
// gives an attacker a fresh window every deploy — the per-email limit still
// makes guessing a password hopeless.

export class RateLimit {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  hit(key: string, now = Date.now()): void {
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  reset(): void {
    this.hits.clear();
  }
}
