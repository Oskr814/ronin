// What the person asked for can't be: the page shows its message as is,
// with its HTTP status (400 unless it says otherwise) and anything else it
// has to say (`details`: a deploy's plan as it is now). Any other error is
// ronin's own: a 500 with an id the log has too (platform/http/middleware.ts).
export class DomainError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(message: string, opts: { status?: number; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status ?? 400;
    this.details = opts.details ?? {};
  }
}
