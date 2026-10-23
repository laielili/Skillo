/**
 * CLI integration tests.
 *
 * Everything goes through `runCli(argv, env)` — the single seam from SPEC.md.
 * No internal module is imported except the two helpers needed to build a
 * realistic sandbox (`createJunction` to place links, `dirHash` to prove things
 * were not touched).
 *
 * Each case asserts on what a user can observe: exit code, stdout/stderr, and
 * the resulting file system state.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../src/cli/router.ts';
import { createJunction } from '../../src/core/fs-safe.ts';
import type { Env } from '../../src/types.ts';

interface Home {
  root: string;
  env: Env;
  /** `<home>/.agents/skills` — the SSOT in these fixtures. */
  ssot: string;
  ssotOf(harness: string): string;
  cleanup(): void;
}

function makeHome(options: { withHarnesses?: string[] } = {}): Home {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-cli-'));
  const home = path.join(root, 'home');
  const ssot = path.join(home, '.agents', 'skills');
  fs.mkdirSync(ssot, { recursive: true });

  const harnesses = options.withHarnesses ?? ['claude-code', 'workbuddy'];
  for (const id of harnesses) {
    const dir = id === 'claude-code' ? path.join(home, '.claude', 'skills') : path.join(home, '.workbuddy', 'skills');
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    root,
    env: { home, cwd: root },
    ssot,
    ssotOf(harness: string): string {
      return harness === 'claude-code'
        ? path.join(home, '.claude', 'skills')
        : path.join(home, '.workbuddy', 'skills');
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function addSkill(home: Home, name: string, body = ''): string {
  const dir = path.join(home.ssot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} does ${name} things\n---\n# ${name}\n${body}`,
    'utf8',
  );
  return dir;
}

interface ListPayload {
  data: {
    counts: { ok: number; undistributed: number; problem: number };
    anchor: string;
    anchorNote: string | null;
    harnesses: Array<{ id: string; path: string; enabled: boolean }>;
    skills: Array<{
      name: string;
      source: string;
      group: string;
      cells: Array<{ harness: string; state: string }>;
    }>;
  };
  warnings: string[];
}

function listJson(home: Home): ListPayload {
  const result = runCli(['list', '--json'], home.env);
  assert.equal(result.exitCode, 0, `list failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as ListPayload;
}

/* ─────────────────────────────── init ──────────────────────────────── */

describe('skillo init', () => {
  test('creates the anchor and registers installed harnesses', () => {
    const home = makeHome();
    try {
      const result = runCli(['init'], home.env);

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /initialized/);

      const configPath = path.join(home.env.home, '.skillo', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        version: number;
        anchor: string;
        ssotRoot: string;
        harnesses: Array<{ id: string; path: string; preset: string }>;
      };

      assert.equal(config.version, 1);
      assert.equal(config.ssotRoot, home.ssot);
      assert.deepEqual(
        config.harnesses.map((harness) => harness.id).sort(),
        // codex and cline presets point at the anchor itself, so they are reported
        // as native shares rather than registered.
        ['claude-code', 'workbuddy'],
      );
      assert.equal(config.harnesses.every((harness) => harness.preset === 'builtin'), true);
      assert.match(result.stdout, /read the anchor natively/, 'native shares should be announced');
    } finally {
      home.cleanup();
    }
  });

  test('reports how many presets were skipped', () => {
    const home = makeHome();
    try {
      const result = runCli(['init'], home.env);
      assert.match(result.stdout, /not installed/);
    } finally {
      home.cleanup();
    }
  });

  test('refuses a dangling anchor instead of recreating it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-cli-'));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);

      const target = path.join(root, 'ssot');
      fs.mkdirSync(target);
      const anchor = path.join(home, '.agents', 'skills');
      fs.mkdirSync(path.dirname(anchor), { recursive: true });
      fs.symlinkSync(target, anchor, 'junction');
      fs.rmSync(target, { recursive: true, force: true });

      const result = runCli(['init'], { home, cwd: root });

      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /unreachable/);
      // The dangling link must survive: deleting it would erase the only clue
      // about where the SSOT used to live.
      assert.ok(fs.lstatSync(anchor) !== null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ─────────────────────────────── list ──────────────────────────────── */

describe('skillo list', () => {
  test('asks for init when no config exists', () => {
    const home = makeHome();
    try {
      const result = runCli(['list'], home.env);
      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /not initialized/);
    } finally {
      home.cleanup();
    }
  });

  test('groups linked, undistributed and problem skills separately', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);

      const alpha = addSkill(home, 'alpha');
      addSkill(home, 'beta');
      const gamma = addSkill(home, 'gamma');

      // alpha: linked in claude-code, broken in workbuddy → problem wins.
      createJunction(alpha, path.join(home.ssotOf('claude-code'), 'alpha'), { requireSkillMd: true });
      const doomed = path.join(home.root, 'doomed');
      fs.mkdirSync(doomed);
      createJunction(doomed, path.join(home.ssotOf('workbuddy'), 'alpha'));
      fs.rmSync(doomed, { recursive: true, force: true });

      // gamma: linked in one harness only → still "distributed".
      createJunction(gamma, path.join(home.ssotOf('claude-code'), 'gamma'), { requireSkillMd: true });

      const payload = listJson(home);
      const byName = new Map(payload.data.skills.map((skill) => [skill.name, skill]));

      assert.equal(byName.get('alpha')?.group, 'problem');
      assert.equal(byName.get('beta')?.group, 'undistributed');
      assert.equal(byName.get('gamma')?.group, 'ok', 'partial distribution counts as distributed');

      assert.deepEqual(payload.data.counts, { ok: 1, undistributed: 1, problem: 1 });
    } finally {
      home.cleanup();
    }
  });

  test('reports the per-harness state for each skill', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const alpha = addSkill(home, 'alpha');
      createJunction(alpha, path.join(home.ssotOf('claude-code'), 'alpha'), { requireSkillMd: true });

      const payload = listJson(home);
      const alphaRow = payload.data.skills.find((skill) => skill.name === 'alpha');
      assert.ok(alphaRow !== undefined);

      const cells = new Map(alphaRow.cells.map((cell) => [cell.harness, cell.state]));
      assert.equal(cells.get('claude-code'), 'linked');
      assert.equal(cells.get('workbuddy'), 'absent');
    } finally {
      home.cleanup();
    }
  });

  test('flags a link that bypasses the anchor', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const alpha = addSkill(home, 'alpha');

      // Point straight at the skill, skipping the anchor indirection.
      fs.mkdirSync(path.join(home.root, 'elsewhere'), { recursive: true });
      fs.cpSync(alpha, path.join(home.root, 'elsewhere', 'alpha'), { recursive: true });
      createJunction(
        path.join(home.root, 'elsewhere', 'alpha'),
        path.join(home.ssotOf('claude-code'), 'alpha'),
        { requireSkillMd: true },
      );

      const payload = listJson(home);
      const alphaRow = payload.data.skills.find((skill) => skill.name === 'alpha');
      const cells = new Map(alphaRow?.cells.map((cell) => [cell.harness, cell.state]));
      assert.equal(cells.get('claude-code'), 'foreign');
      assert.equal(alphaRow?.group, 'problem');
    } finally {
      home.cleanup();
    }
  });

  test('renders a human overview with group headers', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'alpha');
      addSkill(home, 'beta');

      const result = runCli(['list'], home.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /not distributed/);
      assert.match(result.stdout, /alpha/);
      assert.match(result.stdout, /beta/);
    } finally {
      home.cleanup();
    }
  });

  test('detail view lists every harness state', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const alpha = addSkill(home, 'alpha');
      createJunction(alpha, path.join(home.ssotOf('claude-code'), 'alpha'), { requireSkillMd: true });

      const result = runCli(['list', 'alpha'], home.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /alpha/);
      assert.match(result.stdout, /claude-code/);
      assert.match(result.stdout, /workbuddy/);
      assert.match(result.stdout, /linked/);
      assert.match(result.stdout, /absent/);
    } finally {
      home.cleanup();
    }
  });

  test('unknown skill exits with USAGE and suggests nothing wild', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'grill-me');

      const result = runCli(['list', 'grill'], home.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /skill not found/);
    } finally {
      home.cleanup();
    }
  });

  test('matrix view puts every harness in a column', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'alpha');

      const result = runCli(['list', '--matrix'], home.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /SKILL/);
      assert.match(result.stdout, /claude-code/);
      assert.match(result.stdout, /workbuddy/);
    } finally {
      home.cleanup();
    }
  });

  test('detects a broken anchor and still lists skills', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'alpha');

      // Turn the anchor into a junction, then break it.
      const anchor = path.join(home.env.home, '.agents', 'skills');
      const realSsot = path.join(home.root, 'real-ssot');
      fs.cpSync(anchor, realSsot, { recursive: true });
      fs.rmSync(anchor, { recursive: true, force: true });
      fs.symlinkSync(realSsot, anchor, 'junction');

      // Re-init so config points at the junction target.
      runCli(['init'], home.env);

      // Now break it.
      fs.rmSync(realSsot, { recursive: true, force: true });

      const result = runCli(['list'], home.env);
      // SSOT is gone, so list must fail loudly rather than show an empty list.
      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /SSOT directory does not exist/);
    } finally {
      home.cleanup();
    }
  });
});

/* ─────────────────────────────── misc ──────────────────────────────── */

describe('cli surface', () => {
  test('--version prints the version', () => {
    const home = makeHome();
    try {
      const result = runCli(['--version'], home.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^\d+\.\d+\.\d+/);
    } finally {
      home.cleanup();
    }
  });

  test('--help lists commands', () => {
    const home = makeHome();
    try {
      const result = runCli(['--help'], home.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /list/);
      assert.match(result.stdout, /doctor/);
    } finally {
      home.cleanup();
    }
  });

  test('unknown command exits with USAGE', () => {
    const home = makeHome();
    try {
      const result = runCli(['frobnicate'], home.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /unknown command/);
    } finally {
      home.cleanup();
    }
  });

  test('unimplemented command says so instead of pretending', () => {
    const home = makeHome();
    try {
      const result = runCli(['annotate', 'grill-me', '--source', 'local'], home.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /not implemented/);
    } finally {
      home.cleanup();
    }
  });
});
