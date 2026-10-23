/**
 * Skill × harness relation matrix.
 *
 * The grouping rule matters more than it looks: a skill installed in one of four
 * harnesses is "distributed", not "undistributed". Getting that backwards buries
 * the signal in false alarms, and an alarm that always fires is an alarm nobody
 * reads.
 */

import path from 'node:path';

import type { Harness, RelationState, Skill } from '../types.ts';
import { classifyEntry, lstatOrNull, readlinkOrNull, realpathOrNull } from './fs-safe.ts';
import { samePath } from './paths.ts';

export type SkillGroup = 'ok' | 'undistributed' | 'problem';

export interface RelationCell {
  harnessId: string;
  harnessName: string;
  state: RelationState;
  /**
   * True when the harness reads the anchor directory natively.
   *
   * Such a harness needs no link: it already sees the SSOT. Without this flag
   * every skill underneath it would classify as `conflict`, because traversing
   * the anchor turns each entry into a plain directory.
   */
  native: boolean;
}

export interface SkillRelations {
  skill: Skill;
  cells: RelationCell[];
  group: SkillGroup;
}

/**
 * True when the harness's skills directory IS the anchor.
 *
 * The three checks are ordered, and the order matters:
 *
 * 1. Literal path equality — the user configured the anchor path itself. Native,
 *    regardless of what the anchor currently is.
 * 2. If the harness directory is itself a symlink/junction, it is NOT native.
 *    That is the whole-directory-link failure mode, which `doctor --fix` must
 *    detach — even though `realpath` makes it look identical to the anchor.
 * 3. A real directory whose resolved path equals the anchor's resolved path, i.e.
 *    the harness points straight at the SSOT.
 */
export function isNativePath(harnessPath: string, anchorPath: string, anchorReal: string | null): boolean {
  if (samePath(path.resolve(harnessPath), path.resolve(anchorPath))) return true;

  const st = lstatOrNull(harnessPath);
  if (st !== null && st.isSymbolicLink()) return false;

  if (anchorReal === null) return false;
  const harnessReal = realpathOrNull(harnessPath);
  return harnessReal !== null && samePath(harnessReal, anchorReal);
}

export function isNativeHarness(harness: Harness, anchorPath: string, anchorReal: string | null): boolean {
  return isNativePath(harness.path, anchorPath, anchorReal);
}

/** States that demand attention regardless of how many other harnesses are fine. */
const PROBLEM_STATES: readonly RelationState[] = ['broken', 'conflict', 'invalid', 'foreign'];

/**
 * Grouping rule.
 *
 * Native harnesses are excluded from the decision: a skill being visible to Codex
 * because Codex reads the anchor is not the same as the user having distributed it
 * there. Counting native cells would mark every skill "distributed" and empty the
 * undistributed group permanently.
 *
 * If every registered harness is native, the skill is nonetheless visible to a
 * tool, so it is reported as `ok` rather than `undistributed`.
 */
export function classifyGroup(cells: readonly RelationCell[]): SkillGroup {
  const managed = cells.filter((cell) => !cell.native);

  if (managed.some((cell) => PROBLEM_STATES.includes(cell.state))) return 'problem';
  if (managed.some((cell) => cell.state === 'linked')) return 'ok';
  if (managed.length === 0 && cells.some((cell) => cell.native)) return 'ok';

  return 'undistributed';
}

export interface BuildRelationsInput {
  skills: readonly Skill[];
  harnesses: readonly Harness[];
  /** Resolved real path of the anchor, or null when it cannot be resolved. */
  anchorReal: string | null;
  /** Anchor path as configured; differs from `anchorReal` when it is a junction. */
  anchorPath?: string;
}

export function buildRelations(input: BuildRelationsInput): SkillRelations[] {
  const { skills, harnesses, anchorReal, anchorPath } = input;
  const active = harnesses.filter((harness) => harness.enabled);
  const classifyOptions = {
    anchorReal,
    ...(anchorPath === undefined ? {} : { anchorPath }),
  };

  const nativeIds = new Set(
    anchorPath === undefined
      ? []
      : active.filter((harness) => isNativeHarness(harness, anchorPath, anchorReal)).map((harness) => harness.id),
  );

  return skills.map((skill) => {
    const cells: RelationCell[] = active.map((harness) => {
      // A native harness already sees every skill in the SSOT, so the relation is
      // "configured" by definition. Running classifyEntry here would report
      // conflict for each one, which is both wrong and unactionable.
      if (nativeIds.has(harness.id)) {
        return { harnessId: harness.id, harnessName: harness.name, state: 'linked' as const, native: true };
      }
      return {
        harnessId: harness.id,
        harnessName: harness.name,
        state: classifyEntry(path.join(harness.path, skill.name), classifyOptions),
        native: false,
      };
    });

    return { skill, cells, group: classifyGroup(cells) };
  });
}

export interface HarnessNote {
  harnessId: string;
  severity: 'warn' | 'error';
  message: string;
}

/**
 * Harness-level problems that explain why every entry underneath looks wrong.
 *
 * The important one: when the harness skills directory is itself a link, the
 * per-skill model does not apply at all. Reporting that as fourteen individual
 * conflicts is technically true and practically useless — the user needs the one
 * sentence that explains all fourteen.
 */
export function inspectHarnesses(
  harnesses: readonly Harness[],
  nativeIds: readonly string[] = [],
): HarnessNote[] {
  const notes: HarnessNote[] = [];
  const nativeSet = new Set(nativeIds);

  for (const harness of harnesses) {
    if (!harness.enabled) continue;
    // A native harness's directory being a link is expected — it IS the anchor.
    // Warning about it would contradict the native line printed just above.
    if (nativeSet.has(harness.id)) continue;

    const st = lstatOrNull(harness.path);
    if (st === null) {
      notes.push({
        harnessId: harness.id,
        severity: 'warn',
        message: `${harness.id}: directory does not exist (${harness.path})`,
      });
      continue;
    }

    if (st.isSymbolicLink()) {
      const target = readlinkOrNull(harness.path);
      notes.push({
        harnessId: harness.id,
        severity: 'warn',
        message: `${harness.id}: skills directory is itself a link (→ ${target ?? 'target unreadable'}), per-skill links do not apply`,
      });
    }
  }

  return notes;
}

export interface RelationCounts {
  ok: number;
  undistributed: number;
  problem: number;
}

export function countGroups(rows: readonly SkillRelations[]): RelationCounts {
  const counts: RelationCounts = { ok: 0, undistributed: 0, problem: 0 };
  for (const row of rows) counts[row.group] += 1;
  return counts;
}

/** Harness ids where the skill is healthy. Native harnesses are excluded — they are reported once at the top. */
export function linkedHarnesses(row: SkillRelations): string[] {
  return row.cells.filter((cell) => cell.state === 'linked' && !cell.native).map((cell) => cell.harnessId);
}

/** Harness ids that read the anchor directly, in registration order. */
export function nativeHarnessIds(harnesses: readonly Harness[], anchorPath: string, anchorReal: string | null): string[] {
  return harnesses
    .filter((harness) => harness.enabled && isNativeHarness(harness, anchorPath, anchorReal))
    .map((harness) => harness.id);
}

/** Cells that need attention, paired with their state for inline display. */
export function problemCells(row: SkillRelations): RelationCell[] {
  return row.cells.filter((cell) => PROBLEM_STATES.includes(cell.state));
}
