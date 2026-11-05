// Per-key mutual exclusion inside the single instance. Replaces the former global chain: work on
// bounty A no longer waits for a slow provider call made for bounty B.
import { metrics } from "./metrics.ts";

export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();
  /** Run `work` after every earlier holder of `key`; keys are independent. */
  run<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const queuedAt = Date.now();
    const next = previous.catch(() => {}).then(() => {
      metrics.observe("lock_wait_ms", Date.now() - queuedAt);
      return work();
    });
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
  /** Hold several keys at once, acquired in a stable order to avoid deadlock. */
  runAll<T>(keys: string[], work: () => Promise<T> | T): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const step = (i: number): Promise<T> => (i === sorted.length ? Promise.resolve().then(work) : this.run(sorted[i]!, () => step(i + 1)));
    return step(0);
  }
  held(key: string) {
    return this.tails.has(key);
  }
  get size() {
    return this.tails.size;
  }
}

/** Bounded parallelism for worker batches. */
export async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  });
  await Promise.all(workers);
}
