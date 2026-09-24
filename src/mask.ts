// Output masking for `run`: every byte the child writes to stdout/stderr passes
// through here, and any resolved secret value in it is replaced before it
// reaches the terminal — or the agent reading that terminal. A test that dumps
// its config, a stack trace that prints a connection string, `printenv` — all
// come out as [redacted].
//
// It's a stream, so a value can arrive split across two chunks. Holding back
// a fixed-size tail would stall the last line of every log ("Listening on
// :3000") until more output came, so only a tail that could actually be the
// start of a secret is held; ordinary output passes through immediately.
//
// Masking is a guard against accidents, not a sandbox: a process that wants to
// leak a value can transform it first (base64, reverse, split). Values shorter
// than MIN_MASK_LENGTH aren't masked at all — masking "1" would shred the
// output — and `run` says when that happens.

export const MASK = "[redacted]";
export const MIN_MASK_LENGTH = 4;

export class Masker {
  private readonly secrets: Buffer[];
  private pending: Buffer = Buffer.alloc(0);
  private readonly mask = Buffer.from(MASK);

  constructor(values: Iterable<string>) {
    const unique = new Set([...values].filter((value) => value.length >= MIN_MASK_LENGTH));
    // Longest first, so at a tie the whole secret is masked, not a shorter one inside it.
    this.secrets = [...unique].map((value) => Buffer.from(value, "utf8")).sort((a, b) => b.length - a.length);
  }

  get active(): boolean {
    return this.secrets.length > 0;
  }

  push(chunk: Buffer): Buffer {
    if (!this.active) return chunk;
    const buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Buffer[] = [];
    let position = 0;
    for (;;) {
      let at = -1;
      let length = 0;
      for (const secret of this.secrets) {
        const index = buffer.indexOf(secret, position);
        if (index !== -1 && (at === -1 || index < at)) {
          at = index;
          length = secret.length;
        }
      }
      if (at === -1) break;
      out.push(buffer.subarray(position, at), this.mask);
      position = at + length;
    }
    const rest = buffer.subarray(position);
    const hold = this.partialTail(rest);
    out.push(rest.subarray(0, rest.length - hold));
    this.pending = Buffer.from(rest.subarray(rest.length - hold));
    return Buffer.concat(out);
  }

  /** Whatever is still held back, once the stream has ended. */
  flush(): Buffer {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }

  /** Length of the longest suffix of `buffer` that is a proper prefix of some secret. */
  private partialTail(buffer: Buffer): number {
    const longest = Math.min(buffer.length, this.secrets[0].length - 1);
    for (let size = longest; size > 0; size--) {
      const tail = buffer.subarray(buffer.length - size);
      if (this.secrets.some((secret) => secret.length > size && secret.subarray(0, size).equals(tail))) return size;
    }
    return 0;
  }
}
