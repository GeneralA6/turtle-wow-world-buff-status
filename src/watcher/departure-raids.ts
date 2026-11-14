import {
  DepartureDetector,
  type DepartedGroup,
  type DepartureObservation,
  type DepartureSettings,
  type DepartureState,
  type PendingGroup,
} from "./departure-detector.js";

/**
 * Numbers the departure detector's raids, so a clear and its heads-up name the same raid and dedup
 * once per raid in the alert ledger.
 *
 * A raid's number is remembered per player. A raid the forming tracker numbered lends its number to
 * its members ({@link claim}), so "raid #835 forming" ends as "raid #835 cleared". A block with no
 * number yet takes the majority number among its members, or a fresh one from the lair's counter.
 * A number already used for a clear (or a heads-up) is never reused for another — two raids the
 * forming tracker merged under one number each get their own alert.
 */
export interface DepartureRaidsOptions {
  readonly settings: DepartureSettings;
  /** The lair's raid counter: the next unused raid number. */
  readonly nextRaidNumber: () => number;
}

/** A numbered raid that cleared. */
export interface NumberedClear {
  readonly number: number;
  readonly names: readonly string[];
  readonly size: number;
  /** How long its members were in the lair (their median stay). */
  readonly durationMs: number;
}

/** A numbered raid still in the lair, now due its "about to clear" heads-up. */
export interface NumberedDue {
  readonly number: number;
  readonly size: number;
  /** How long its members have been in (their median stay so far). */
  readonly elapsedMs: number;
}

export interface RaidNumberEntry {
  readonly name: string;
  readonly number: number;
}

/** Everything persisted, so a restart keeps every stay, number and dedup. */
export interface DepartureRaidsState {
  readonly detector: DepartureState;
  readonly numbers: readonly RaidNumberEntry[];
  readonly clearedNumbers: readonly number[];
  readonly warnedNumbers: readonly number[];
}

/** Recent numbers kept to stop reuse; far more than a lair's raids in a day. */
const USED_NUMBERS_KEPT = 50;

export class DepartureRaids {
  readonly #detector: DepartureDetector;
  readonly #nextRaidNumber: () => number;
  readonly #numbers = new Map<string, number>();
  #clearedNumbers: number[] = [];
  #warnedNumbers: number[] = [];

  constructor(options: DepartureRaidsOptions) {
    this.#detector = new DepartureDetector(options.settings);
    this.#nextRaidNumber = options.nextRaidNumber;
  }

  /** Feeds one poll; returns every raid that has now cleared, numbered. */
  observe(observation: DepartureObservation): NumberedClear[] {
    const clears = this.#detector.observe(observation).map((group) => this.#numberClear(group));
    for (const name of this.#numbers.keys()) {
      if (!this.#detector.isTracked(name)) this.#numbers.delete(name);
    }
    return clears;
  }

  /** Lends a numbered raid's number to its members who have none yet (the forming tracker's raid). */
  claim(names: readonly string[], number: number): void {
    for (const name of names) {
      if (this.#detector.isTracked(name) && !this.#numbers.has(name)) this.#numbers.set(name, number);
    }
  }

  /** The heads-up check (see {@link DepartureDetector.dueForWarning}), numbered. */
  dueForWarning(at: number, thresholdMs: number): NumberedDue | null {
    const due = this.#detector.dueForWarning(at, thresholdMs);
    if (due === null) return null;
    const number = this.#numberFor(due.names, this.#warnedNumbers);
    this.#warnedNumbers = remember(this.#warnedNumbers, number);
    return { number, size: due.size, elapsedMs: due.medianStayMs };
  }

  /** A block that left but hasn't stayed gone the whole wait yet, for a Chronicle kill to confirm. */
  pending(at: number): PendingGroup | null {
    return this.#detector.pending(at);
  }

  /** Confirms the pending block as a clear now, numbered, or null if none is pending. */
  confirmNow(at: number): NumberedClear | null {
    const group = this.#detector.confirmNow(at);
    return group === null ? null : this.#numberClear(group);
  }

  /** Writes off whoever is missing after a blind gap (see {@link DepartureDetector.rebaseline}). */
  rebaseline(): number {
    return this.#detector.rebaseline();
  }

  snapshot(): DepartureRaidsState {
    return {
      detector: this.#detector.snapshot(),
      numbers: [...this.#numbers].map(([name, number]) => ({ name, number })),
      clearedNumbers: [...this.#clearedNumbers],
      warnedNumbers: [...this.#warnedNumbers],
    };
  }

  restore(state: DepartureRaidsState): void {
    this.#detector.restore(state.detector);
    this.#numbers.clear();
    for (const entry of state.numbers) this.#numbers.set(entry.name, entry.number);
    this.#clearedNumbers = [...state.clearedNumbers];
    this.#warnedNumbers = [...state.warnedNumbers];
  }

  #numberClear(group: DepartedGroup): NumberedClear {
    const number = this.#numberFor(group.names, this.#clearedNumbers);
    this.#clearedNumbers = remember(this.#clearedNumbers, number);
    for (const name of group.names) this.#numbers.delete(name);
    return { number, names: group.names, size: group.size, durationMs: group.medianStayMs };
  }

  /** The block's majority number not yet used for this kind of alert, else a fresh one; given to all. */
  #numberFor(names: readonly string[], used: readonly number[]): number {
    const votes = new Map<number, number>();
    for (const name of names) {
      const number = this.#numbers.get(name);
      if (number !== undefined && !used.includes(number)) votes.set(number, (votes.get(number) ?? 0) + 1);
    }
    let best: number | null = null;
    for (const [number, count] of votes) {
      if (best === null || count > (votes.get(best) ?? 0)) best = number;
    }
    const number = best ?? this.#nextRaidNumber();
    for (const name of names) this.#numbers.set(name, number);
    return number;
  }
}

function remember(numbers: readonly number[], number: number): number[] {
  return [...numbers, number].slice(-USED_NUMBERS_KEPT);
}
