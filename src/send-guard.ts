import { createHash } from "node:crypto";

export class RecentSendGuard {
  readonly #reservations = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  reserve(target: string, message: string, now = Date.now()): string {
    for (const [fingerprint, reservedAt] of this.#reservations) {
      if (now - reservedAt >= this.windowMs) this.#reservations.delete(fingerprint);
    }

    const fingerprint = createHash("sha256").update(`${target}\0${message}`).digest("hex");
    if (this.#reservations.has(fingerprint)) {
      throw new Error(
        "Refusing to repeat the same message to the same target within 10 minutes. Check Facebook before trying again.",
      );
    }
    this.#reservations.set(fingerprint, now);
    return fingerprint;
  }

  release(fingerprint: string | undefined): void {
    if (fingerprint) this.#reservations.delete(fingerprint);
  }
}
