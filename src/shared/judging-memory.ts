import { MAX_SNAPSHOT_SERIALIZED_BYTES } from "./constants";

const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
const INITIAL_RESERVATION_BYTES = 64 * 1024 * 1024;
const MIN_RESERVATION_BYTES = 2 * 1024 * 1024;

export interface JudgingMemoryLease {
  reduceForSnapshot(serializedBytes: number): void;
  release(): void;
}

export class JudgingMemoryPool {
  private reservedBytes = 0;
  private readonly waiters: Array<(lease: JudgingMemoryLease) => void> = [];

  get usedBytes(): number {
    return this.reservedBytes;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  acquire(): Promise<JudgingMemoryLease> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.reservedBytes + INITIAL_RESERVATION_BYTES <= MEMORY_BUDGET_BYTES) {
      const resolve = this.waiters.shift()!;
      this.reservedBytes += INITIAL_RESERVATION_BYTES;
      let heldBytes = INITIAL_RESERVATION_BYTES;
      let released = false;

      resolve({
        reduceForSnapshot: (serializedBytes) => {
          if (released) throw new Error("Judging memory lease has been released");
          if (!Number.isSafeInteger(serializedBytes) || serializedBytes < 1 || serializedBytes > MAX_SNAPSHOT_SERIALIZED_BYTES) {
            throw new Error("Invalid snapshot serialized byte count");
          }
          const nextBytes = Math.max(MIN_RESERVATION_BYTES, serializedBytes * 16);
          if (nextBytes > heldBytes) throw new Error("Judging memory reservation cannot increase");
          this.reservedBytes -= heldBytes - nextBytes;
          heldBytes = nextBytes;
          this.drain();
        },
        release: () => {
          if (released) return;
          released = true;
          this.reservedBytes -= heldBytes;
          heldBytes = 0;
          this.drain();
        }
      });
    }
  }
}

const judgingMemoryPool = new JudgingMemoryPool();

export function acquireJudgingMemory(): Promise<JudgingMemoryLease> {
  return judgingMemoryPool.acquire();
}
