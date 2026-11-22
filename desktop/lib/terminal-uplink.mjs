/** Bounded single-consumer async queue for one live terminal stream. */
export class TerminalUplink {
  #values = [];
  #bytes = 0;
  #waiting;
  #closed = false;
  push(value) {
    if (this.#closed) return true;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.#waiting) {
      const resolve = this.#waiting; this.#waiting = undefined; resolve({ value, done: false });
    } else {
      if (this.#bytes + bytes > 256 * 1024 || this.#values.length >= 64) return false;
      this.#values.push({ value, bytes }); this.#bytes += bytes;
    }
    return true;
  }
  close() {
    this.#closed = true; this.#values = []; this.#bytes = 0;
    this.#waiting?.({ done: true }); this.#waiting = undefined;
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#closed) return Promise.resolve({ done: true });
        const first = this.#values.shift();
        if (first) { this.#bytes -= first.bytes; return Promise.resolve({ value: first.value, done: false }); }
        return new Promise(resolve => { this.#waiting = resolve; });
      },
      return: async () => { this.close(); return { done: true }; },
    };
  }
}
