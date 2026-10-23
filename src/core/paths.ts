/**
 * Path helpers. Pure functions only — no file system access, so the whole
 * module is unit-testable without a sandbox.
 *
 * Windows specifics matter here: paths are case-insensitive, junctions require
 * absolute non-UNC targets, and `..` traversal is the difference between
 * "delete a link" and "delete the source tree".
 */

import path from 'node:path';
import type { Env } from '../types.ts';

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(input: string, home: string): string {
  if (input === '~') return path.resolve(home);
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.resolve(home, input.slice(2));
  }
  return path.resolve(input);
}

/** Windows path comparison is case-insensitive; normalise before comparing. */
function forCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * Uses `path.relative` rather than string prefixing so that `D:\skills-old`
 * is NOT considered inside `D:\skills`, and rejects any `..` segment so that a
 * crafted name cannot escape the boundary check.
 */
export function isInside(parent: string, child: string): boolean {
  const p = forCompare(parent);
  const c = forCompare(child);
  if (p === c) return true;

  const rel = path.relative(p, c);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;

  return !rel.split(/[\\/]/).includes('..');
}

/** True when two paths refer to the same location (case-insensitively on Windows). */
export function samePath(a: string, b: string): boolean {
  return forCompare(a) === forCompare(b);
}

/**
 * True for `\\server\share` style paths. Junction targets cannot be UNC —
 * Windows returns ERROR_INVALID_PARAMETER, and it is better to reject up front
 * than to surface a cryptic OS error later.
 */
export function isUnc(p: string): boolean {
  return /^\\\\[^\\]+\\/.test(p) || /^\/\/[^/]+\//.test(p);
}

/** Render a path with the home directory abbreviated to `~`, for output only. */
export function toDisplay(p: string, env: Env): string {
  const resolved = path.resolve(p);
  if (isInside(env.home, resolved)) {
    const rel = path.relative(path.resolve(env.home), resolved);
    return rel === '' ? '~' : `~${path.sep}${rel}`;
  }
  return resolved;
}

/** `~/.skillo` config directory for the given environment. */
export function skilloHome(env: Env): string {
  return path.join(env.home, '.skillo');
}

/** Full path of the main config file. */
export function configFile(env: Env): string {
  return path.join(skilloHome(env), 'config.json');
}

/** Full path of the annotations file (manual source provenance). */
export function annotationsFile(env: Env): string {
  return path.join(skilloHome(env), 'annotations.json');
}

/** Default anchor location: the shared directory `npx skills` also writes to. */
export function defaultAnchor(env: Env): string {
  return path.join(env.home, '.agents', 'skills');
}
