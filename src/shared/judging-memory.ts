import { MAX_SNAPSHOT_SERIALIZED_BYTES } from "./constants";

const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
const INITIAL_RESERVATION_BYTES = 64 * 1024 * 1024;
const MIN_RESERVATION_BYTES = 2 * 1024 * 1024;
const ACQUISITION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 25;

export interface JudgingMemoryLease {
  reduceForSnapshot(serializedBytes: number): void;
  release(): void;
}

export class JudgingMemoryPool {
  private reservedBytes = 0;
  private nextTicket = 0;
  private readonly waiters: number[] = [];
  private readonly deadlines = new Map<number, number>();

  get usedBytes(): number {
    return this.reservedBytes;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  tryAcquire(): JudgingMemoryLease | null {
    this.pruneExpiredTickets(Date.now());
    if (this.waiters.length > 0 || this.reservedBytes + INITIAL_RESERVATION_BYTES > MEMORY_BUDGET_BYTES) return null;
    return this.createLease();
  }

  async acquire(): Promise<JudgingMemoryLease> {
    const ticket = this.nextTicket++;
    const deadline = Date.now() + ACQUISITION_TIMEOUT_MS;
    this.waiters.push(ticket);
    this.deadlines.set(ticket, deadline);
    try {
      while (true) {
        const now = Date.now();
        this.pruneExpiredTickets(now);
        if (now >= deadline) throw new Error("Judging memory acquisition timed out");
        if (this.waiters[0] === ticket && this.reservedBytes + INITIAL_RESERVATION_BYTES <= MEMORY_BUDGET_BYTES) {
          this.removeTicket(ticket);
          return this.createLease();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, deadline - now)));
      }
    } finally {
      this.removeTicket(ticket);
    }
  }

  private removeTicket(ticket: number): void {
    const index = this.waiters.indexOf(ticket);
    if (index !== -1) this.waiters.splice(index, 1);
    this.deadlines.delete(ticket);
  }

  private pruneExpiredTickets(now: number): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const ticket = this.waiters[index]!;
      if (this.deadlines.get(ticket)! <= now) this.removeTicket(ticket);
    }
  }

  private createLease(): JudgingMemoryLease {
    this.reservedBytes += INITIAL_RESERVATION_BYTES;
    let heldBytes = INITIAL_RESERVATION_BYTES;
    let released = false;

    return {
      reduceForSnapshot: (serializedBytes) => {
        if (released) throw new Error("Judging memory lease has been released");
        if (!Number.isSafeInteger(serializedBytes) || serializedBytes < 1 || serializedBytes > MAX_SNAPSHOT_SERIALIZED_BYTES) {
          throw new Error("Invalid snapshot serialized byte count");
        }
        const nextBytes = Math.max(MIN_RESERVATION_BYTES, serializedBytes * 16);
        if (nextBytes > heldBytes) throw new Error("Judging memory reservation cannot increase");
        this.reservedBytes -= heldBytes - nextBytes;
        heldBytes = nextBytes;
      },
      release: () => {
        if (released) return;
        released = true;
        this.reservedBytes -= heldBytes;
        heldBytes = 0;
      }
    };
  }
}

const judgingMemoryPool = new JudgingMemoryPool();

export function acquireJudgingMemory(): Promise<JudgingMemoryLease> {
  return judgingMemoryPool.acquire();
}

export function tryAcquireJudgingMemory(): JudgingMemoryLease | null {
  return judgingMemoryPool.tryAcquire();
}
