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
import { classifyEntry, lstatOrNull, readlinkOrNull } from './fs-safe.ts';

export type SkillGroup = 'ok' | 'undistributed' | 'problem';

export interface RelationCell {
  harnessId: string;
  harnessName: string;
  state: RelationState;
}

export interface SkillRelations {
  skill: Skill;
  cells: RelationCell[];
  group: SkillGroup;
}

/** States that demand attention regardless of how many other harnesses are fine. */
const PROBLEM_STATES: readonly RelationState[] = ['broken', 'conflict', 'invalid', 'foreign'];

export function classifyGroup(cells: readonly RelationCell[]): SkillGroup {
  if (cells.some((cell) => PROBLEM_STATES.includes(cell.state))) return 'problem';
  if (cells.some((cell) => cell.state === 'linked')) return 'ok';
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

  return skills.map((skill) => {
    const cells: RelationCell[] = active.map((harness) => ({
      harnessId: harness.id,
      harnessName: harness.name,
      state: classifyEntry(path.join(harness.path, skill.name), classifyOptions),
    }));

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
export function inspectHarnesses(harnesses: readonly Harness[]): HarnessNote[] {
  const notes: HarnessNote[] = [];

  for (const harness of harnesses) {
    if (!harness.enabled) continue;

    const st = lstatOrNull(harness.path);
    if (st === null) {
      notes.push({
        harnessId: harness.id,
        severity: 'warn',
        message: `${harness.id}：目录不存在（${harness.path}）`,
      });
      continue;
    }

    if (st.isSymbolicLink()) {
      const target = readlinkOrNull(harness.path);
      notes.push({
        harnessId: harness.id,
        severity: 'warn',
        message: `${harness.id}：skills 目录本身是链接（→ ${target ?? '无法读取目标'}），逐技能链接不适用`,
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

/** Harness ids where the skill is healthy. Used by the overview's Agents column. */
export function linkedHarnesses(row: SkillRelations): string[] {
  return row.cells.filter((cell) => cell.state === 'linked').map((cell) => cell.harnessId);
}

/** Cells that need attention, paired with their state for inline display. */
export function problemCells(row: SkillRelations): RelationCell[] {
  return row.cells.filter((cell) => PROBLEM_STATES.includes(cell.state));
}
