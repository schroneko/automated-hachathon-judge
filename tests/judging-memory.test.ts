import { afterEach, describe, expect, it } from "vitest";
import { MAX_SNAPSHOT_SERIALIZED_BYTES } from "../src/shared/constants";
import { acquireJudgingMemory, JudgingMemoryPool, type JudgingMemoryLease } from "../src/shared/judging-memory";

const MiB = 1024 * 1024;
let leases: JudgingMemoryLease[] = [];

function track(promise: Promise<JudgingMemoryLease>, onAcquired?: () => void): Promise<JudgingMemoryLease> {
  return promise.then((lease) => {
    leases.push(lease);
    onAcquired?.();
    return lease;
  });
}

afterEach(async () => {
  for (let index = 0; index < leases.length; index += 1) {
    leases[index]!.release();
    await Promise.resolve();
  }
  leases = [];
});

describe("judging memory", () => {
  it("reserves 64 MiB immediately and blocks another acquisition against the 96 MiB budget", async () => {
    const pool = new JudgingMemoryPool();
    const firstPromise = track(pool.acquire());
    expect(pool.usedBytes).toBe(64 * MiB);
    expect(pool.pendingCount).toBe(0);

    let secondAcquired = false;
    const secondPromise = track(pool.acquire(), () => { secondAcquired = true; });
    expect(pool.usedBytes).toBe(64 * MiB);
    expect(pool.pendingCount).toBe(1);
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    const first = await firstPromise;
    first.reduceForSnapshot(2 * MiB);
    expect(pool.usedBytes).toBe(96 * MiB);
    expect(pool.pendingCount).toBe(0);
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    first.release();
    expect(pool.usedBytes).toBe(64 * MiB);
    second.release();
    expect(pool.usedBytes).toBe(0);
  });

  it("wakes waiters in FIFO order without letting new arrivals bypass them", async () => {
    const pool = new JudgingMemoryPool();
    const first = await track(pool.acquire());
    const order: number[] = [];
    const secondPromise = track(pool.acquire(), () => { order.push(2); });
    const thirdPromise = track(pool.acquire(), () => { order.push(3); });
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(pool.pendingCount).toBe(2);

    first.release();
    expect(pool.usedBytes).toBe(64 * MiB);
    expect(pool.pendingCount).toBe(1);
    const fourthPromise = track(pool.acquire(), () => { order.push(4); });
    expect(pool.pendingCount).toBe(2);
    const second = await secondPromise;
    expect(order).toEqual([2]);
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual([2, 3]);
    expect(pool.pendingCount).toBe(1);
    third.release();
    const fourth = await fourthPromise;
    expect(order).toEqual([2, 3, 4]);
    expect(pool.pendingCount).toBe(0);
    fourth.release();
    expect(pool.usedBytes).toBe(0);
  });

  it("makes release idempotent and rejects reduction after release without affecting another lease", async () => {
    const pool = new JudgingMemoryPool();
    const first = await track(pool.acquire());
    const secondPromise = track(pool.acquire());
    let thirdAcquired = false;
    const thirdPromise = track(pool.acquire(), () => { thirdAcquired = true; });
    first.release();
    const second = await secondPromise;
    first.release();
    first.release();
    expect(() => first.reduceForSnapshot(1)).toThrow(/released/);
    expect(pool.usedBytes).toBe(64 * MiB);
    expect(pool.pendingCount).toBe(1);
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);
    second.release();
    const third = await thirdPromise;
    third.release();
    third.release();
    expect(pool.usedBytes).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, MAX_SNAPSHOT_SERIALIZED_BYTES + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byte count %s without changing accounting or admitting a waiter",
    async (serializedBytes) => {
      const pool = new JudgingMemoryPool();
      const first = await track(pool.acquire());
      let secondAcquired = false;
      const secondPromise = track(pool.acquire(), () => { secondAcquired = true; });
      expect(() => first.reduceForSnapshot(serializedBytes)).toThrow();
      expect(pool.usedBytes).toBe(64 * MiB);
      expect(pool.pendingCount).toBe(1);
      await Promise.resolve();
      expect(secondAcquired).toBe(false);
      first.release();
      const second = await secondPromise;
      second.release();
      expect(pool.usedBytes).toBe(0);
    }
  );

  it("accepts the exact 4 MiB limit and applies the exact 2 MiB minimum", async () => {
    const pool = new JudgingMemoryPool();
    const lease = await track(pool.acquire());
    expect(MAX_SNAPSHOT_SERIALIZED_BYTES).toBe(4 * MiB);
    lease.reduceForSnapshot(MAX_SNAPSHOT_SERIALIZED_BYTES);
    expect(pool.usedBytes).toBe(64 * MiB);
    lease.reduceForSnapshot(200_001);
    expect(pool.usedBytes).toBe(200_001 * 16);
    lease.reduceForSnapshot(2 * MiB / 16);
    expect(pool.usedBytes).toBe(2 * MiB);
    lease.reduceForSnapshot(1);
    expect(pool.usedBytes).toBe(2 * MiB);
    lease.reduceForSnapshot(2 * MiB / 16);
    expect(pool.usedBytes).toBe(2 * MiB);
    lease.release();
    expect(pool.usedBytes).toBe(0);
  });

  it("rejects increases after reduction without mutating held memory or waking a waiter", async () => {
    const pool = new JudgingMemoryPool();
    const first = await track(pool.acquire());
    first.reduceForSnapshot(3 * MiB);
    let secondAcquired = false;
    const secondPromise = track(pool.acquire(), () => { secondAcquired = true; });
    expect(() => first.reduceForSnapshot(MAX_SNAPSHOT_SERIALIZED_BYTES)).toThrow(/increase/);
    expect(pool.usedBytes).toBe(48 * MiB);
    expect(pool.pendingCount).toBe(1);
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.reduceForSnapshot(2 * MiB);
    const second = await secondPromise;
    expect(pool.usedBytes).toBe(96 * MiB);
    first.reduceForSnapshot(1);
    expect(pool.usedBytes).toBe(66 * MiB);
    expect(() => first.reduceForSnapshot(2 * MiB / 16 + 1)).toThrow(/increase/);
    expect(pool.usedBytes).toBe(66 * MiB);
    first.release();
    second.release();
    expect(pool.usedBytes).toBe(0);
  });

  it("holds eight small model stages simultaneously after sequential source acquisition", async () => {
    const pool = new JudgingMemoryPool();
    const active: JudgingMemoryLease[] = [];
    for (let index = 0; index < 8; index += 1) {
      const lease = await track(pool.acquire());
      expect(pool.usedBytes).toBe(64 * MiB + index * 2 * MiB);
      lease.reduceForSnapshot(1024);
      active.push(lease);
      expect(pool.usedBytes).toBe(active.length * 2 * MiB);
      expect(pool.pendingCount).toBe(0);
    }
    expect(active).toHaveLength(8);
    expect(pool.usedBytes).toBe(16 * MiB);
    for (const lease of active) lease.release();
    expect(pool.usedBytes).toBe(0);
  });

  it("keeps competing maximum snapshots below budget throughout admission and repeated cleanup", async () => {
    const pool = new JudgingMemoryPool();
    const order: number[] = [];
    const promises = Array.from({ length: 8 }, (_, index) => track(pool.acquire(), () => { order.push(index); }));
    expect(pool.usedBytes).toBe(64 * MiB);
    expect(pool.pendingCount).toBe(7);
    for (let index = 0; index < promises.length; index += 1) {
      const lease = await promises[index]!;
      expect(order).toEqual(Array.from({ length: index + 1 }, (_, value) => value));
      expect(pool.usedBytes).toBe(64 * MiB);
      expect(pool.pendingCount).toBe(7 - index);
      lease.reduceForSnapshot(MAX_SNAPSHOT_SERIALIZED_BYTES);
      await Promise.resolve();
      expect(order).toHaveLength(index + 1);
      expect(pool.usedBytes).toBe(64 * MiB);
      lease.release();
      lease.release();
      expect(pool.usedBytes).toBe(index === 7 ? 0 : 64 * MiB);
      expect(pool.usedBytes).toBeLessThanOrEqual(96 * MiB);
      expect(pool.usedBytes).toBeGreaterThanOrEqual(0);
    }
    expect(pool.pendingCount).toBe(0);
  });

  it("uses one production singleton across acquireJudgingMemory calls", async () => {
    const first = await track(acquireJudgingMemory());
    let secondAcquired = false;
    const secondPromise = track(acquireJudgingMemory(), () => { secondAcquired = true; });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.reduceForSnapshot(2 * MiB);
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    first.release();
    second.release();
    const next = await track(acquireJudgingMemory());
    next.release();
  });
});
