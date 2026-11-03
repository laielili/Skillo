/**
 * `skillo ssot set` — the migration that has to be reversible.
 *
 * Every case builds a sandbox with a real junction anchor, so the code under
 * test sees the same file-system shapes as the user's machine.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../../src/cli/router.ts';
import { makeSandbox, norm, readConfigFile, writeSkill, type Sandbox } from '../helpers/sandbox.ts';

interface MigrationBox extends Sandbox {
  oldSsot: string;
  anchor: string;
  claude: string;
}

function makeMigrationBox(): MigrationBox {
  const box = makeSandbox('skillo-ssot-');
  const oldSsot = path.join(box.root, 'ssot-old');
  writeSkill(oldSsot, 'alpha', '---\nname: alpha\n---\nalpha body\n');
  writeSkill(oldSsot, 'beta', '---\nname: beta\n---\nbeta body\n');
  fs.writeFileSync(
    path.join(oldSsot, 'skills-lock.json'),
    JSON.stringify({ skills: { alpha: { source: 'owner/repo' } } }),
    'utf8',
  );

  const anchor = path.join(box.home, '.agents', 'skills');
  fs.mkdirSync(path.dirname(anchor), { recursive: true });
  fs.symlinkSync(oldSsot, anchor, 'junction');

  const claude = path.join(box.home, '.claude', 'skills');
  fs.mkdirSync(claude, { recursive: true });

  assert.equal(runCli(['init'], box.env).exitCode, 0);
  assert.equal(runCli(['link', 'alpha', '--to', 'claude-code'], box.env).exitCode, 0);

  return { ...box, oldSsot, anchor, claude };
}

function backupsOf(box: MigrationBox): string[] {
  return fs.readdirSync(box.root).filter((name) => name.startsWith('ssot-old.migrated-'));
}

describe('skillo ssot set', () => {
  test('copies, verifies, repoints the anchor, and keeps harness links working', () => {
    const box = makeMigrationBox();
    try {
      const target = path.join(box.root, 'ssot-new');
      const result = runCli(['ssot', 'set', target], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /migrated/);

      assert.equal(fs.existsSync(box.oldSsot), false, 'old SSOT leaves its original name');
      assert.equal(norm(readConfigFile(box.home).ssotRoot), norm(target));
      assert.equal(norm(fs.realpathSync(box.anchor)), norm(fs.realpathSync(target)));
      assert.match(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), /alpha body/);

      const slot = path.join(box.claude, 'alpha');
      assert.equal(norm(fs.realpathSync(slot)), norm(path.join(target, 'alpha')));

      assert.equal(backupsOf(box).length, 0, 'the old SSOT must not be left behind');
      assert.match(result.stdout, /Old SSOT\s+deleted/);

      const list = runCli(['list'], box.env);
      assert.equal(list.exitCode, 0, list.stderr);
      assert.doesNotMatch(list.stdout, /needs attention/);
      assert.match(list.stdout, /alpha/);

      const doctor = runCli(['doctor'], box.env);
      assert.equal(doctor.exitCode, 0, doctor.stderr);
    } finally {
      box.cleanup();
    }
  });

  test('--dry-run changes nothing', () => {
    const box = makeMigrationBox();
    try {
      const target = path.join(box.root, 'ssot-new');
      const result = runCli(['ssot', 'set', target, '--dry-run'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /no changes made/);
      assert.match(result.stdout, /old SSOT would be deleted after verification/);
      assert.equal(fs.existsSync(target), false);
      assert.ok(fs.existsSync(box.oldSsot));
      assert.equal(norm(fs.realpathSync(box.anchor)), norm(fs.realpathSync(box.oldSsot)));
      assert.equal(norm(readConfigFile(box.home).ssotRoot), norm(fs.realpathSync(box.oldSsot)));
    } finally {
      box.cleanup();
    }
  });

  test('refuses a non-empty target and leaves both sides untouched', () => {
    const box = makeMigrationBox();
    try {
      const target = path.join(box.root, 'ssot-new');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep.txt'), 'precious', 'utf8');

      const result = runCli(['ssot', 'set', target], box.env);
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /not empty/);
      assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'precious');
      assert.ok(fs.existsSync(path.join(box.oldSsot, 'alpha', 'SKILL.md')));
      assert.equal(norm(readConfigFile(box.home).ssotRoot), norm(fs.realpathSync(box.oldSsot)));
    } finally {
      box.cleanup();
    }
  });

  test('refuses a target inside the current SSOT', () => {
    const box = makeMigrationBox();
    try {
      const result = runCli(['ssot', 'set', path.join(box.oldSsot, 'nested')], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /inside the current SSOT/);
      assert.ok(fs.existsSync(box.oldSsot));
    } finally {
      box.cleanup();
    }
  });

  test('--keep-old retains the previous SSOT as a renamed backup', () => {
    const box = makeMigrationBox();
    try {
      const target = path.join(box.root, 'ssot-new');
      const result = runCli(['ssot', 'set', target, '--keep-old'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(fs.existsSync(box.oldSsot), false);
      const backups = backupsOf(box);
      assert.equal(backups.length, 1);
      assert.match(fs.readFileSync(path.join(box.root, backups[0] ?? '', 'alpha', 'SKILL.md'), 'utf8'), /alpha body/);
      assert.match(result.stdout, /Old SSOT\s+→/);
    } finally {
      box.cleanup();
    }
  });

  test('warns about links that bypass the anchor', () => {
    const box = makeMigrationBox();
    try {
      const slot = path.join(box.claude, 'alpha');
      fs.rmdirSync(slot);
      fs.symlinkSync(path.join(box.oldSsot, 'alpha'), slot, 'junction');

      const result = runCli(['ssot', 'set', path.join(box.root, 'ssot-new'), '--dry-run'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /bypass the anchor/);
    } finally {
      box.cleanup();
    }
  });

  test('requires --yes when the anchor is a real directory, then converts it', () => {
    const box = makeSandbox('skillo-ssot-realdir-');
    try {
      const anchor = path.join(box.home, '.agents', 'skills');
      writeSkill(anchor, 'alpha');
      const claude = path.join(box.home, '.claude', 'skills');
      fs.mkdirSync(claude, { recursive: true });
      assert.equal(runCli(['init'], box.env).exitCode, 0);
      assert.equal(runCli(['link', 'alpha', '--to', 'claude-code'], box.env).exitCode, 0);

      const target = path.join(box.root, 'moved');
      const denied = runCli(['ssot', 'set', target], box.env);
      assert.equal(denied.exitCode, 3);
      assert.match(denied.stderr, /--yes/);
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.lstatSync(anchor).isSymbolicLink(), false);

      const accepted = runCli(['ssot', 'set', target, '--yes'], box.env);
      assert.equal(accepted.exitCode, 0, accepted.stderr);
      assert.equal(fs.lstatSync(anchor).isSymbolicLink(), true);
      assert.equal(norm(fs.realpathSync(anchor)), norm(fs.realpathSync(target)));
      assert.equal(
        norm(fs.realpathSync(path.join(claude, 'alpha'))),
        norm(path.join(target, 'alpha')),
      );

      const leftovers = fs
        .readdirSync(path.join(box.home, '.agents'))
        .filter((name) => name.startsWith('skills.migrated-'));
      assert.equal(leftovers.length, 0, 'converting a real-dir anchor must not leave a backup by default');
    } finally {
      box.cleanup();
    }
  });

  test('reports "not initialized" before touching anything', () => {
    const box = makeSandbox('skillo-ssot-empty-');
    try {
      const target = path.join(box.root, 'target');
      const result = runCli(['ssot', 'set', target], box.env);
      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /not initialized/);
      assert.equal(fs.existsSync(target), false);
    } finally {
      box.cleanup();
    }
  });
});
