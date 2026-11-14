import type { Db } from "mongodb";
import { releaseSharedClient } from "../mongo-connection.js";
import type { DepartureRaidsState } from "./departure-raids.js";

/**
 * Persists each lane's departure detector (every player's stay, the raid numbers they carry, and
 * which numbers were already announced), so a restart mid-raid resumes the raid's full duration and
 * its dedup instead of reading everyone in the lair as just arrived. One doc per lane, saved each poll.
 */
export interface DepartureStateStore {
  load(lane: string): Promise<DepartureRaidsState | null>;
  save(lane: string, state: DepartureRaidsState): Promise<void>;
  close(): Promise<void>;
}

/** In-memory store, for when Mongo isn't configured (no resume across restarts). */
export class InMemoryDepartureStateStore implements DepartureStateStore {
  readonly #byLane = new Map<string, DepartureRaidsState>();

  async load(lane: string): Promise<DepartureRaidsState | null> {
    return this.#byLane.get(lane) ?? null;
  }

  async save(lane: string, state: DepartureRaidsState): Promise<void> {
    this.#byLane.set(lane, state);
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

interface DepartureStateDoc {
  readonly _id: string;
  readonly state: DepartureRaidsState;
}

/** Narrow port over the Mongo collection, so the store's logic is unit-tested with a fake. */
export interface DepartureStateDb {
  get(lane: string): Promise<DepartureRaidsState | null>;
  set(lane: string, state: DepartureRaidsState): Promise<void>;
  close(): Promise<void>;
}

const COLLECTION = "departurestate";

export class MongoDepartureStateStore implements DepartureStateStore {
  readonly #db: DepartureStateDb;

  constructor(db: DepartureStateDb) {
    this.#db = db;
  }

  static async open(database: Db): Promise<MongoDepartureStateStore> {
    const collection = database.collection<DepartureStateDoc>(COLLECTION);
    return new MongoDepartureStateStore({
      get: (lane) => collection.findOne({ _id: lane }).then((doc) => doc?.state ?? null),
      set: (lane, state) =>
        collection.updateOne({ _id: lane }, { $set: { state } }, { upsert: true }).then(() => undefined),
      close: releaseSharedClient,
    });
  }

  async load(lane: string): Promise<DepartureRaidsState | null> {
    return this.#db.get(lane);
  }

  async save(lane: string, state: DepartureRaidsState): Promise<void> {
    await this.#db.set(lane, state);
  }

  async close(): Promise<void> {
    await this.#db.close();
  }
}
