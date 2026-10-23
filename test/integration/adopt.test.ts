/**
 * adopt integration tests.
 *
 * This is the only command that overwrites skill content, so each case checks
 * three things: what the SSOT ends up containing, what the harness ends up
 * containing, and whether the loser of any collision still exists in the trash.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../src/cli/router.ts';
import type { Env } from '../../src/types.ts';

interface Box {
  root: string;
  env: Env;
  ssot: string;
  harness: string;
  trash: string;
  addSsot(name: string, body: string): void;
  addHarness(name: string, body: string): void;
  ssotBody(name: string): string;
  harnessBody(name: string): string;
  isLinked(name: string): boolean;
  cleanup(): void;
}

function makeBox(): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-adopt-'));
  const home = path.join(root, 'home');
  const ssot = path.join(home, '.agents', 'skills');
  const harness = path.join(home, '.workbuddy', 'skills');
  const trash = path.join(home, '.skillo', '.trash');
  fs.mkdirSync(ssot, { recursive: true });
  fs.mkdirSync(harness, { recursive: true });

  const write = (dir: string, name: string, body: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
      'utf8',
    );
  };

  return {
    root,
    env: { home, cwd: root },
    ssot,
    harness,
    trash,
    addSsot: (name, body) => write(path.join(ssot, name), name, body),
    addHarness: (name, body) => write(path.join(harness, name), name, body),
    ssotBody: (name) => fs.readFileSync(path.join(ssot, name, 'SKILL.md'), 'utf8'),
    harnessBody: (name) => fs.readFileSync(path.join(harness, name, 'SKILL.md'), 'utf8'),
    isLinked: (name) => {
      const p = path.join(harness, name);
      return fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink();
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function init(box: Box): void {
  const result = runCli(['init'], box.env);
  assert.equal(result.exitCode, 0, result.stderr);
}

describe('skillo adopt', () => {
  test('pulls a harness-only skill into the SSOT and leaves a link behind', () => {
    const box = makeBox();
    try {
      box.addHarness('humanizer', 'harness version');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(box.ssot, 'humanizer', 'SKILL.md')), 'copied into SSOT');
      assert.match(box.ssotBody('humanizer'), /harness version/);
      assert.equal(box.isLinked('humanizer'), true, 'harness entry replaced by a link');
      assert.ok(fs.existsSync(path.join(box.trash)), 'original moved to trash');
    } finally {
      box.cleanup();
    }
  });

  test('de-duplicates identical copies without prompting', () => {
    const box = makeBox();
    try {
      const identical = 'shared body';
      box.addSsot('markitdown', identical);
      box.addHarness('markitdown', identical);
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /adopted-identical/);
      assert.equal(box.isLinked('markitdown'), true);
    } finally {
      box.cleanup();
    }
  });

  test('treats platform metadata as noise, not as a collision', () => {
    const box = makeBox();
    try {
      box.addSsot('humanizer', 'shared body');
      box.addHarness('humanizer', 'shared body');
      // WorkBuddy drops this next to SKILL.md; it is not skill content.
      fs.writeFileSync(
        path.join(box.harness, 'humanizer', '_user_meta.json'),
        JSON.stringify({ name: 'humanizer', enabled: true }),
        'utf8',
      );
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 0, 'metadata-only difference must not be a collision');
      assert.match(result.stdout, /adopted-identical/);
      assert.equal(box.isLinked('humanizer'), true);
      assert.equal(
        fs.existsSync(path.join(box.ssot, 'humanizer', '_user_meta.json')),
        false,
        'platform metadata must not leak into the SSOT',
      );
    } finally {
      box.cleanup();
    }
  });

  test('keeps real content differences as collisions', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-with-docs', 'ssot body');
      box.addHarness('grill-with-docs', 'harness body');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 3);
      assert.match(result.stdout, /冲突/);
    } finally {
      box.cleanup();
    }
  });

  test('refuses to resolve a collision without --keep, touching neither side', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'ssot version');
      box.addHarness('grill-me', 'harness version');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 3, 'conflict exit code');
      assert.match(result.stdout, /冲突/);

      assert.match(box.ssotBody('grill-me'), /ssot version/, 'SSOT untouched');
      assert.match(box.harnessBody('grill-me'), /harness version/, 'harness untouched');
      assert.equal(box.isLinked('grill-me'), false, 'no link created on conflict');
    } finally {
      box.cleanup();
    }
  });

  test('--keep ssot discards the harness copy but keeps it in the trash', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'ssot version');
      box.addHarness('grill-me', 'harness version');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy', 'grill-me', '--keep', 'ssot'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.match(box.ssotBody('grill-me'), /ssot version/);
      assert.equal(box.isLinked('grill-me'), true);

      const trashed = fs.readdirSync(box.trash);
      assert.equal(trashed.some((name) => name.includes('grill-me')), true, 'harness copy recoverable');
    } finally {
      box.cleanup();
    }
  });

  test('--keep harness overwrites the SSOT but backs up the old version first', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'old ssot version');
      box.addHarness('grill-me', 'new harness version');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy', 'grill-me', '--keep', 'harness'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.match(box.ssotBody('grill-me'), /new harness version/, 'SSOT now holds the harness copy');
      assert.equal(box.isLinked('grill-me'), true);

      const trashed = fs.readdirSync(box.trash);
      assert.equal(trashed.some((name) => name.includes('grill-me')), true, 'old SSOT version recoverable');
    } finally {
      box.cleanup();
    }
  });

  test('--dry-run reports the plan and changes nothing', () => {
    const box = makeBox();
    try {
      box.addHarness('humanizer', 'harness version');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy', '--dry-run'], box.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /dry-run/);
      assert.equal(fs.existsSync(path.join(box.ssot, 'humanizer')), false, 'nothing copied');
      assert.equal(box.isLinked('humanizer'), false, 'nothing linked');
    } finally {
      box.cleanup();
    }
  });

  test('--diff shows the difference instead of deciding', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'ssot only line');
      box.addHarness('grill-me', 'harness only line');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy', 'grill-me', '--diff'], box.env);
      assert.equal(result.exitCode, 0);

      // Either git produced a real diff, or we fell back to printing both paths.
      const mentionsBoth =
        result.stdout.includes('ssot only line') || result.stdout.includes('.agents');
      assert.ok(mentionsBoth, 'diff output should reference the compared content');
      assert.match(box.ssotBody('grill-me'), /ssot only line/, 'SSOT still untouched');
    } finally {
      box.cleanup();
    }
  });

  test('refuses when the harness directory is itself a link', () => {
    const box = makeBox();
    try {
      box.addSsot('alpha', 'body');
      fs.rmSync(box.harness, { recursive: true, force: true });
      fs.symlinkSync(box.ssot, box.harness, 'junction');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /skills 目录本身是链接/);
      assert.match(result.stderr, /doctor --fix/);
    } finally {
      box.cleanup();
    }
  });

  test('one failing skill does not abort the rest of the batch', () => {
    const box = makeBox();
    try {
      box.addHarness('alpha', 'a');
      box.addHarness('beta', 'b');
      box.addHarness('gamma', 'g');
      // A plain file where the SSOT copy wants a directory makes this one fail.
      fs.writeFileSync(path.join(box.ssot, 'beta'), 'blocking file', 'utf8');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 3, 'partial failure reported, not a crash');

      assert.equal(box.isLinked('alpha'), true, 'alpha still adopted');
      assert.equal(box.isLinked('gamma'), true, 'gamma still adopted');
      assert.equal(box.isLinked('beta'), false, 'beta failed');
      assert.match(result.stdout, /失败/);
    } finally {
      box.cleanup();
    }
  });

  test('skips entries without a manifest', () => {
    const box = makeBox();
    try {
      fs.mkdirSync(path.join(box.harness, 'not-a-skill'), { recursive: true });
      fs.writeFileSync(path.join(box.harness, 'not-a-skill', 'notes.txt'), 'x', 'utf8');
      init(box);

      const result = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 0);
      assert.equal(fs.existsSync(path.join(box.ssot, 'not-a-skill')), false);
    } finally {
      box.cleanup();
    }
  });
});
