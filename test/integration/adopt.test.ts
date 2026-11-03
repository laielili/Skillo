/**
 * adopt integration tests.
 *
 * This is the only command that overwrites skill content, so each case checks
 * three things: what the SSOT ends up containing, what the harness ends up
 * containing, and whether a verified transfer left anything behind in staging.
 * Nothing should survive in `.tmp` unless a step failed — a staged copy of what
 * the SSOT now holds is the redundancy this tool exists to remove.
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
  staging: string;
  addSsot(name: string, body: string): void;
  addHarness(name: string, body: string): void;
  ssotBody(name: string): string;
  harnessBody(name: string): string;
  isLinked(name: string): boolean;
  /** Packages still in `~/.skillo/.tmp`; empty means every transfer verified and cleaned up. */
  staged(): string[];
  cleanup(): void;
}

function makeBox(): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-adopt-'));
  const home = path.join(root, 'home');
  const ssot = path.join(home, '.agents', 'skills');
  const harness = path.join(home, '.workbuddy', 'skills');
  const staging = path.join(home, '.skillo', '.tmp');
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
    staging,
    addSsot: (name, body) => write(path.join(ssot, name), name, body),
    addHarness: (name, body) => write(path.join(harness, name), name, body),
    ssotBody: (name) => fs.readFileSync(path.join(ssot, name, 'SKILL.md'), 'utf8'),
    harnessBody: (name) => fs.readFileSync(path.join(harness, name, 'SKILL.md'), 'utf8'),
    isLinked: (name) => {
      const p = path.join(harness, name);
      return fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink();
    },
    staged: () => (fs.existsSync(staging) ? fs.readdirSync(staging) : []),
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(box.ssot, 'humanizer', 'SKILL.md')), 'copied into SSOT');
      assert.match(box.ssotBody('humanizer'), /harness version/);
      assert.equal(box.isLinked('humanizer'), true, 'harness entry replaced by a link');
      assert.deepEqual(box.staged(), [], 'the staged copy is deleted once the transfer verifies');
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 3);
      assert.match(result.stdout, /conflict/);
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 3, 'conflict exit code');
      assert.match(result.stdout, /conflict/);

      assert.match(box.ssotBody('grill-me'), /ssot version/, 'SSOT untouched');
      assert.match(box.harnessBody('grill-me'), /harness version/, 'harness untouched');
      assert.equal(box.isLinked('grill-me'), false, 'no link created on conflict');
    } finally {
      box.cleanup();
    }
  });

  test('--keep ssot discards the losing harness copy once the link verifies', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'ssot version');
      box.addHarness('grill-me', 'harness version');
      init(box);

      const result = runCli(['adopt', 'workbuddy', 'grill-me', '--keep', 'ssot'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.match(box.ssotBody('grill-me'), /ssot version/);
      assert.equal(box.isLinked('grill-me'), true);
      assert.deepEqual(box.staged(), [], 'the loser is not kept as a second copy');
    } finally {
      box.cleanup();
    }
  });

  test('--keep harness overwrites the SSOT and cleans both packages', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'old ssot version');
      box.addHarness('grill-me', 'new harness version');
      init(box);

      const result = runCli(['adopt', 'workbuddy', 'grill-me', '--keep', 'harness'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.match(box.ssotBody('grill-me'), /new harness version/, 'SSOT now holds the harness copy');
      assert.equal(box.isLinked('grill-me'), true);
      assert.deepEqual(box.staged(), [], 'old SSOT version and harness directory both deleted after verification');
    } finally {
      box.cleanup();
    }
  });

  test('a failed copy leaves the staged package and says so', () => {
    const box = makeBox();
    try {
      box.addSsot('grill-me', 'old ssot version');
      box.addHarness('grill-me', 'new harness version');
      // An internal link cannot be copied, so the transfer stops after the SSOT
      // entry has already been moved to staging.
      fs.symlinkSync(box.ssot, path.join(box.harness, 'grill-me', 'inner-link'), 'junction');
      init(box);

      const result = runCli(['adopt', 'workbuddy', 'grill-me', '--keep', 'harness'], box.env);
      assert.equal(result.exitCode, 3, result.stderr);
      assert.match(result.stdout, /left in ~\\\.skillo\\\.tmp|packages left in/);
      assert.match(result.stdout, /-ssot-grill-me/, 'the staged package names the side and the skill');

      assert.ok(
        box.staged().some((name) => name.endsWith('-ssot-grill-me')),
        'an unverified transfer keeps its package',
      );
      const stagedEntry = box.staged().find((name) => name.endsWith('-ssot-grill-me'));
      assert.match(
        fs.readFileSync(path.join(box.staging, stagedEntry ?? '', 'SKILL.md'), 'utf8'),
        /old ssot version/,
        'the discarded SSOT version is still recoverable from staging',
      );
      // Known gap, asserted so it cannot pass unnoticed: the failed copy is not
      // rolled back, so the SSOT keeps the half-written entry (minus the link).
      assert.equal(fs.existsSync(path.join(box.ssot, 'grill-me', 'inner-link')), false);
      assert.match(box.harnessBody('grill-me'), /new harness version/, 'harness content untouched');
    } finally {
      box.cleanup();
    }
  });

  test('--dry-run reports the plan and changes nothing', () => {
    const box = makeBox();
    try {
      box.addHarness('humanizer', 'harness version');
      init(box);

      const result = runCli(['adopt', 'workbuddy', '--dry-run'], box.env);
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

      const result = runCli(['adopt', 'workbuddy', 'grill-me', '--diff'], box.env);
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /is itself a link/);
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 3, 'partial failure reported, not a crash');

      assert.equal(box.isLinked('alpha'), true, 'alpha still adopted');
      assert.equal(box.isLinked('gamma'), true, 'gamma still adopted');
      assert.equal(box.isLinked('beta'), false, 'beta failed');
      assert.match(result.stdout, /failed/);
    } finally {
      box.cleanup();
    }
  });

  test('the harness is the first positional, and --from is gone', () => {
    const box = makeBox();
    try {
      box.addHarness('humanizer', 'harness version');
      init(box);

      const old = runCli(['adopt', '--from', 'workbuddy'], box.env);
      assert.equal(old.exitCode, 2, '--from no longer selects the harness');
      assert.match(old.stderr, /missing <harness>/);

      const now = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(now.exitCode, 0, now.stderr);
      assert.equal(box.isLinked('humanizer'), true);
    } finally {
      box.cleanup();
    }
  });

  test('a skill name in the harness slot is explained, not guessed', () => {
    const box = makeBox();
    try {
      box.addHarness('humanizer', 'harness version');
      init(box);

      const result = runCli(['adopt', 'humanizer'], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /unknown harness: humanizer/);
      assert.match(result.stderr, /first argument is the harness/);
      assert.match(result.stderr, /registered: workbuddy/);
    } finally {
      box.cleanup();
    }
  });

  test('several skills can be adopted in one call', () => {
    const box = makeBox();
    try {
      box.addHarness('alpha', 'a');
      box.addHarness('beta', 'b');
      box.addHarness('gamma', 'g');
      init(box);

      const result = runCli(['adopt', 'workbuddy', 'alpha', 'gamma'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(box.isLinked('alpha'), true);
      assert.equal(box.isLinked('gamma'), true);
      assert.equal(box.isLinked('beta'), false, 'beta was not named');
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

      const result = runCli(['adopt', 'workbuddy'], box.env);
      assert.equal(result.exitCode, 0);
      assert.equal(fs.existsSync(path.join(box.ssot, 'not-a-skill')), false);
    } finally {
      box.cleanup();
    }
  });
});
