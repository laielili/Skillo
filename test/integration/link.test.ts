/**
 * link / unlink / doctor integration tests.
 *
 * Same seam as `cli.test.ts`: everything through `runCli(argv, env)`, asserting
 * on exit codes, output, and the resulting file system state.
 *
 * The case that matters most is `doctor --fix` on a whole-directory junction:
 * it is the only operation that removes an existing link and rewrites an entire
 * harness in one go, so it must leave either the old wiring or a fully populated
 * new one — never an empty directory.
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
  harness(id: string): string;
  addSkill(name: string): string;
  cleanup(): void;
}

const HARNESS_DIRS: Record<string, string> = {
  'claude-code': '.claude',
  workbuddy: '.workbuddy',
  qoder: '.qoder',
  codex: '.codex',
};

function makeBox(harnesses: string[]): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-link-'));
  const home = path.join(root, 'home');
  const ssot = path.join(home, '.agents', 'skills');
  fs.mkdirSync(ssot, { recursive: true });

  for (const id of harnesses) {
    const dir = HARNESS_DIRS[id];
    if (dir === undefined) continue;
    fs.mkdirSync(path.join(home, dir, 'skills'), { recursive: true });
  }

  return {
    root,
    env: { home, cwd: root },
    ssot,
    harness(id: string): string {
      const dir = HARNESS_DIRS[id];
      if (dir === undefined) throw new Error(`no dir for ${id}`);
      return path.join(home, dir, 'skills');
    },
    addSkill(name: string): string {
      const dir = path.join(ssot, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`, 'utf8');
      return dir;
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function init(box: Box): void {
  const result = runCli(['init'], box.env);
  assert.equal(result.exitCode, 0, `init failed: ${result.stderr}`);
}

describe('skillo link', () => {
  test('creates links for every skill in every registered harness', () => {
    const box = makeBox(['claude-code', 'codex']);
    try {
      box.addSkill('alpha');
      box.addSkill('beta');
      init(box);

      const result = runCli(['link', '--all'], box.env);
      assert.equal(result.exitCode, 0);

      for (const id of ['claude-code', 'codex']) {
        for (const skill of ['alpha', 'beta']) {
          const slot = path.join(box.harness(id), skill);
          assert.ok(fs.lstatSync(slot).isSymbolicLink(), `${id}/${skill} should be a link`);
          assert.ok(fs.existsSync(path.join(slot, 'SKILL.md')), `${id}/${skill} should read through`);
        }
      }
    } finally {
      box.cleanup();
    }
  });

  test('is idempotent', () => {
    const box = makeBox(['claude-code']);
    try {
      box.addSkill('alpha');
      init(box);

      runCli(['link', '--all'], box.env);
      const before = fs.readdirSync(box.harness('claude-code')).length;

      const second = runCli(['link', '--all'], box.env);
      assert.equal(second.exitCode, 0);
      assert.match(second.stdout, /skipped-linked/);
      assert.equal(fs.readdirSync(box.harness('claude-code')).length, before);
    } finally {
      box.cleanup();
    }
  });

  test('refuses to displace a real directory and leaves it untouched', () => {
    const box = makeBox(['claude-code']);
    try {
      box.addSkill('alpha');
      init(box);

      const occupied = path.join(box.harness('claude-code'), 'alpha');
      fs.mkdirSync(occupied, { recursive: true });
      fs.writeFileSync(path.join(occupied, 'keep.txt'), 'precious', 'utf8');

      const result = runCli(['link', '--all'], box.env);
      assert.equal(result.exitCode, 5, 'partial failure');
      assert.match(result.stdout, /conflict/);
      assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'precious');
    } finally {
      box.cleanup();
    }
  });

  test('skips links that bypass the anchor unless --replace is given', () => {
    const box = makeBox(['claude-code']);
    try {
      // This case only means anything when the anchor is a junction: if the
      // anchor IS the SSOT, "bypassing" it is indistinguishable from using it.
      fs.rmSync(box.ssot, { recursive: true, force: true });
      const realSsot = path.join(box.root, 'real-ssot');
      fs.mkdirSync(path.join(realSsot, 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(realSsot, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n', 'utf8');
      fs.symlinkSync(realSsot, box.ssot, 'junction');

      init(box);

      const slot = path.join(box.harness('claude-code'), 'alpha');
      fs.symlinkSync(path.join(realSsot, 'alpha'), slot, 'junction');
      assert.equal(fs.readlinkSync(slot), path.join(realSsot, 'alpha'));

      const skipped = runCli(['link', '--all'], box.env);
      assert.match(skipped.stdout, /skipped-foreign/);
      assert.equal(fs.readlinkSync(slot), path.join(realSsot, 'alpha'), 'foreign link untouched without --replace');

      const replaced = runCli(['link', '--all', '--replace'], box.env);
      assert.equal(replaced.exitCode, 0);
      assert.ok(
        fs.readlinkSync(slot).includes(`${path.sep}.agents${path.sep}skills`),
        `expected an anchor-routed target, got ${fs.readlinkSync(slot)}`,
      );
    } finally {
      box.cleanup();
    }
  });

  test('rebuilds a broken link', () => {
    const box = makeBox(['claude-code']);
    try {
      const alpha = box.addSkill('alpha');
      init(box);

      const slot = path.join(box.harness('claude-code'), 'alpha');
      const doomed = path.join(box.root, 'doomed');
      fs.mkdirSync(doomed);
      fs.symlinkSync(doomed, slot, 'junction');
      fs.rmSync(doomed, { recursive: true, force: true });

      const result = runCli(['link', 'alpha'], box.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /replaced-broken/);
      assert.ok(fs.existsSync(path.join(slot, 'SKILL.md')));
      assert.equal(fs.realpathSync(slot), fs.realpathSync(alpha));
    } finally {
      box.cleanup();
    }
  });

  test('--dry-run changes nothing', () => {
    const box = makeBox(['claude-code']);
    try {
      box.addSkill('alpha');
      init(box);

      const result = runCli(['link', '--all', '--dry-run'], box.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /dry-run/);
      assert.deepEqual(fs.readdirSync(box.harness('claude-code')), []);
    } finally {
      box.cleanup();
    }
  });

  test('rejects an unknown skill name', () => {
    const box = makeBox(['claude-code']);
    try {
      box.addSkill('alpha');
      init(box);

      const result = runCli(['link', 'ghost'], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /没有这些技能/);
    } finally {
      box.cleanup();
    }
  });
});

describe('skillo unlink', () => {
  test('removes links and leaves the source untouched', () => {
    const box = makeBox(['claude-code']);
    try {
      const alpha = box.addSkill('alpha');
      init(box);
      runCli(['link', '--all'], box.env);

      const result = runCli(['unlink', 'alpha'], box.env);
      assert.equal(result.exitCode, 0);
      assert.equal(fs.existsSync(path.join(box.harness('claude-code'), 'alpha')), false);
      assert.ok(fs.existsSync(path.join(alpha, 'SKILL.md')), 'source must survive');
    } finally {
      box.cleanup();
    }
  });

  test('refuses to delete a real directory', () => {
    const box = makeBox(['claude-code']);
    try {
      box.addSkill('alpha');
      init(box);

      const occupied = path.join(box.harness('claude-code'), 'alpha');
      fs.mkdirSync(occupied, { recursive: true });

      const result = runCli(['unlink', 'alpha'], box.env);
      assert.equal(result.exitCode, 5);
      assert.ok(fs.existsSync(occupied), 'real directory must survive');
    } finally {
      box.cleanup();
    }
  });
});

describe('skillo doctor', () => {
  test('reports a whole-directory junction instead of blaming every skill', () => {
    const box = makeBox([]);
    try {
      box.addSkill('alpha');
      box.addSkill('beta');
      // Wire claude-code the old way: the skills directory itself is a link.
      const claudeSkills = path.join(box.env.home, '.claude', 'skills');
      fs.mkdirSync(path.dirname(claudeSkills), { recursive: true });
      fs.symlinkSync(box.ssot, claudeSkills, 'junction');

      init(box);

      const result = runCli(['doctor'], box.env);
      assert.match(result.stdout, /skills 目录本身是链接/);
      assert.match(result.stdout, /harness-whole-dir|逐技能链接无法生效/);

      // status should attribute the cause, not just show N conflicts.
      const status = runCli(['status'], box.env);
      assert.match(status.stdout, /skills 目录本身是链接/);
    } finally {
      box.cleanup();
    }
  });

  test('--fix detaches the junction and repopulates with per-skill links', () => {
    const box = makeBox([]);
    try {
      box.addSkill('alpha');
      box.addSkill('beta');
      const claudeSkills = path.join(box.env.home, '.claude', 'skills');
      fs.mkdirSync(path.dirname(claudeSkills), { recursive: true });
      fs.symlinkSync(box.ssot, claudeSkills, 'junction');

      init(box);
      const result = runCli(['doctor', '--fix'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      const st = fs.lstatSync(claudeSkills);
      assert.equal(st.isSymbolicLink(), false, 'harness dir should now be a real directory');

      const entries = fs.readdirSync(claudeSkills).sort();
      assert.deepEqual(entries, ['alpha', 'beta']);

      for (const skill of ['alpha', 'beta']) {
        const slot = path.join(claudeSkills, skill);
        assert.ok(fs.lstatSync(slot).isSymbolicLink(), `${skill} should be a link`);
        assert.ok(fs.existsSync(path.join(slot, 'SKILL.md')));
      }

      // And the result should read as healthy.
      const status = runCli(['status', '--json'], box.env);
      const payload = JSON.parse(status.stdout) as { data: { counts: { problem: number } } };
      assert.equal(payload.data.counts.problem, 0);
    } finally {
      box.cleanup();
    }
  });

  test('--fix never deletes a conflicting real directory', () => {
    const box = makeBox(['claude-code']);
    try {
      box.addSkill('alpha');
      init(box);

      const occupied = path.join(box.harness('claude-code'), 'alpha');
      fs.mkdirSync(occupied, { recursive: true });
      fs.writeFileSync(path.join(occupied, 'keep.txt'), 'precious', 'utf8');

      const result = runCli(['doctor', '--fix'], box.env);
      assert.match(result.stdout, /同名实体目录/);
      assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'precious');
    } finally {
      box.cleanup();
    }
  });

  test('--fix repairs only the affected skills, never widening distribution', () => {
    const box = makeBox(['claude-code']);
    try {
      fs.rmSync(box.ssot, { recursive: true, force: true });
      const realSsot = path.join(box.root, 'real-ssot');
      for (const name of ['alpha', 'beta']) {
        fs.mkdirSync(path.join(realSsot, name), { recursive: true });
        fs.writeFileSync(path.join(realSsot, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
      }
      fs.symlinkSync(realSsot, box.ssot, 'junction');
      init(box);

      // alpha exists but bypasses the anchor; beta will be installed.
      const slotAlpha = path.join(box.harness('claude-code'), 'alpha');
      fs.symlinkSync(path.join(realSsot, 'alpha'), slotAlpha, 'junction');
      const slotBeta = path.join(box.harness('claude-code'), 'beta');
      fs.symlinkSync(path.join(realSsot, 'beta'), slotBeta, 'junction');

      const result = runCli(['doctor', '--fix'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      // Both were foreign, so both get redirected.
      assert.ok(fs.readlinkSync(slotAlpha).includes(`${path.sep}.agents${path.sep}`));
      assert.ok(fs.readlinkSync(slotBeta).includes(`${path.sep}.agents${path.sep}`));
    } finally {
      box.cleanup();
    }
  });

  test('--fix leaves undivided skills undivided', () => {
    const box = makeBox(['claude-code']);
    try {
      fs.rmSync(box.ssot, { recursive: true, force: true });
      const realSsot = path.join(box.root, 'real-ssot');
      for (const name of ['alpha', 'beta']) {
        fs.mkdirSync(path.join(realSsot, name), { recursive: true });
        fs.writeFileSync(path.join(realSsot, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
      }
      fs.symlinkSync(realSsot, box.ssot, 'junction');
      init(box);

      // Only alpha is wired, and it bypasses the anchor.
      const slotAlpha = path.join(box.harness('claude-code'), 'alpha');
      fs.symlinkSync(path.join(realSsot, 'alpha'), slotAlpha, 'junction');

      runCli(['doctor', '--fix'], box.env);

      assert.ok(fs.readlinkSync(slotAlpha).includes(`${path.sep}.agents${path.sep}`), 'alpha repaired');
      assert.equal(
        fs.existsSync(path.join(box.harness('claude-code'), 'beta')),
        false,
        'beta was never distributed and must stay that way',
      );
    } finally {
      box.cleanup();
    }
  });

  test('reports a missing harness directory as fixable', () => {
    const box = makeBox([]);
    try {
      box.addSkill('alpha');
      // Create then remove, so init registers it but the directory is gone.
      fs.mkdirSync(path.join(box.env.home, '.codex', 'skills'), { recursive: true });
      init(box);
      fs.rmSync(path.join(box.env.home, '.codex', 'skills'), { recursive: true, force: true });

      const result = runCli(['doctor', '--fix', 'codex'], box.env);
      assert.equal(result.exitCode, 0);
      assert.ok(fs.existsSync(path.join(box.env.home, '.codex', 'skills')));
    } finally {
      box.cleanup();
    }
  });
});
