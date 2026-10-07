import {
  DEFAULT_HR_ZONE_FLOOR_PERCENTS,
  bpmAtPercentOfMaxHr,
  hrZonesSchema,
  percentOfMaxHr,
  type HrZones,
} from "@running-coach/shared";
import { formatBpmRange } from "@/lib/format";
import { zonesProblems } from "./hr-zones-copy";

/**
 * One zone's lower bound as typed, both ways: a whole percent of max HR and whole bpm. share is its exact
 * share of max HR, so a new max HR moves the bpm without the rounding of the whole percent (a floor at
 * 134 of 196 is 68.4%, not 68%); null while unknown, after a bpm typed with no max HR to divide by.
 */
export type ZoneDraft = { percent: string; bpm: string; share: number | null };

/**
 * The zones form as typed: text, so a field can be empty or half typed. The bpm are what gets saved; each
 * percent follows its bpm, and a new max HR keeps the shares and moves the bpm.
 */
export type ZonesDraft = { maxHr: string; zones: readonly ZoneDraft[] };

/** A whole number as typed, or NaN for anything else: empty, a decimal, letters. */
function parseWhole(text: string): number {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The max HR the percents are of, while one is typed. */
function percentBase(maxHr: string): number | null {
  const max = parseWhole(maxHr);
  return max > 0 ? max : null;
}

/** The zone at an exact share of max HR: whole bpm and whole percent, both from the share. */
function atShare(share: number, max: number): ZoneDraft {
  return {
    share,
    percent: String(Math.round(share * 100)),
    bpm: String(bpmAtPercentOfMaxHr(share * 100, max)),
  };
}

/**
 * The form for zones from the API; with none (no run with heart rate yet) an empty max HR and Garmin's
 * default shares, whose bpm fill in once a max HR is typed.
 */
export function draftFromZones(zones: HrZones | null): ZonesDraft {
  if (zones === null) {
    return {
      maxHr: "",
      zones: DEFAULT_HR_ZONE_FLOOR_PERCENTS.map((percent) => ({
        share: percent / 100,
        percent: String(percent),
        bpm: "",
      })),
    };
  }
  return {
    maxHr: String(zones.maxHr),
    zones: zones.lowBpm.map((bpm) => ({
      share: bpm / zones.maxHr,
      percent: String(percentOfMaxHr(bpm, zones.maxHr)),
      bpm: String(bpm),
    })),
  };
}

/**
 * A new max HR keeps each zone's share and moves its bpm to that share of the new max, so typing the old
 * max again gives the old bpm back. A zone whose share is unknown takes it from its bpm.
 */
export function withMaxHr(draft: ZonesDraft, maxHr: string): ZonesDraft {
  const max = percentBase(maxHr);
  if (max === null) return { ...draft, maxHr };
  return {
    maxHr,
    zones: draft.zones.map((zone) => {
      if (zone.share !== null) return atShare(zone.share, max);
      const bpm = parseWhole(zone.bpm);
      return Number.isNaN(bpm)
        ? zone
        : { ...zone, share: bpm / max, percent: String(percentOfMaxHr(bpm, max)) };
    }),
  };
}

/** A zone's percent, and its bpm at that share of max HR. */
export function withPercent(draft: ZonesDraft, index: number, percent: string): ZonesDraft {
  const max = percentBase(draft.maxHr);
  const value = parseWhole(percent);
  return withZone(draft, index, (zone) => {
    if (Number.isNaN(value)) return { ...zone, percent };
    const share = value / 100;
    return {
      share,
      percent,
      bpm: max === null ? zone.bpm : String(bpmAtPercentOfMaxHr(value, max)),
    };
  });
}

/** A zone's bpm, and its percent of max HR. */
export function withBpm(draft: ZonesDraft, index: number, bpm: string): ZonesDraft {
  const max = percentBase(draft.maxHr);
  const value = parseWhole(bpm);
  return withZone(draft, index, (zone) => {
    if (Number.isNaN(value)) return { ...zone, bpm };
    if (max === null) return { ...zone, bpm, share: null };
    return { bpm, share: value / max, percent: String(percentOfMaxHr(value, max)) };
  });
}

function withZone(
  draft: ZonesDraft,
  index: number,
  change: (zone: ZoneDraft) => ZoneDraft,
): ZonesDraft {
  return {
    ...draft,
    zones: draft.zones.map((zone, position) => (position === index ? change(zone) : zone)),
  };
}

/**
 * A zone from its lower bound to the bpm before the next zone starts, the last one to max HR: "118-136
 * bpm". The dash while a bound is not a whole number or the zones overlap.
 */
export function zoneRange(draft: ZonesDraft, index: number): string {
  const low = parseWhole(draft.zones[index]?.bpm ?? "");
  const next = draft.zones[index + 1];
  const high = next === undefined ? parseWhole(draft.maxHr) : parseWhole(next.bpm) - 1;
  return formatBpmRange(low, high);
}

export type DraftCheck = { success: true; zones: HrZones } | { success: false; message: string };

/**
 * The zones to save, checked against the shared contract before anything is sent; otherwise the first
 * problem as one sentence from hr-zones-copy.ts, named by the field or rule the contract points at.
 */
export function checkDraft(draft: ZonesDraft): DraftCheck {
  const parsed = hrZonesSchema.safeParse({
    maxHr: parseWhole(draft.maxHr),
    lowBpm: draft.zones.map((zone) => parseWhole(zone.bpm)),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, message: issue ? issueMessage(issue) : zonesProblems.maxHr };
  }
  // The bpm are saved, but a percent that is not whole would leave the screen showing what was not saved.
  const halfTyped = draft.zones.findIndex((zone) => Number.isNaN(parseWhole(zone.percent)));
  if (halfTyped >= 0) {
    return { success: false, message: zonesProblems.wholePercent(halfTyped + 1) };
  }
  return { success: true, zones: parsed.data };
}

/** The contract's rules by where they point, in the screen's words (hr-zones-copy.ts). */
function issueMessage(issue: { code: string; path: PropertyKey[] }): string {
  const [field, index] = issue.path;
  if (field !== "lowBpm") return zonesProblems.maxHr;
  if (issue.code === "custom") {
    if (index === 0) return zonesProblems.zone1Floor;
    if (index === 4) return zonesProblems.zone5BelowMax;
    return zonesProblems.rising;
  }
  return typeof index === "number" ? zonesProblems.wholeBpm(index + 1) : zonesProblems.rising;
}
