/**
 * Rendering unit tests.
 *
 * The alignment cases exist because of a bug that no other test could catch:
 * `displayWidth` counts ANSI escapes as visible characters, so padding looked
 * correct in CI (no TTY → colour disabled) and broke in every real terminal.
 * These cases run with colour forced on.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makePalette,
  renderMatrix,
  renderOverview,
  type ListView,
} from '../../src/cli/output.ts';
import type { Harness, RelationState } from '../../src/types.ts';
import type { RelationCell, SkillRelations } from '../../src/core/relation.ts';

const ANSI = /\u001b\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replace(ANSI, '');
}

const env = { home: '/home/tester', cwd: '/home/tester' };

function harness(id: string): Harness {
  return {
    id,
    name: id,
    path: `/home/tester/.${id}/skills`,
    preset: 'builtin',
    enabled: true,
    presetVersion: 1,
  };
}

function row(name: string, states: Record<string, RelationState>): SkillRelations {
  const cells: RelationCell[] = Object.entries(states).map(([harnessId, state]) => ({
    harnessId,
    harnessName: harnessId,
    state,
    native: false,
  }));

  return {
    skill: {
      name,
      path: `/home/tester/.agents/skills/${name}`,
      source: 'local',
      origin: null,
      description: `${name} description`,
      sizeBytes: 100,
      mtimeMs: 0,
    },
    cells,
    group: 'ok',
  };
}

describe('renderMatrix alignment', () => {
  test('columns stay aligned with colour enabled', () => {
    const palette = makePalette(true);
    const harnesses = [harness('claude-code'), harness('workbuddy')];
    const rows = [
      row('a', { 'claude-code': 'linked', workbuddy: 'absent' }),
      row('a-much-longer-skill-name', { 'claude-code': 'broken', workbuddy: 'conflict' }),
    ];

    const lines = renderMatrix(rows, harnesses, { env, palette })
      .split('\n')
      .map(strip)
      .filter((line) => line.trim() !== '' && !line.startsWith('  ✓'));

    const lengths = new Set(lines.map((line) => line.length));
    assert.equal(lengths.size, 1, `matrix rows should share one width, got ${[...lengths].join(', ')}`);
  });

  test('every harness gets a column', () => {
    const palette = makePalette(true);
    const harnesses = [harness('claude-code'), harness('workbuddy'), harness('qoder')];
    const rows = [row('alpha', { 'claude-code': 'linked', workbuddy: 'linked', qoder: 'absent' })];

    const text = strip(renderMatrix(rows, harnesses, { env, palette }));
    const header = text.split('\n')[0] ?? '';
    assert.match(header, /claude-code/);
    assert.match(header, /workbuddy/);
    assert.match(header, /qoder/);
  });
});

describe('renderOverview alignment', () => {
  test('problem column lines up regardless of name length', () => {
    const palette = makePalette(true);
    const rows = [
      row('short', { 'claude-code': 'conflict', workbuddy: 'absent' }),
      row('a-considerably-longer-name', { 'claude-code': 'conflict', workbuddy: 'absent' }),
    ];

    const view: ListView = {
      ssotRoot: '/home/tester/.agents/skills',
      anchorPath: '/home/tester/.agents/skills',
      anchorNote: null,
      nativeHarnessIds: [],
      harnessNotes: [],
      harnesses: [harness('claude-code'), harness('workbuddy')],
      rows,
      counts: { ok: 0, undistributed: 0, problem: 2 },
      warnings: [],
    };

    const dataLines = strip(renderOverview(view, { env, palette }))
      .split('\n')
      .filter((line) => line.includes('conflict'));

    assert.equal(dataLines.length, 2);
    const positions = dataLines.map((line) => line.indexOf('claude-code'));
    assert.equal(new Set(positions).size, 1, `problem column should start at one offset, got ${positions.join(', ')}`);
  });
});

describe('renderOverview content', () => {
  const palette = makePalette(false);

  test('shows harness notes above the groups', () => {
    const view: ListView = {
      ssotRoot: '/ssot',
      anchorPath: '/anchor',
      anchorNote: null,
      nativeHarnessIds: [],
      harnessNotes: ['claude-code: skills directory is itself a link'],
      harnesses: [harness('claude-code')],
      rows: [],
      counts: { ok: 0, undistributed: 0, problem: 0 },
      warnings: [],
    };

    const text = renderOverview(view, { env, palette });
    const ssotIndex = text.indexOf('SSOT');
    const noteIndex = text.indexOf('skills directory is itself a link');
    assert.ok(ssotIndex >= 0, 'SSOT line should be present');
    assert.ok(noteIndex > ssotIndex, 'harness note should appear after the SSOT line');
  });

  test('empty SSOT says so instead of printing nothing', () => {
    const view: ListView = {
      ssotRoot: '/ssot',
      anchorPath: '/anchor',
      anchorNote: null,
      nativeHarnessIds: [],
      harnessNotes: [],
      harnesses: [],
      rows: [],
      counts: { ok: 0, undistributed: 0, problem: 0 },
      warnings: [],
    };

    const text = renderOverview(view, { env, palette });
    assert.match(text, /no skills yet/);
  });
});
