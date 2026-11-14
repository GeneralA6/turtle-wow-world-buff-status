/**
 * Detects raid clears from DEPARTURE BURSTS instead of tracking one raid at a time, so any number of
 * raids sharing a lair are each seen to leave.
 *
 * Measured on production snapshots (2026-11-13: 1 day of Blackwing Lair, 7 days of Onyxia): a raid's
 * members arrive interleaved with other raids' (an evening BWL had 6-7 raids arrive within 30 min of
 * each other), but they LEAVE together — a block of ~18-29 players within 2-6 minutes, who don't come
 * back. Wipes look like a departure too, but the run-back returns inside a few minutes (BWL max 7.3m).
 *
 * The rule: when at least `minGroup` players who had each been in the lair for `minStayMs` or more
 * were all last seen within `spanMs` of each other, and every one of them has stayed gone for
 * `sustainedMs`, that block is one cleared raid. Replay against Chronicle kill logs: Onyxia caught
 * 44/49 kills (the single-raid tracker 39/49) with no clear whose leavers came back; BWL found all 11
 * departures with none false.
 *
 * The same per-player stays drive the "about to clear" heads-up: once `minGroup` players still in the
 * lair have each been in for the warning threshold, that block is warned once — no need to know which
 * raid they belong to.
 *
 * Pure: time comes in with each observation, so tests drive it with plain numbers. Its whole state is a
 * plain snapshot, so a restart resumes every stay instead of reading raids in progress as just arrived.
 */
export interface DepartureSettings {
  /** Only a player in the lair at least this long counts toward a clear (a passer-by doesn't). */
  readonly minStayMs: number;
  /** How many such players must leave together for it to be a raid clearing. */
  readonly minGroup: number;
  /** How long they must all stay gone, so a wipe's run-back isn't read as a clear. */
  readonly sustainedMs: number;
}

export interface DepartureDetectorOptions extends DepartureSettings {
  /** The widest gap between the first and last of one departing block. Default 5 min. */
  readonly spanMs?: number;
  /** A departure older than `sustainedMs + lookbackMs` is history, never reported late. Default 15 min. */
  readonly lookbackMs?: number;
}

/** One poll of the lair: who is in it, and whether the /who listed everyone. */
export interface DepartureObservation {
  readonly names: readonly string[];
  /** False when the /who was truncated — absent players may only be unlisted, so nothing is concluded. */
  readonly complete: boolean;
  readonly at: number;
}

/** A block of players that left together: one raid's clear. */
export interface DepartedGroup {
  readonly names: readonly string[];
  readonly size: number;
  /** When the earliest of them came in. */
  readonly enteredAt: number;
  readonly firstLeftAt: number;
  readonly lastLeftAt: number;
  /** The median time its members had been in the lair: the raid's clear duration. */
  readonly medianStayMs: number;
}

/** A block of players still in the lair who have now been in long enough to warn about. */
export interface DueGroup {
  readonly names: readonly string[];
  readonly size: number;
  readonly medianStayMs: number;
}

/** A block that has left but not yet stayed gone the whole wait — for a Chronicle kill to confirm early. */
export interface PendingGroup {
  readonly names: readonly string[];
  /** When the earliest of them came in. */
  readonly enteredAt: number;
}

/** One player's stay, as persisted. */
export interface PersistedStay {
  readonly name: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

/** The detector's whole state, persisted so a restart resumes every stay. */
export interface DepartureState {
  readonly stays: readonly PersistedStay[];
  /** Already counted in a clear this stay. */
  readonly departed: readonly string[];
  /** Already covered by a heads-up this stay. */
  readonly warned: readonly string[];
  /** Who the last poll listed. */
  readonly present: readonly string[];
}

const DEFAULT_SPAN_MS = 5 * 60_000;
const DEFAULT_LOOKBACK_MS = 15 * 60_000;
/** An absence longer than a corpse run starts a new stay; never shorter than this. */
const MIN_STINT_GAP_MS = 8 * 60_000;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

interface Stay {
  firstSeen: number;
  lastSeen: number;
}

interface Candidate {
  readonly name: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly stayMs: number;
}

export class DepartureDetector {
  readonly #minStayMs: number;
  readonly #minGroup: number;
  readonly #sustainedMs: number;
  readonly #spanMs: number;
  readonly #lookbackMs: number;
  readonly #stintGapMs: number;
  /** Each player's current stay in the lair; pruned once it can no longer matter. */
  readonly #stays = new Map<string, Stay>();
  /** Players already counted in a clear during their current stay. */
  readonly #departed = new Set<string>();
  /** Players already covered by a heads-up during their current stay. */
  readonly #warned = new Set<string>();
  #present = new Set<string>();

  constructor(options: DepartureDetectorOptions) {
    this.#minStayMs = options.minStayMs;
    this.#minGroup = options.minGroup;
    this.#sustainedMs = options.sustainedMs;
    this.#spanMs = options.spanMs ?? DEFAULT_SPAN_MS;
    this.#lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    // Longer than the wait, so a player gone for the whole wait is still on the same stay when judged.
    this.#stintGapMs = Math.max(MIN_STINT_GAP_MS, options.sustainedMs + 60_000);
  }

  /** Feeds one poll; returns every raid that has now cleared (usually none, sometimes several). */
  observe(observation: DepartureObservation): DepartedGroup[] {
    const { names, complete, at } = observation;
    for (const name of names) {
      const stay = this.#stays.get(name);
      if (stay === undefined || at - stay.lastSeen > this.#stintGapMs) {
        this.#stays.set(name, { firstSeen: at, lastSeen: at });
        this.#departed.delete(name);
        this.#warned.delete(name);
      } else {
        stay.lastSeen = at;
      }
    }
    this.#present = new Set(names);
    this.#prune(at);
    return complete ? this.#takeDepartures(at) : [];
  }

  /**
   * The heads-up check: if at least `minGroup` players still in the lair (as of the last poll) have
   * each been in for `thresholdMs` and weren't warned about yet, marks them warned and returns them.
   */
  dueForWarning(at: number, thresholdMs: number): DueGroup | null {
    const stays: number[] = [];
    const names: string[] = [];
    for (const name of this.#present) {
      const stay = this.#stays.get(name);
      if (stay === undefined || this.#warned.has(name)) continue;
      const stayedMs = at - stay.firstSeen;
      if (stayedMs >= thresholdMs) {
        stays.push(stayedMs);
        names.push(name);
      }
    }
    if (names.length < this.#minGroup) return null;
    for (const name of names) this.#warned.add(name);
    return { names, size: names.length, medianStayMs: median(stays) };
  }

  /**
   * A block that left (missing from the last poll) but hasn't yet stayed gone the whole wait, or null —
   * so a Chronicle kill by one of them can confirm the clear early with {@link confirmNow}.
   */
  pending(at: number): PendingGroup | null {
    const block = this.#densestBlock(this.#candidates(at, 1, this.#sustainedMs));
    if (block.length < this.#minGroup) return null;
    return { names: block.map((member) => member.name), enteredAt: Math.min(...block.map((member) => member.firstSeen)) };
  }

  /** Confirms the pending block as a clear now (a kill proved it), or null if none is pending. */
  confirmNow(at: number): DepartedGroup | null {
    const block = this.#densestBlock(this.#candidates(at, 1, this.#sustainedMs));
    return block.length < this.#minGroup ? null : this.#depart(block);
  }

  /**
   * After a blind gap (a realm crash, a lost connection) whoever is missing may only be slow to come
   * back, all "gone" at the same moment — a burst that isn't a clear. Writes them off without reporting
   * them and returns how many. A raid that really left during the gap goes unreported.
   */
  rebaseline(): number {
    let count = 0;
    for (const name of this.#stays.keys()) {
      if (this.#present.has(name) || this.#departed.has(name)) continue;
      this.#departed.add(name);
      count += 1;
    }
    return count;
  }

  /** The whole state, to persist. */
  snapshot(): DepartureState {
    return {
      stays: [...this.#stays].map(([name, stay]) => ({ name, firstSeen: stay.firstSeen, lastSeen: stay.lastSeen })),
      departed: [...this.#departed],
      warned: [...this.#warned],
      present: [...this.#present],
    };
  }

  /** Resumes a persisted state, replacing whatever is held. */
  restore(state: DepartureState): void {
    this.#stays.clear();
    for (const stay of state.stays) this.#stays.set(stay.name, { firstSeen: stay.firstSeen, lastSeen: stay.lastSeen });
    this.#departed.clear();
    for (const name of state.departed) this.#departed.add(name);
    this.#warned.clear();
    for (const name of state.warned) this.#warned.add(name);
    this.#present = new Set(state.present);
  }

  #takeDepartures(at: number): DepartedGroup[] {
    const candidates = this.#candidates(at, this.#sustainedMs, this.#sustainedMs + this.#lookbackMs);
    const groups: DepartedGroup[] = [];
    for (;;) {
      const block = this.#densestBlock(candidates);
      if (block.length < this.#minGroup) return groups;
      for (const member of block) candidates.splice(candidates.indexOf(member), 1);
      groups.push(this.#depart(block));
    }
  }

  /** Long-enough stays not yet counted, gone at least `goneFromMs` and under `goneToMs`, by last seen. */
  #candidates(at: number, goneFromMs: number, goneToMs: number): Candidate[] {
    const candidates: Candidate[] = [];
    for (const [name, stay] of this.#stays) {
      if (this.#departed.has(name)) continue;
      const goneMs = at - stay.lastSeen;
      const stayMs = stay.lastSeen - stay.firstSeen;
      if (goneMs >= goneFromMs && goneMs < goneToMs && stayMs >= this.#minStayMs) {
        candidates.push({ name, firstSeen: stay.firstSeen, lastSeen: stay.lastSeen, stayMs });
      }
    }
    return candidates.sort((a, b) => a.lastSeen - b.lastSeen);
  }

  /** Counts a block as cleared and describes it. */
  #depart(block: readonly Candidate[]): DepartedGroup {
    for (const member of block) this.#departed.add(member.name);
    return {
      names: block.map((member) => member.name),
      size: block.length,
      enteredAt: Math.min(...block.map((member) => member.firstSeen)),
      firstLeftAt: block[0]!.lastSeen,
      lastLeftAt: block[block.length - 1]!.lastSeen,
      medianStayMs: median(block.map((member) => member.stayMs)),
    };
  }

  /** The largest run of candidates (sorted by last seen) all within `spanMs` of each other. */
  #densestBlock(sorted: readonly Candidate[]): Candidate[] {
    let best: Candidate[] = [];
    for (let start = 0, end = 0; end < sorted.length; end += 1) {
      while (sorted[end]!.lastSeen - sorted[start]!.lastSeen > this.#spanMs) start += 1;
      if (end - start + 1 > best.length) best = sorted.slice(start, end + 1);
    }
    return best;
  }

  /** Forgets players gone so long they can neither be reported nor continue their stay. */
  #prune(at: number): void {
    const keepMs = Math.max(this.#stintGapMs, this.#sustainedMs + this.#lookbackMs);
    for (const [name, stay] of this.#stays) {
      if (at - stay.lastSeen > keepMs) {
        this.#stays.delete(name);
        this.#departed.delete(name);
        this.#warned.delete(name);
      }
    }
  }
}
