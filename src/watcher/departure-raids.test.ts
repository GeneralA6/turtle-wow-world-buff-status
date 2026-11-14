import { describe, expect, it, vi } from "vitest";
import { DepartureRaids, type NumberedClear } from "./departure-raids.js";

const MIN = 60_000;
const raid = (prefix: string, size: number): string[] => Array.from({ length: size }, (_, i) => `${prefix}${i}`);
const settings = { minStayMs: 10 * MIN, minGroup: 15, sustainedMs: 5 * MIN };

function counter(start: number): () => number {
  let n = start;
  return vi.fn(() => ++n);
}

function poll(raids: DepartureRaids, fromMin: number, toMin: number, roster: (m: number) => readonly string[]): NumberedClear[] {
  const out: NumberedClear[] = [];
  for (let m = fromMin; m <= toMin; m += 1) out.push(...raids.observe({ names: roster(m), complete: true, at: m * MIN }));
  return out;
}

describe("DepartureRaids", () => {
  it("numbers a clear from the counter when nothing named it", () => {
    const raids = new DepartureRaids({ settings, nextRaidNumber: counter(834) });
    const a = raid("a", 20);
    const clears = poll(raids, 0, 40, (m) => (m < 30 ? a : []));
    expect(clears).toEqual([{ number: 835, names: a, size: 20, durationMs: 29 * MIN }]);
  });

  it("gives the heads-up and the clear the same number", () => {
    const next = counter(10);
    const raids = new DepartureRaids({ settings, nextRaidNumber: next });
    const a = raid("a", 20);
    poll(raids, 0, 20, () => a);
    expect(raids.dueForWarning(20 * MIN, 20 * MIN)).toEqual({ number: 11, size: 20, elapsedMs: 20 * MIN });
    const clears = poll(raids, 21, 40, (m) => (m < 30 ? a : []));
    expect(clears.map((c) => c.number)).toEqual([11]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps the number the forming tracker gave its raid", () => {
    const next = counter(0);
    const raids = new DepartureRaids({ settings, nextRaidNumber: next });
    const a = raid("a", 20);
    poll(raids, 0, 5, () => a);
    raids.claim(a, 835);
    const clears = poll(raids, 6, 40, (m) => (m < 30 ? a : []));
    expect(clears.map((c) => c.number)).toEqual([835]);
    expect(next).not.toHaveBeenCalled();
  });

  it("gives two raids the tracker merged under one number their own clears", () => {
    const raids = new DepartureRaids({ settings, nextRaidNumber: counter(900) });
    const a = raid("a", 20);
    const b = raid("b", 20);
    poll(raids, 0, 5, () => [...a, ...b]);
    raids.claim([...a, ...b], 835);
    const clears = poll(raids, 6, 70, (m) => [...(m < 30 ? a : []), ...(m < 50 ? b : [])]);
    expect(clears.map((c) => c.number)).toEqual([835, 901]);
  });

  it("doesn't lend a number to players it no longer holds", () => {
    const raids = new DepartureRaids({ settings, nextRaidNumber: counter(0) });
    raids.claim(raid("a", 20), 835);
    const a = raid("a", 20);
    const clears = poll(raids, 0, 40, (m) => (m < 30 ? a : []));
    expect(clears.map((c) => c.number)).toEqual([1]);
  });

  it("numbers a Chronicle-confirmed clear like any other", () => {
    const raids = new DepartureRaids({ settings, nextRaidNumber: counter(0) });
    const a = raid("a", 20);
    poll(raids, 0, 5, () => a);
    raids.claim(a, 7);
    poll(raids, 6, 31, (m) => (m < 30 ? a : []));
    expect(raids.pending(31 * MIN)?.names).toEqual(a);
    expect(raids.confirmNow(31 * MIN)).toMatchObject({ number: 7, size: 20 });
    expect(poll(raids, 32, 60, () => [])).toEqual([]);
  });

  it("resumes stays, numbers and dedup across a restart", () => {
    const before = new DepartureRaids({ settings, nextRaidNumber: counter(10) });
    const a = raid("a", 20);
    poll(before, 0, 20, () => a);
    expect(before.dueForWarning(20 * MIN, 20 * MIN)?.number).toBe(11);
    const next = counter(50);
    const after = new DepartureRaids({ settings, nextRaidNumber: next });
    after.restore(JSON.parse(JSON.stringify(before.snapshot())));
    expect(after.dueForWarning(21 * MIN, 20 * MIN)).toBeNull();
    const clears = poll(after, 21, 40, (m) => (m < 30 ? a : []));
    expect(clears).toEqual([{ number: 11, names: a, size: 20, durationMs: 29 * MIN }]);
    expect(next).not.toHaveBeenCalled();
  });

  it("re-baselines through to the detector", () => {
    const raids = new DepartureRaids({ settings, nextRaidNumber: counter(0) });
    poll(raids, 0, 29, () => raid("a", 20));
    poll(raids, 30, 30, () => []);
    expect(raids.rebaseline()).toBe(20);
    expect(poll(raids, 31, 60, () => [])).toEqual([]);
  });
});
