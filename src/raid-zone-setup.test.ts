import { describe, expect, it } from "vitest";
import { loadConfig, onyxiaWatch } from "./config.js";
import { buildLanes, lairStatus, laneLabel, RAID_ZONE_STORE_NAMES, trackerOptions } from "./raid-zone-setup.js";
import { BLACKWING_LAIR } from "./watcher/raid-zone.js";
import type { WhoPlayer } from "./protocol/who.js";

const env = { WOW_ACCOUNT: "a", WOW_PASSWORD: "p", WOW_CHARACTER: "C" } satisfies NodeJS.ProcessEnv;

function player(name: string): WhoPlayer {
  return { name, guild: "", level: 60, classId: 1, raceId: 1, areaId: 2677 };
}

describe("laneLabel", () => {
  it("keeps Onyxia's original labels, so a raid in progress at deploy resumes", () => {
    expect(laneLabel("onyxia", "lair")).toBe("lair");
    expect(laneLabel("onyxia", "alliance")).toBe("alliance");
    expect(laneLabel("onyxia", "horde")).toBe("horde");
  });

  it("names Blackwing Lair's lanes apart", () => {
    expect(laneLabel("bwl", "lair")).toBe("bwl");
    expect(laneLabel("bwl", "alliance")).toBe("bwl-alliance");
    expect(laneLabel("bwl", "horde")).toBe("bwl-horde");
  });
});

describe("RAID_ZONE_STORE_NAMES", () => {
  it("leaves Onyxia's collections as they were and gives BWL its own", () => {
    expect(RAID_ZONE_STORE_NAMES.onyxia).toEqual({
      counterId: "raid",
      broadcasts: "broadcasts",
      durations: "raiddurations",
      snapshots: "snapshots",
    });
    const bwl = Object.values(RAID_ZONE_STORE_NAMES.bwl);
    for (const name of Object.values(RAID_ZONE_STORE_NAMES.onyxia)) expect(bwl).not.toContain(name);
  });
});

describe("trackerOptions", () => {
  it("reads every size and time off the lair's watch", () => {
    const config = loadConfig(env);
    const bwl = config.blackwingLair;
    if (!bwl) throw new Error("BWL is on by default");
    const next = (): number => 1;
    expect(trackerOptions(bwl, "auto", next)).toEqual({
      minRaidSize: 20,
      grouping: "auto",
      clearSize: 6,
      strengthSize: 20,
      leftFloor: 20,
      clearSustainedMs: 5 * 60_000,
      formConfirmMs: 0,
      fillWindowMs: 15 * 60_000,
      rosterCap: 45,
      lockoutMs: 4 * 3_600_000,
      nextRaidNumber: next,
    });
    expect(trackerOptions(onyxiaWatch(config), "auto", next).minRaidSize).toBe(config.minRaidSize);
  });
});

describe("buildLanes", () => {
  const watch = onyxiaWatch(loadConfig(env));
  const options = trackerOptions(watch, "auto", () => 1);

  it("watches the whole lair for both cities on a crossfaction realm", () => {
    const [lane, ...rest] = buildLanes("bwl", "crossfaction", options, watch.departure);
    expect(rest).toHaveLength(0);
    expect(lane?.label).toBe("bwl");
    expect(lane?.cities).toEqual(["alliance", "horde"]);
    const split = { alliance: [player("A")], horde: [player("H")], unknown: [player("U")] };
    expect(lane?.players(split).map((p) => p.name)).toEqual(["A", "H", "U"]);
  });

  it("watches each side apart on a faction realm", () => {
    const lanes = buildLanes("bwl", "faction", options, watch.departure);
    expect(lanes.map((l) => [l.label, l.cities])).toEqual([
      ["bwl-alliance", ["alliance"]],
      ["bwl-horde", ["horde"]],
    ]);
    const split = { alliance: [player("A")], horde: [player("H")], unknown: [] };
    expect(lanes[1]?.players(split).map((p) => p.name)).toEqual(["H"]);
  });

  it("gives each lane its own departure detector, numbered from the lair's counter", () => {
    let counter = 40;
    const lanes = buildLanes("bwl", "faction", trackerOptions(watch, "auto", () => ++counter), watch.departure);
    const [alliance, horde] = lanes;
    if (!alliance || !horde) throw new Error("two lanes");
    expect(alliance.departures).not.toBe(horde.departures);
    const names = Array.from({ length: 20 }, (_, i) => `A${i}`);
    for (let m = 0; m <= 40; m += 1) {
      const clears = alliance.departures.observe({ names: m < 30 ? names : [], complete: true, at: m * 60_000 });
      if (clears.length > 0) expect(clears.map((c) => c.number)).toEqual([41]);
    }
    expect(counter).toBe(41);
  });
});

describe("lairStatus", () => {
  it("reads no raid off an empty lair, under the lair's own name", () => {
    const config = loadConfig(env);
    const bwl = config.blackwingLair;
    if (!bwl) throw new Error("BWL is on by default");
    const lanes = buildLanes("bwl", "crossfaction", trackerOptions(bwl, "auto", () => 1), bwl.departure);
    expect(lairStatus(BLACKWING_LAIR, lanes, 0)).toEqual({ raidName: "BWL", raids: [], elapsedMs: null, number: null });
  });

  it("reads the raid in progress's number and time in", () => {
    const config = loadConfig(env);
    const bwl = config.blackwingLair;
    if (!bwl) throw new Error("BWL is on by default");
    const lanes = buildLanes("bwl", "crossfaction", trackerOptions(bwl, "auto", () => 7), bwl.departure);
    const present = Array.from({ length: 25 }, (_, i) => player(`Dawn${i}`));
    lanes[0]?.watch.observe({ present, complete: true, at: 0 });

    const status = lairStatus(BLACKWING_LAIR, lanes, 12 * 60_000);
    expect(status.number).toBe(7);
    expect(status.elapsedMs).toBe(12 * 60_000);
    expect(status.raids).toHaveLength(1);
  });
});
