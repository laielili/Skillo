/**
 * harness registry integration tests.
 *
 * The registry exists because a built-in preset table is always incomplete. These
 * cases check that adding a harness is possible without hand-editing JSON, and
 * that removing one never touches files.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../src/cli/router.ts';
import type { Env } from '../../src/types.ts';

interface ConfigShape {
  harnesses: Array<{ id: string; path: string; preset: string; name: string }>;
}

interface Box {
  root: string;
  env: Env;
  config(): ConfigShape;
  cleanup(): void;
}

function makeBox(): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-harness-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });

  return {
    root,
    env: { home, cwd: root },
    config(): ConfigShape {
      const file = path.join(home, '.skillo', 'config.json');
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ConfigShape;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function init(box: Box): void {
  const result = runCli(['init'], box.env);
  assert.equal(result.exitCode, 0, result.stderr);
}

describe('skillo harness list', () => {
  test('lists registered harnesses and presets whose directory exists', () => {
    const box = makeBox();
    try {
      // qoder exists on disk but will not be registered by init in this fixture
      // only if created after init — so create it after.
      init(box);
      fs.mkdirSync(path.join(box.env.home, '.qoder', 'skills'), { recursive: true });

      const result = runCli(['harness', 'list'], box.env);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /已注册/);
      assert.match(result.stdout, /claude-code/);
      assert.match(result.stdout, /可添加/);
      assert.match(result.stdout, /qoder/);
    } finally {
      box.cleanup();
    }
  });

  test('defaults to list when no subcommand is given', () => {
    const box = makeBox();
    try {
      init(box);
      const withSub = runCli(['harness', 'list'], box.env);
      const withoutSub = runCli(['harness'], box.env);
      assert.equal(withoutSub.exitCode, 0);
      assert.equal(withoutSub.stdout, withSub.stdout);
    } finally {
      box.cleanup();
    }
  });
});

describe('skillo harness add', () => {
  test('adds a built-in preset by id alone', () => {
    const box = makeBox();
    try {
      init(box);

      const result = runCli(['harness', 'add', 'cursor'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /已添加/);

      const entry = box.config().harnesses.find((harness) => harness.id === 'cursor');
      assert.ok(entry !== undefined, 'cursor should be registered');
      assert.equal(entry?.preset, 'builtin');
      assert.equal(entry?.name, 'Cursor');
      assert.ok(fs.existsSync(entry?.path ?? ''), 'preset directory should be created');
    } finally {
      box.cleanup();
    }
  });

  test('adds a custom harness from an explicit path', () => {
    const box = makeBox();
    try {
      init(box);
      const custom = path.join(box.root, 'my-tool', 'skills');

      const result = runCli(['harness', 'add', 'my-tool', '--path', custom, '--name', 'My Tool'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      const entry = box.config().harnesses.find((harness) => harness.id === 'my-tool');
      assert.equal(entry?.preset, 'custom');
      assert.equal(entry?.name, 'My Tool');
      assert.equal(entry?.path, path.resolve(custom));
      assert.ok(fs.existsSync(custom), 'directory should be created');
    } finally {
      box.cleanup();
    }
  });

  test('marks a preset added with an explicit path as overridden', () => {
    const box = makeBox();
    try {
      init(box);
      const custom = path.join(box.root, 'cursor-alt');

      const result = runCli(['harness', 'add', 'cursor', '--path', custom], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      const entry = box.config().harnesses.find((harness) => harness.id === 'cursor');
      assert.equal(entry?.preset, 'overridden');
    } finally {
      box.cleanup();
    }
  });

  test('rejects a duplicate id', () => {
    const box = makeBox();
    try {
      init(box);
      const result = runCli(['harness', 'add', 'claude-code'], box.env);
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /已注册/);
    } finally {
      box.cleanup();
    }
  });

  test('rejects an unknown id without a path and names the presets', () => {
    const box = makeBox();
    try {
      init(box);
      const result = runCli(['harness', 'add', 'nonsense'], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /需要 --path/);
      assert.match(result.stderr, /claude-code/);
    } finally {
      box.cleanup();
    }
  });

  test('rejects an id with characters that would break paths', () => {
    const box = makeBox();
    try {
      init(box);
      const result = runCli(['harness', 'add', 'My Tool/../x', '--path', box.root], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /只能包含/);
    } finally {
      box.cleanup();
    }
  });

  test('a harness added this way can be linked to immediately', () => {
    const box = makeBox();
    try {
      fs.mkdirSync(path.join(box.env.home, '.agents', 'skills', 'alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(box.env.home, '.agents', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\n---\n',
        'utf8',
      );
      init(box);

      const custom = path.join(box.root, 'brand-new', 'skills');
      runCli(['harness', 'add', 'brand-new', '--path', custom], box.env);
      const linked = runCli(['link', 'alpha', '--to', 'brand-new'], box.env);
      assert.equal(linked.exitCode, 0, linked.stderr);
      assert.ok(fs.lstatSync(path.join(custom, 'alpha')).isSymbolicLink());
    } finally {
      box.cleanup();
    }
  });
});

describe('native harnesses (skills dir == anchor)', () => {
  test('are reported at the top, never in the agent column, and never linked', () => {
    const box = makeBox();
    try {
      const skillsRoot = path.join(box.env.home, '.agents', 'skills');
      for (const name of ['alpha', 'beta']) {
        fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
        fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
      }
      init(box);

      // A harness whose skills directory IS the anchor.
      const added = runCli(['harness', 'add', 'shared', '--path', skillsRoot], box.env);
      assert.equal(added.exitCode, 0, added.stderr);

      const list = runCli(['list'], box.env);
      assert.equal(list.exitCode, 0, list.stderr);
      assert.match(list.stdout, /原生读取锚点/, 'top-line notice should be present');
      assert.match(list.stdout, /shared/);

      const payload = JSON.parse(runCli(['list', '--json'], box.env).stdout) as {
        data: {
          nativeHarnesses: string[];
          counts: { problem: number };
          skills: Array<{ name: string; cells: Array<{ harness: string; state: string }> }>;
        };
      };

      assert.deepEqual(payload.data.nativeHarnesses, ['shared']);
      assert.equal(payload.data.counts.problem, 0, 'a native harness must not create conflicts');

      const alpha = payload.data.skills.find((skill) => skill.name === 'alpha');
      const sharedCell = alpha?.cells.find((cell) => cell.harness === 'shared');
      assert.equal(sharedCell?.state, 'linked', 'skills count as configured on a native harness');
    } finally {
      box.cleanup();
    }
  });

  test('are left alone by doctor and refused by link', () => {
    const box = makeBox();
    try {
      const skillsRoot = path.join(box.env.home, '.agents', 'skills');
      fs.mkdirSync(path.join(skillsRoot, 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n', 'utf8');
      init(box);
      runCli(['harness', 'add', 'shared', '--path', skillsRoot], box.env);

      const doc = runCli(['doctor', 'shared'], box.env);
      assert.equal(doc.exitCode, 0, doc.stderr);
      assert.match(doc.stdout, /原生读取锚点/);

      const link = runCli(['link', 'alpha', '--to', 'shared'], box.env);
      assert.equal(link.exitCode, 2);
      assert.match(link.stderr, /无需链接/);

      // Nothing should have been written into the anchor itself.
      assert.deepEqual(fs.readdirSync(skillsRoot), ['alpha']);
    } finally {
      box.cleanup();
    }
  });

  test('is detected through a junction anchor as well', () => {
    const box = makeBox();
    try {
      const realSsot = path.join(box.root, 'real-ssot');
      fs.mkdirSync(path.join(realSsot, 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(realSsot, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n', 'utf8');

      const anchorPath = path.join(box.env.home, '.agents', 'skills');
      fs.rmSync(anchorPath, { recursive: true, force: true });
      fs.symlinkSync(realSsot, anchorPath, 'junction');
      init(box);

      // Registered against the junction path.
      runCli(['harness', 'add', 'via-junction', '--path', anchorPath], box.env);
      // Registered against the resolved path.
      runCli(['harness', 'add', 'via-real', '--path', realSsot], box.env);

      const payload = JSON.parse(runCli(['list', '--json'], box.env).stdout) as {
        data: { nativeHarnesses: string[] };
      };
      assert.deepEqual(payload.data.nativeHarnesses.sort(), ['via-junction', 'via-real']);
    } finally {
      box.cleanup();
    }
  });
});

describe('skillo harness remove', () => {
  test('unregisters without touching the directory', () => {
    const box = makeBox();
    try {
      init(box);
      const claudePath = path.join(box.env.home, '.claude', 'skills');
      fs.mkdirSync(path.join(claudePath, 'kept'), { recursive: true });

      const result = runCli(['harness', 'remove', 'claude-code'], box.env);
      assert.equal(result.exitCode, 0, result.stderr);

      assert.equal(
        box.config().harnesses.some((harness) => harness.id === 'claude-code'),
        false,
        'should be unregistered',
      );
      assert.ok(fs.existsSync(path.join(claudePath, 'kept')), 'files must survive');
    } finally {
      box.cleanup();
    }
  });

  test('reports an unknown id', () => {
    const box = makeBox();
    try {
      init(box);
      const result = runCli(['harness', 'remove', 'ghost'], box.env);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /未注册/);
    } finally {
      box.cleanup();
    }
  });
});
