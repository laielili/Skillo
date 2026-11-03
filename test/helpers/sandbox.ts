/**
 * Shared sandbox for integration tests.
 *
 * Every case gets a throwaway root under the OS temp directory, so tests never
 * touch the real user profile. Cleanup is the one place tests are allowed to
 * delete recursively: it only ever targets the directory this helper created.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Env } from '../../src/types.ts';

export interface Sandbox {
  root: string;
  home: string;
  env: Env;
  cleanup(): void;
}

export function makeSandbox(prefix = 'skillo-test-'): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    env: { home, cwd: root },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Create a skill directory with a minimal SKILL.md. */
export function writeSkill(root: string, name: string, body?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body ?? `---\nname: ${name}\n---\n`, 'utf8');
  return dir;
}

/** Case-insensitive comparison helper for Windows paths. */
export function norm(target: string): string {
  return path.resolve(target).toLowerCase();
}

export function readConfigFile(home: string): { anchor: string; ssotRoot: string; harnesses: Array<{ id: string; path: string }> } {
  return JSON.parse(fs.readFileSync(path.join(home, '.skillo', 'config.json'), 'utf8')) as {
    anchor: string;
    ssotRoot: string;
    harnesses: Array<{ id: string; path: string }>;
  };
}
