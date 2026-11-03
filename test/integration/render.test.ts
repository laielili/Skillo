/**
 * Rendering behaviour through the CLI seam.
 *
 * Colour forcing exists because the original alignment bug only appeared with
 * ANSI codes enabled: `displayWidth` counted escape bytes as visible characters,
 * so padding looked right in CI and broke in every real terminal.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../../src/cli/router.ts';
import { makeSandbox, writeSkill, type Sandbox } from '../helpers/sandbox.ts';

const ANSI = /\u001b\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replace(ANSI, '');
}

function withColour<T>(run: () => T): T {
  const previous = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '1';
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env['FORCE_COLOR'];
    else process.env['FORCE_COLOR'] = previous;
  }
}

function makeBox(): Sandbox {
  const box = makeSandbox('skillo-render-');
  const ssot = path.join(box.home, '.agents', 'skills');
  writeSkill(ssot, 'a');
  writeSkill(ssot, 'a-much-longer-skill-name');
  fs.mkdirSync(path.join(box.home, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(box.home, '.workbuddy', 'skills'), { recursive: true });
  assert.equal(runCli(['init'], box.env).exitCode, 0);
  assert.equal(runCli(['link', 'a', '--to', 'claude-code'], box.env).exitCode, 0);

  // One conflict and one broken link, so both problem renderers are exercised.
  fs.mkdirSync(path.join(box.home, '.workbuddy', 'skills', 'a'), { recursive: true });
  const gone = path.join(box.root, 'gone');
  fs.mkdirSync(gone, { recursive: true });
  const slot = path.join(box.home, '.claude', 'skills', 'a-much-longer-skill-name');
  fs.symlinkSync(gone, slot, 'junction');
  fs.rmSync(gone, { recursive: true, force: true });

  return box;
}

describe('rendering through the CLI seam', () => {
  test('matrix columns stay aligned with colour enabled', () => {
    const box = makeBox();
    try {
      const result = withColour(() => runCli(['list', '--matrix'], box.env));
      assert.equal(result.exitCode, 0, result.stderr);

      const lines = strip(result.stdout)
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.includes('✓ linked'));
      const lengths = new Set(lines.map((line) => line.length));
      assert.equal(lengths.size, 1, `matrix rows should share one width, got ${[...lengths].join(', ')}`);
      assert.match(lines[0] ?? '', /claude-code/);
      assert.match(lines[0] ?? '', /workbuddy/);
    } finally {
      box.cleanup();
    }
  });

  test('problem columns line up regardless of name length', () => {
    const box = makeBox();
    try {
      const claude = path.join(box.home, '.claude', 'skills');
      for (const name of ['a', 'a-much-longer-skill-name']) {
        const slot = path.join(claude, name);
        if (fs.lstatSync(slot).isSymbolicLink()) fs.rmdirSync(slot);
        fs.mkdirSync(slot, { recursive: true });
      }

      const result = withColour(() => runCli(['list'], box.env));
      assert.equal(result.exitCode, 0, result.stderr);

      const dataLines = strip(result.stdout)
        .split('\n')
        .filter((line) => line.includes('conflict'));
      assert.equal(dataLines.length, 2, 'both skills should show their conflict');
      const positions = dataLines.map((line) => line.indexOf('claude-code'));
      assert.equal(new Set(positions).size, 1, `problem column should start at one offset, got ${positions.join(', ')}`);
    } finally {
      box.cleanup();
    }
  });

  test('empty SSOT says so instead of printing nothing', () => {
    const box = makeSandbox('skillo-render-empty-');
    try {
      assert.equal(runCli(['init'], box.env).exitCode, 0);
      const result = runCli(['list'], box.env);
      assert.match(result.stdout, /no skills yet/);
    } finally {
      box.cleanup();
    }
  });

  test('harness notes appear below the SSOT line', () => {
    const box = makeSandbox('skillo-render-note-');
    try {
      const ssot = path.join(box.home, '.agents', 'skills');
      fs.mkdirSync(ssot, { recursive: true });
      fs.mkdirSync(path.join(box.home, '.claude'), { recursive: true });
      fs.symlinkSync(ssot, path.join(box.home, '.claude', 'skills'), 'junction');
      assert.equal(runCli(['init'], box.env).exitCode, 0);

      const result = runCli(['list'], box.env);
      const ssotIndex = result.stdout.indexOf('SSOT');
      const noteIndex = result.stdout.indexOf('skills directory is itself a link');
      assert.ok(ssotIndex >= 0);
      assert.ok(noteIndex > ssotIndex);
    } finally {
      box.cleanup();
    }
  });
});
