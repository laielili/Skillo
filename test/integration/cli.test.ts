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

/* ─────────────────────────── list --harness ─────────────────────────── */

function addHarnessSkill(home: Home, harnessId: string, name: string): string {
  const dir = path.join(home.ssotOf(harnessId), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`, 'utf8');
  return dir;
}

describe('skillo list --harness', () => {
  test('shows the real directories the SSOT has never seen', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const alpha = addSkill(home, 'alpha');
      createJunction(alpha, path.join(home.ssotOf('workbuddy'), 'alpha'), { requireSkillMd: true });
      addHarnessSkill(home, 'workbuddy', 'cloudflare');

      const result = runCli(['list', '--harness', 'workbuddy'], home.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /adoptable \(1\)/);
      assert.match(result.stdout, /cloudflare/);
      assert.match(result.stdout, /linked \(1\)/);
      assert.match(result.stdout, /alpha/);
      assert.match(result.stdout, /skillo adopt workbuddy/);
    } finally {
      home.cleanup();
    }
  });

  test('separates a clean adoption from one that needs --keep', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'beta');
      addHarnessSkill(home, 'workbuddy', 'beta');
      addHarnessSkill(home, 'workbuddy', 'cloudflare');

      const result = runCli(['list', '--harness', 'workbuddy'], home.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /○ adoptable \(1\)/);
      assert.match(result.stdout, /^ {4}cloudflare/m);
      assert.match(result.stdout, /! needs a decision \(1\)/);
      assert.match(result.stdout, /^ {4}beta/m);
    } finally {
      home.cleanup();
    }
  });

  test('names the problems a link cannot carry', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const alpha = addSkill(home, 'alpha');
      createJunction(alpha, path.join(home.ssotOf('workbuddy'), 'alpha'), { requireSkillMd: true });
      // Point the link somewhere the SSOT does not have.
      fs.rmSync(path.join(home.ssotOf('workbuddy'), 'alpha'), { recursive: true, force: true });
      fs.symlinkSync(path.join(home.root, 'nowhere'), path.join(home.ssotOf('workbuddy'), 'alpha'), 'junction');
      fs.writeFileSync(path.join(home.ssotOf('workbuddy'), 'notes.txt'), 'not a skill', 'utf8');

      const result = runCli(['list', '--harness', 'workbuddy'], home.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /needs attention \(2\)/);
      assert.match(result.stdout, /alpha\s+broken/);
      assert.match(result.stdout, /notes\.txt\s+invalid/);
    } finally {
      home.cleanup();
    }
  });

  test('a native harness has nothing to adopt', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'alpha');
      const added = runCli(['harness', 'add', 'my-tool', '--path', home.ssot], home.env);
      assert.equal(added.exitCode, 0, added.stderr);

      const result = runCli(['list', '--harness', 'my-tool'], home.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /reads the anchor natively/);
      assert.match(result.stdout, /✓ in the SSOT \(1\)/);
      assert.match(result.stdout, /^ {4}alpha/m);
      assert.doesNotMatch(result.stdout, /skillo adopt/);
    } finally {
      home.cleanup();
    }
  });

  test('--json reports the raw facts, not the grouping', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'beta');
      addHarnessSkill(home, 'workbuddy', 'beta');

      const result = runCli(['list', '--harness', 'workbuddy', '--json'], home.env);
      assert.equal(result.exitCode, 0, result.stderr);
      const payload = JSON.parse(result.stdout) as {
        data: {
          harness: { id: string; native: boolean };
          entries: Array<{ name: string; state: string; native: boolean; inSsot: boolean; target: string | null; sizeBytes: number | null }>;
        };
      };
      assert.equal(payload.data.harness.id, 'workbuddy');
      assert.equal(payload.data.harness.native, false);
      assert.equal(payload.data.entries.length, 1);
      const beta = payload.data.entries[0];
      assert.equal(beta?.name, 'beta');
      assert.equal(beta?.state, 'conflict');
      assert.equal(beta?.inSsot, true);
      assert.equal(beta?.target, null);
      assert.notEqual(beta?.sizeBytes, null, 'a real directory has a size');
    } finally {
      home.cleanup();
    }
  });

  test('refuses the views that cannot be combined', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);

      const bare = runCli(['list', '--harness'], home.env);
      assert.equal(bare.exitCode, 2);
      assert.match(bare.stderr, /needs a harness id/);

      const withSkill = runCli(['list', 'alpha', '--harness', 'workbuddy'], home.env);
      assert.equal(withSkill.exitCode, 2);
      assert.match(withSkill.stderr, /whole directory/);

      const withMatrix = runCli(['list', '--harness', 'workbuddy', '--matrix'], home.env);
      assert.equal(withMatrix.exitCode, 2);
      assert.match(withMatrix.stderr, /cannot be combined/);
    } finally {
      home.cleanup();
    }
  });

  test('an unregistered harness says so, a missing directory does not throw', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);

      const unknown = runCli(['list', '--harness', 'nope'], home.env);
      assert.equal(unknown.exitCode, 2);
      assert.match(unknown.stderr, /unknown harness: nope/);

      fs.rmSync(home.ssotOf('workbuddy'), { recursive: true, force: true });
      const missing = runCli(['list', '--harness', 'workbuddy'], home.env);
      assert.equal(missing.exitCode, 0, missing.stderr);
      assert.match(missing.stdout, /directory does not exist/);
      assert.match(missing.stdout, /no skills in/);
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

  test('unknown ssot subcommand is a usage error', () => {
    const home = makeHome();
    try {
      const result = runCli(['ssot', 'move', 'somewhere'], home.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /unknown ssot subcommand/);
    } finally {
      home.cleanup();
    }
  });

  test('--version matches package.json', () => {
    const home = makeHome();
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
      const result = runCli(['--version'], home.env);
      assert.equal(result.stdout.trim(), pkg.version);
    } finally {
      home.cleanup();
    }
  });

  test('a corrupt config is reported and never overwritten', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const file = path.join(home.env.home, '.skillo', 'config.json');
      fs.writeFileSync(file, '{ definitely not json', 'utf8');

      const result = runCli(['list'], home.env);
      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /not valid JSON/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{ definitely not json');
    } finally {
      home.cleanup();
    }
  });

  test('--json turns errors into a machine-readable envelope', () => {
    const home = makeHome();
    try {
      const result = runCli(['list', '--json'], home.env);
      assert.equal(result.exitCode, 4);
      assert.equal(result.stderr, '');
      const payload = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'ENV');
      assert.match(payload.error.message, /not initialized/);
    } finally {
      home.cleanup();
    }
  });

  test('detail view shows both the SSOT path and the anchor path', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'alpha');

      const result = runCli(['list', 'alpha'], home.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /SKILL/);
      assert.match(result.stdout, /ANCHOR/);
      assert.match(result.stdout, /\.agents[\\/]skills[\\/]alpha/);

      const payload = JSON.parse(runCli(['list', 'alpha', '--json'], home.env).stdout) as {
        data: { anchorPath: string };
      };
      assert.match(payload.data.anchorPath, /\.agents[\\/]skills[\\/]alpha/);
    } finally {
      home.cleanup();
    }
  });

  test('problem groups render before healthy groups', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      addSkill(home, 'alpha');
      addSkill(home, 'beta');
      runCli(['link', 'alpha'], home.env);
      fs.mkdirSync(path.join(home.ssotOf('claude-code'), 'beta'), { recursive: true });

      const result = runCli(['list'], home.env);
      const problem = result.stdout.indexOf('needs attention');
      const healthy = result.stdout.indexOf('distributed (');
      assert.ok(problem >= 0, 'problem header should exist');
      assert.ok(healthy >= 0, 'healthy header should exist');
      assert.ok(problem < healthy, 'problems must come first');
    } finally {
      home.cleanup();
    }
  });

  test('annotate records provenance while the lock file still outranks it', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const alpha = addSkill(home, 'alpha');

      const missing = runCli(['annotate', 'alpha'], home.env);
      assert.equal(missing.exitCode, 2);

      const annotated = runCli(['annotate', 'alpha', '--source', 'market', '--origin', 'skillhub:alpha'], home.env);
      assert.equal(annotated.exitCode, 0, annotated.stderr);

      let payload = JSON.parse(runCli(['list', 'alpha', '--json'], home.env).stdout) as {
        data: { source: string; origin: string | null };
      };
      assert.equal(payload.data.source, 'market');
      assert.equal(payload.data.origin, 'skillhub:alpha');

      fs.writeFileSync(
        path.join(home.ssot, 'skills-lock.json'),
        JSON.stringify({ skills: { alpha: { source: 'owner/repo' } } }),
        'utf8',
      );
      payload = JSON.parse(runCli(['list', 'alpha', '--json'], home.env).stdout) as {
        data: { source: string; origin: string | null };
      };
      assert.equal(payload.data.source, 'git');
      assert.equal(payload.data.origin, 'owner/repo');

      fs.rmSync(path.join(home.ssot, 'skills-lock.json'));
      fs.writeFileSync(path.join(alpha, '_skillhub_meta.json'), JSON.stringify({ skillId: 'alpha-id' }), 'utf8');
      payload = JSON.parse(runCli(['list', 'alpha', '--json'], home.env).stdout) as {
        data: { source: string; origin: string | null };
      };
      assert.equal(payload.data.source, 'market');
      assert.equal(payload.data.origin, 'alpha-id');
    } finally {
      home.cleanup();
    }
  });

  test('re-running init preserves harnesses added by hand', () => {
    const home = makeHome();
    try {
      runCli(['init'], home.env);
      const custom = path.join(home.root, 'custom-skills');
      fs.mkdirSync(custom, { recursive: true });
      const added = runCli(['harness', 'add', 'custom-one', '--path', custom, '--name', 'Custom One'], home.env);
      assert.equal(added.exitCode, 0, added.stderr);

      const again = runCli(['init'], home.env);
      assert.equal(again.exitCode, 0, again.stderr);

      const config = JSON.parse(
        fs.readFileSync(path.join(home.env.home, '.skillo', 'config.json'), 'utf8'),
      ) as { harnesses: Array<{ id: string; name: string; path: string }> };
      const kept = config.harnesses.find((harness) => harness.id === 'custom-one');
      assert.equal(kept?.name, 'Custom One');
      assert.equal(kept?.path, path.resolve(custom));
    } finally {
      home.cleanup();
    }
  });
});
