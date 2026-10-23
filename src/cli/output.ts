/**
 * Rendering.
 *
 * Pure string building — no file system, no config. Colours are injected so
 * snapshots stay stable and `--json` never inherits escape codes.
 *
 * Layout principle: the overview answers "what needs attention", the detail view
 * answers "where exactly", the matrix answers "compare across tools". The matrix
 * is not the default because it degrades badly past ~20 skills.
 */

import path from 'node:path';

import type { Env, Harness, RelationState } from '../types.ts';
import type { RelationCounts, SkillGroup, SkillRelations } from '../core/relation.ts';
import { toDisplay } from '../core/paths.ts';
import { displayWidth, padDisplay, truncateDisplay } from '../util/text.ts';

/* ─────────────────────────────── palette ───────────────────────────── */

export interface Palette {
  bold: (text: string) => string;
  dim: (text: string) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
  error: (text: string) => string;
  accent: (text: string) => string;
}

export function makePalette(enabled: boolean): Palette {
  const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: wrap('1'),
    dim: wrap('90'),
    ok: wrap('32'),
    warn: wrap('33'),
    error: wrap('31'),
    accent: wrap('36'),
  };
}

/** True when ANSI colour should be emitted. */
export function colourEnabled(stream: { isTTY?: boolean }): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['TERM'] === 'dumb') return false;
  return stream.isTTY === true;
}

/* ──────────────────────────── state glyphs ─────────────────────────── */

const STATE_GLYPH: Record<RelationState, string> = {
  linked: '✓',
  absent: '·',
  foreign: 'F',
  broken: '!',
  conflict: 'C',
  invalid: 'X',
};

function paintState(state: RelationState, palette: Palette): string {
  const glyph = STATE_GLYPH[state];
  switch (state) {
    case 'linked':
      return palette.ok(glyph);
    case 'absent':
      return palette.dim(glyph);
    case 'foreign':
      return palette.warn(glyph);
    case 'broken':
    case 'conflict':
    case 'invalid':
      return palette.error(glyph);
  }
}

const STATE_LABEL: Record<RelationState, string> = {
  linked: 'linked',
  absent: 'absent',
  foreign: 'foreign — points outside anchor',
  broken: 'broken — target unreachable',
  conflict: 'conflict — real directory in the way',
  invalid: 'invalid — name taken by a file',
};

/* ─────────────────────────────── views ─────────────────────────────── */

export interface StatusView {
  ssotRoot: string;
  anchorPath: string;
  anchorNote: string | null;
  /** Harness-level problems that explain whole columns looking wrong. */
  harnessNotes: readonly string[];
  harnesses: readonly Harness[];
  rows: readonly SkillRelations[];
  counts: RelationCounts;
  warnings: readonly string[];
}

export interface RenderOptions {
  env: Env;
  palette: Palette;
  /** Column budget for the agents list before it is trimmed. */
  width?: number;
}

const NAME_COL = 34;
const SOURCE_COL = 10;
const AGENTS_COL = 30;

/**
 * Pad using the *uncoloured* text for measurement.
 *
 * `displayWidth` counts ANSI escape bytes as visible characters, so padding a
 * coloured string directly produces silently misaligned columns — and only in a
 * real terminal, where colour is actually enabled. Passing both forms keeps the
 * measurement honest and the output pretty.
 */
function padColoured(plain: string, coloured: string, width: number): string {
  const gap = width - displayWidth(plain);
  return gap > 0 ? coloured + ' '.repeat(gap) : coloured;
}

function groupHeader(group: SkillGroup, count: number, palette: Palette): string {
  switch (group) {
    case 'ok':
      return palette.ok(`  ✓ 已分发 (${count})`);
    case 'undistributed':
      return palette.warn(`  ○ 未分发 (${count})`);
    case 'problem':
      return palette.error(`  ! 异常 (${count})`);
  }
}

function overviewLine(row: SkillRelations, options: RenderOptions): string {
  const { palette } = options;
  const linked = row.cells.filter((cell) => cell.state === 'linked');
  const problems = row.cells.filter((cell) => cell.state !== 'linked' && cell.state !== 'absent');

  const linkedPlain = linked.map((cell) => cell.harnessId).join(', ');
  const linkedColoured =
    linked.length === 0
      ? palette.dim('—')
      : linked.map((cell) => palette.accent(cell.harnessId)).join(palette.dim(', '));

  const problemPlain = problems.map((cell) => `${cell.harnessId} ${cell.state}`).join('   ');
  const problemColoured = problems
    .map((cell) => `${palette.error(cell.harnessId)} ${palette.dim(`(${cell.state})`)}`)
    .join('   ');

  const name = row.skill.name;
  const nameWidth = Math.max(NAME_COL, displayWidth(name) + 2);

  return (
    '    ' +
    padDisplay(name, nameWidth) +
    padColoured(row.skill.source, palette.dim(row.skill.source), SOURCE_COL) +
    padColoured(linkedPlain, linkedColoured, AGENTS_COL) +
    problemColoured
  );
}

export function renderOverview(view: StatusView, options: RenderOptions): string {
  const { palette } = options;
  const lines: string[] = [];
  const issueNote = view.counts.problem > 0 ? palette.error(` · ${view.counts.problem} issue`) : '';

  lines.push(
    `${palette.bold('Skillo')}${palette.dim(' · ')}${view.rows.length} skills${palette.dim(' · ')}${
      view.harnesses.length
    } agents${issueNote}`,
  );
  lines.push(`${palette.dim('SSOT  ')} ${toDisplay(view.ssotRoot, options.env)}`);
  lines.push(`${palette.dim('Anchor')} ${toDisplay(view.anchorPath, options.env)}`);
  if (view.anchorNote !== null) {
    lines.push(`${palette.dim('      ')} ${palette.warn(view.anchorNote)}`);
  }
  for (const note of view.harnessNotes) {
    lines.push(`${palette.dim('      ')} ${palette.warn(note)}`);
  }
  lines.push('');

  const order: SkillGroup[] = ['ok', 'undistributed', 'problem'];

  for (const group of order) {
    const members = view.rows.filter((row) => row.group === group);
    if (members.length === 0) continue;

    lines.push(groupHeader(group, members.length, palette));
    for (const row of members.sort((a, b) => a.skill.name.localeCompare(b.skill.name))) {
      lines.push(overviewLine(row, options));
    }
    lines.push('');
  }

  if (view.rows.length === 0) {
    lines.push(palette.dim('  SSOT 里还没有技能'));
    lines.push('');
  }

  for (const warning of view.warnings) {
    lines.push(palette.warn(`  ! ${warning}`));
  }
  if (view.warnings.length > 0) lines.push('');

  return lines.join('\n').replace(/\n+$/, '\n');
}

export function renderDetail(row: SkillRelations, options: RenderOptions): string {
  const { palette } = options;
  const { skill } = row;
  const lines: string[] = [];

  const nameWidth = Math.max(NAME_COL, displayWidth(skill.name) + 4);
  lines.push(
    `  ${padColoured(skill.name, palette.bold(skill.name), nameWidth)}${palette.dim('source: ')}${skill.source}`,
  );
  lines.push(`  ${palette.dim('SKILL ')} ${toDisplay(skill.path, options.env)}`);
  if (skill.origin !== null) {
    lines.push(`  ${palette.dim('ORIGIN')} ${skill.origin}`);
  }
  if (skill.description !== '') {
    lines.push(`  ${palette.dim('DESC  ')} ${truncateDisplay(skill.description, 100)}`);
  }
  lines.push('');

  const idWidth = Math.max(...row.cells.map((cell) => displayWidth(cell.harnessId)), 12) + 2;
  for (const cell of row.cells) {
    lines.push(
      `  ${padDisplay(cell.harnessId, idWidth)}${paintState(cell.state, palette)} ${palette.dim(
        STATE_LABEL[cell.state],
      )}`,
    );
  }

  return lines.join('\n') + '\n';
}

export function renderMatrix(rows: readonly SkillRelations[], harnesses: readonly Harness[], options: RenderOptions): string {
  const { palette } = options;
  const active = harnesses.filter((harness) => harness.enabled);
  if (active.length === 0) return palette.dim('  没有启用的 harness\n');

  const idWidth = 12;
  const nameWidth = Math.max(...rows.map((row) => displayWidth(row.skill.name)), 5) + 2;

  const header =
    padDisplay('SKILL', nameWidth) + active.map((harness) => padDisplay(truncateDisplay(harness.id, idWidth), idWidth)).join('');
  const lines = [palette.dim(header)];

  for (const row of [...rows].sort((a, b) => a.skill.name.localeCompare(b.skill.name))) {
    let line = padDisplay(row.skill.name, nameWidth);
    for (const harness of active) {
      const cell = row.cells.find((candidate) => candidate.harnessId === harness.id);
      const plain = cell === undefined ? '?' : STATE_GLYPH[cell.state];
      const coloured = cell === undefined ? '?' : paintState(cell.state, palette);
      line += padColoured(plain, coloured, idWidth);
    }
    lines.push(line);
  }

  lines.push('');
  lines.push(palette.dim('  ✓ linked   · absent   F foreign   ! broken   C conflict   X invalid'));

  return lines.join('\n') + '\n';
}

/* ──────────────────────────────── json ─────────────────────────────── */

export interface JsonEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  warnings: string[];
}

export function statusJson(view: StatusView): JsonEnvelope {
  return {
    ok: true,
    data: {
      ssotRoot: view.ssotRoot,
      anchor: view.anchorPath,
      anchorNote: view.anchorNote,
      harnessNotes: [...view.harnessNotes],
      counts: view.counts,
      harnesses: view.harnesses.map((harness) => ({
        id: harness.id,
        name: harness.name,
        path: harness.path,
        enabled: harness.enabled,
      })),
      skills: view.rows.map((row) => ({
        name: row.skill.name,
        path: row.skill.path,
        source: row.skill.source,
        origin: row.skill.origin,
        description: row.skill.description,
        sizeBytes: row.skill.sizeBytes,
        group: row.group,
        cells: row.cells.map((cell) => ({ harness: cell.harnessId, state: cell.state })),
      })),
    },
    warnings: [...view.warnings],
  };
}

/** Default rendering width when the terminal cannot report one. */
export function terminalWidth(): number {
  const width = process.stdout.columns;
  return typeof width === 'number' && width > 40 ? width : 100;
}

/** Join a path for display without assuming it exists. */
export function displayPath(target: string, env: Env): string {
  return path.normalize(toDisplay(target, env));
}
