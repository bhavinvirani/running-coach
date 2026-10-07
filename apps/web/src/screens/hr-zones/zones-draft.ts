import {
  MAX_MAX_HR,
  MIN_MAX_HR,
  bpmAtPercentOfMaxHr,
  hrZonesSchema,
  percentOfMaxHr,
  type HrZones,
} from "@running-coach/shared";
import { formatBpmRange } from "@/lib/format";

/** One zone's lower bound as typed, both ways: a whole percent of max HR and whole bpm. */
export type ZoneDraft = { percent: string; bpm: string };

/**
 * The zones form as typed: text, so a field can be empty or half typed. The bpm are what gets saved; each
 * percent follows its bpm, and a new max HR keeps the percents and moves the bpm.
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

export function draftFromZones(zones: HrZones): ZonesDraft {
  return {
    maxHr: String(zones.maxHr),
    zones: zones.lowBpm.map((bpm) => ({
      percent: String(percentOfMaxHr(bpm, zones.maxHr)),
      bpm: String(bpm),
    })),
  };
}

/** A new max HR keeps each zone's percent and moves its bpm to that share of the new max. */
export function withMaxHr(draft: ZonesDraft, maxHr: string): ZonesDraft {
  const max = percentBase(maxHr);
  if (max === null) return { ...draft, maxHr };
  return {
    maxHr,
    zones: draft.zones.map((zone) => {
      const percent = parseWhole(zone.percent);
      return Number.isNaN(percent)
        ? zone
        : { ...zone, bpm: String(bpmAtPercentOfMaxHr(percent, max)) };
    }),
  };
}

/** A zone's percent, and its bpm at that share of max HR. */
export function withPercent(draft: ZonesDraft, index: number, percent: string): ZonesDraft {
  const max = percentBase(draft.maxHr);
  const value = parseWhole(percent);
  return withZone(draft, index, (zone) => ({
    percent,
    bpm: max === null || Number.isNaN(value) ? zone.bpm : String(bpmAtPercentOfMaxHr(value, max)),
  }));
}

/** A zone's bpm, and its percent of max HR. */
export function withBpm(draft: ZonesDraft, index: number, bpm: string): ZonesDraft {
  const max = percentBase(draft.maxHr);
  const value = parseWhole(bpm);
  return withZone(draft, index, (zone) => ({
    bpm,
    percent:
      max === null || Number.isNaN(value) ? zone.percent : String(percentOfMaxHr(value, max)),
  }));
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
 * problem as one sentence. The contract's own rules (rising, below max HR) say it in their words; a field
 * that is not a whole number in range gets a sentence naming the field.
 */
export function checkDraft(draft: ZonesDraft): DraftCheck {
  const parsed = hrZonesSchema.safeParse({
    maxHr: parseWhole(draft.maxHr),
    lowBpm: draft.zones.map((zone) => parseWhole(zone.bpm)),
  });
  if (parsed.success) return { success: true, zones: parsed.data };
  const issue = parsed.error.issues[0];
  return { success: false, message: issue ? issueMessage(issue) : invalidMaxHr };
}

const invalidMaxHr = `Max HR is a whole number from ${MIN_MAX_HR} to ${MAX_MAX_HR} bpm.`;

function issueMessage(issue: { code: string; path: PropertyKey[]; message: string }): string {
  if (issue.code === "custom")
    return /[.!?]$/.test(issue.message) ? issue.message : `${issue.message}.`;
  const [field, index] = issue.path;
  if (field === "lowBpm" && typeof index === "number") {
    return `Zone ${index + 1} starts at a whole number of bpm.`;
  }
  return invalidMaxHr;
}
