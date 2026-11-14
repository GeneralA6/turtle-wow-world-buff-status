import { describe, expect, it } from "vitest";
import { DepartureDetector, type DepartedGroup } from "./departure-detector.js";

const MIN = 60_000;
const raid = (prefix: string, size: number): string[] => Array.from({ length: size }, (_, i) => `${prefix}${i}`);

/** Polls once a minute from `fromMin` to `toMin` (inclusive), with whoever `roster(minute)` returns. */
function poll(
  detector: DepartureDetector,
  fromMin: number,
  toMin: number,
  roster: (minute: number) => readonly string[],
  complete: (minute: number) => boolean = () => true,
): { minute: number; group: DepartedGroup }[] {
  const out: { minute: number; group: DepartedGroup }[] = [];
  for (let minute = fromMin; minute <= toMin; minute += 1) {
    for (const group of detector.observe({ names: roster(minute), complete: complete(minute), at: minute * MIN })) {
      out.push({ minute, group });
    }
  }
  return out;
}

const onyxia = () => new DepartureDetector({ minStayMs: 10 * MIN, minGroup: 15, sustainedMs: 5 * MIN });

describe("DepartureDetector", () => {
  it("reports a raid that stayed and left together once it has been gone the sustained wait", () => {
    const a = raid("a", 20);
    const clears = poll(onyxia(), 0, 60, (m) => (m < 30 ? a : []));
    expect(clears).toHaveLength(1);
    expect(clears[0]!.minute).toBe(34); // last seen at 29, gone 5 min
    expect(clears[0]!.group).toEqual({ names: a, size: 20, enteredAt: 0, firstLeftAt: 29 * MIN, lastLeftAt: 29 * MIN, medianStayMs: 29 * MIN });
  });

  it("does not report a wipe whose players run back inside the wait", () => {
    const a = raid("a", 20);
    const clears = poll(onyxia(), 0, 30, (m) => (m >= 15 && m < 18 ? [] : a));
    expect(clears).toEqual([]);
  });

  it("keeps the stay running across a short absence, so the duration covers the whole raid", () => {
    const a = raid("a", 20);
    const clears = poll(onyxia(), 0, 60, (m) => (m < 40 && !(m >= 15 && m < 18) ? a : []));
    expect(clears).toHaveLength(1);
    expect(clears[0]!.group.medianStayMs).toBe(39 * MIN);
  });

  it("separates two overlapping raids by when each leaves", () => {
    const a = raid("a", 20);
    const b = raid("b", 18);
    const clears = poll(onyxia(), 0, 90, (m) => [...(m < 30 ? a : []), ...(m >= 10 && m < 55 ? b : [])]);
    expect(clears.map((c) => [c.minute, c.group.size])).toEqual([
      [34, 20],
      [59, 18],
    ]);
  });

  it("reports two raids leaving in the same poll window as two clears when they left minutes apart", () => {
    const a = raid("a", 20);
    const b = raid("b", 20);
    // a leaves at 30, b at 37: both still within the lookback when judged at 42.
    const clears = poll(onyxia(), 0, 60, (m) => [...(m < 30 ? a : []), ...(m < 37 ? b : [])], (m) => m < 34 || m >= 42);
    expect(clears.map((c) => c.group.size)).toEqual([20, 20]);
    expect(clears.every((c) => c.minute === 42)).toBe(true);
  });

  it("ignores players who left together but had only passed through", () => {
    const a = raid("a", 20);
    const clears = poll(onyxia(), 0, 30, (m) => (m >= 5 && m < 12 ? a : []));
    expect(clears).toEqual([]);
  });

  it("ignores a departure smaller than the minimum group", () => {
    const a = raid("a", 14);
    expect(poll(onyxia(), 0, 60, (m) => (m < 30 ? a : []))).toEqual([]);
  });

  it("does not count players who trickle out over more than the span as one raid", () => {
    const a = raid("a", 20);
    // one player leaves every minute from 20 to 39: no 5-minute window holds 15 of them.
    const clears = poll(onyxia(), 0, 70, (m) => a.filter((_, i) => m < 20 + i));
    expect(clears).toEqual([]);
  });

  it("concludes nothing from an incomplete /who, and reports once a complete one confirms it", () => {
    const a = raid("a", 20);
    const clears = poll(onyxia(), 0, 60, (m) => (m < 30 ? a : []), (m) => m < 30 || m >= 37);
    expect(clears.map((c) => c.minute)).toEqual([37]);
  });

  it("never reports a departure whose news is older than the lookback", () => {
    const a = raid("a", 20);
    // Every /who after the departure is truncated until 30 min later.
    const clears = poll(onyxia(), 0, 80, (m) => (m < 30 ? a : []), (m) => m < 30 || m >= 60);
    expect(clears).toEqual([]);
  });

  it("reports the same players again on a later, separate stay", () => {
    const a = raid("a", 20);
    const clears = poll(onyxia(), 0, 150, (m) => (m < 30 || (m >= 60 && m < 100) ? a : []));
    expect(clears.map((c) => c.minute)).toEqual([34, 104]);
  });

  it("reports a raid only once while its members stay gone", () => {
    const a = raid("a", 20);
    expect(poll(onyxia(), 0, 120, (m) => (m < 30 ? a : []))).toHaveLength(1);
  });

  describe("dueForWarning", () => {
    it("warns once when enough present players have stayed past the threshold", () => {
      const detector = onyxia();
      const a = raid("a", 20);
      poll(detector, 0, 19, () => a);
      expect(detector.dueForWarning(19 * MIN, 20 * MIN)).toBeNull();
      poll(detector, 20, 20, () => a);
      expect(detector.dueForWarning(20 * MIN, 20 * MIN)).toEqual({ names: a, size: 20, medianStayMs: 20 * MIN });
      poll(detector, 21, 21, () => a);
      expect(detector.dueForWarning(21 * MIN, 20 * MIN)).toBeNull();
    });

    it("warns a second raid separately once it too is due", () => {
      const detector = onyxia();
      const a = raid("a", 20);
      const b = raid("b", 16);
      const roster = (m: number) => [...a, ...(m >= 10 ? b : [])];
      poll(detector, 0, 20, roster);
      expect(detector.dueForWarning(20 * MIN, 20 * MIN)?.size).toBe(20);
      poll(detector, 21, 30, roster);
      expect(detector.dueForWarning(30 * MIN, 20 * MIN)?.size).toBe(16);
    });

    it("ignores players no longer present", () => {
      const detector = onyxia();
      const a = raid("a", 20);
      poll(detector, 0, 25, (m) => (m < 25 ? a : []));
      expect(detector.dueForWarning(25 * MIN, 20 * MIN)).toBeNull();
    });
  });

  describe("pending and confirmNow", () => {
    it("shows a block that just left, before the wait is over", () => {
      const detector = onyxia();
      const a = raid("a", 20);
      poll(detector, 0, 29, () => [...a, "solo"]);
      expect(detector.pending(29 * MIN)).toBeNull(); // still in
      poll(detector, 30, 31, () => ["solo"]);
      expect(detector.pending(31 * MIN)).toEqual({ names: a, enteredAt: 0 });
    });

    it("confirms the pending block at once and never reports it again", () => {
      const detector = onyxia();
      const a = raid("a", 20);
      poll(detector, 0, 31, (m) => (m < 30 ? a : []));
      expect(detector.confirmNow(31 * MIN)).toMatchObject({ names: a, size: 20, medianStayMs: 29 * MIN });
      expect(detector.pending(31 * MIN)).toBeNull();
      expect(poll(detector, 32, 60, () => [])).toEqual([]);
    });

    it("has nothing to confirm when nobody left", () => {
      const detector = onyxia();
      poll(detector, 0, 30, () => raid("a", 20));
      expect(detector.confirmNow(30 * MIN)).toBeNull();
    });
  });

  describe("rebaseline", () => {
    it("writes off whoever is missing after a blind gap, so their absence isn't read as a clear", () => {
      const detector = onyxia();
      const a = raid("a", 20);
      const b = raid("b", 20);
      poll(detector, 0, 29, () => [...a, ...b]);
      // After the gap only b is listed; a may just be slow to log back in.
      poll(detector, 30, 30, () => b);
      expect(detector.rebaseline()).toBe(20);
      expect(poll(detector, 31, 60, () => b)).toEqual([]);
    });
  });

  describe("snapshot and restore", () => {
    it("resumes every stay, so a raid in progress keeps its full duration across a restart", () => {
      const before = onyxia();
      const a = raid("a", 20);
      poll(before, 0, 20, () => a);
      const after = onyxia();
      after.restore(JSON.parse(JSON.stringify(before.snapshot())));
      const clears = poll(after, 21, 40, (m) => (m < 30 ? a : []));
      expect(clears.map((c) => [c.minute, c.group.medianStayMs])).toEqual([[34, 29 * MIN]]);
    });

    it("keeps who was already reported and warned", () => {
      const before = onyxia();
      const a = raid("a", 20);
      poll(before, 0, 20, () => a);
      expect(before.dueForWarning(20 * MIN, 20 * MIN)).not.toBeNull();
      const after = onyxia();
      after.restore(before.snapshot());
      expect(after.dueForWarning(20 * MIN, 20 * MIN)).toBeNull();
    });
  });
});
