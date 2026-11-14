import { describe, expect, it, vi } from "vitest";
import {
  InMemoryDepartureStateStore,
  MongoDepartureStateStore,
  type DepartureStateDb,
} from "./departure-state-store.js";
import type { DepartureRaidsState } from "./departure-raids.js";

const state = (number: number): DepartureRaidsState => ({
  detector: { stays: [{ name: "a0", firstSeen: 0, lastSeen: 60_000 }], departed: [], warned: ["a0"], present: ["a0"] },
  numbers: [{ name: "a0", number }],
  clearedNumbers: [],
  warnedNumbers: [number],
});

describe("InMemoryDepartureStateStore", () => {
  it("round-trips each lane's state separately", async () => {
    const store = new InMemoryDepartureStateStore();
    expect(await store.load("lair")).toBeNull();
    await store.save("lair", state(7));
    await store.save("bwl", state(3));
    expect((await store.load("lair"))?.numbers).toEqual([{ name: "a0", number: 7 }]);
    expect((await store.load("bwl"))?.numbers).toEqual([{ name: "a0", number: 3 }]);
  });
});

describe("MongoDepartureStateStore", () => {
  function fakeDb(): DepartureStateDb {
    const docs = new Map<string, DepartureRaidsState>();
    return {
      get: vi.fn(async (lane: string) => docs.get(lane) ?? null),
      set: vi.fn(async (lane: string, s: DepartureRaidsState) => {
        docs.set(lane, s);
      }),
      close: vi.fn(async () => {}),
    };
  }

  it("saves a lane's state and reads it back", async () => {
    const db = fakeDb();
    const store = new MongoDepartureStateStore(db);
    await store.save("lair", state(835));
    expect(db.set).toHaveBeenCalledWith("lair", state(835));
    expect(await store.load("lair")).toEqual(state(835));
    expect(await store.load("bwl")).toBeNull();
  });

  it("closes the underlying connection", async () => {
    const db = fakeDb();
    await new MongoDepartureStateStore(db).close();
    expect(db.close).toHaveBeenCalled();
  });
});
