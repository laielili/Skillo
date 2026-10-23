/**
 * Every dangerous file system operation lives here, and nowhere else.
 *
 * Three failure modes drove this design:
 *   1. `symlinkSync(src, dst, 'dir')` silently creates an empty directory when
 *      the process lacks privilege. No throw, no warning.
 *   2. `rmSync(link, { recursive: true })` follows the link and deletes the
 *      SOURCE tree.
 *   3. `realpathSync` throws ENOENT on a dangling link, so naive scans crash.
 *
 * Every mutating function is therefore written as
 *   precondition → operate → verify → roll back on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { conflictError, envError } from '../util/errors.ts';
import { isInside, isUnc, samePath } from './paths.ts';
import type { RelationState } from '../types.ts';

/* ────────────────────────────── probing ────────────────────────────── */

/**
 * `lstat` that returns null instead of throwing.
 *
 * Use this — never `fs.existsSync` — to decide whether an entry exists.
 * `existsSync` returns false for a dangling link, which would make a broken
 * link look like an empty slot and send `createJunction` into a confusing
 * "already exists" error.
 */
export function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** `realpath` that returns null on any resolution failure. */
export function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Read a link's raw target without resolving it.
 *
 * Unlike `realpath`, this still works on a dangling link — which is what makes
 * a useful diagnostic ("used to point at X") possible.
 */
export function readlinkOrNull(target: string): string | null {
  try {
    return fs.readlinkSync(target);
  } catch {
    return null;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** True when the entry is a junction or symlink (both report as links under lstat). */
export function isLink(target: string): boolean {
  const st = lstatOrNull(target);
  return st !== null && st.isSymbolicLink();
}

/* ──────────────────────────── classification ───────────────────────── */

export interface ClassifyOptions {
  /** Resolved real path of the anchor, or null when it cannot be resolved. */
  anchorReal: string | null;
  /**
   * Anchor path as configured. When the anchor is itself a junction this differs
   * from `anchorReal`, and the difference is exactly what separates a link that
   * routes through the anchor from one that points straight at the SSOT.
   */
  anchorPath?: string;
}

/**
 * Classify a single skill entry inside a harness directory.
 *
 * Order matters. Readability is checked before the anchor comparison so that a
 * link pointing at a broken external directory reports `broken` (actionable:
 * rebuild) rather than `foreign` (actionable: redirect — which would not help).
 */
export function classifyEntry(entryPath: string, options: ClassifyOptions): RelationState {
  const st = lstatOrNull(entryPath);
  if (st === null) return 'absent';

  // A plain directory here is not a link at all. That covers two situations:
  // a skill copied in by hand, and every entry under a harness directory that is
  // itself a whole-directory link. Both need `adopt`; neither is manageable until
  // then, so both are reported as `conflict`.
  if (!st.isSymbolicLink()) {
    return st.isDirectory() ? 'conflict' : 'invalid';
  }

  const resolved = realpathOrNull(entryPath);
  if (resolved === null) return 'broken';
  if (!isFile(path.join(entryPath, 'SKILL.md'))) return 'broken';

  const { anchorReal, anchorPath } = options;
  if (anchorReal === null) return 'foreign';
  // Compare the RESOLVED target against the anchor. The entry path itself sits
  // inside the harness directory, so using it here would classify every healthy
  // link as foreign.
  if (!isInside(anchorReal, resolved)) return 'foreign';

  if (anchorPath !== undefined && !samePath(anchorPath, anchorReal)) {
    const raw = readlinkOrNull(entryPath);
    // A link that skips the anchor still resolves correctly today, but breaks the
    // moment the SSOT moves. That is the silent failure `foreign` exists to catch.
    if (raw !== null && !isInside(anchorPath, raw)) return 'foreign';
  }

  return 'linked';
}

/* ──────────────────────────── link mutation ───────────────────────── */

export interface CreateJunctionOptions {
  /** Replace an existing link whose target is unreachable. */
  allowReplaceBroken?: boolean;
  /** Also require a readable SKILL.md behind the new link. */
  requireSkillMd?: boolean;
}

/**
 * Create a Windows directory junction. The only permitted way to make a link.
 *
 * Junctions are used rather than symbolic links on purpose: creating a symlink
 * needs Administrator rights or Developer Mode, and Node's failure mode when
 * lacking them is silent — it leaves an empty directory behind.
 */
export function createJunction(
  target: string,
  linkPath: string,
  options: CreateJunctionOptions = {},
): void {
  /* ── preconditions ── */
  if (!path.isAbsolute(linkPath)) {
    throw envError(`link path must be absolute: ${linkPath}`);
  }
  if (isUnc(target)) {
    throw envError(
      `junctions do not support UNC paths: ${target}`,
      'put the SSOT on a local disk, or use a mapped drive letter instead of a network path',
    );
  }

  const targetStat = lstatOrNull(target);
  if (targetStat === null) {
    throw envError(`link target does not exist: ${target}`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw envError(`link target is not a directory: ${target}`);
  }

  const parentDir = path.dirname(linkPath);
  if (!isDirectory(parentDir)) {
    throw envError(`parent directory does not exist: ${parentDir}`, 'create the harness directory first, or run skillo doctor --fix');
  }

  const existing = lstatOrNull(linkPath);
  if (existing !== null) {
    const isDanglingLink = existing.isSymbolicLink() && realpathOrNull(linkPath) === null;
    if (!(isDanglingLink && options.allowReplaceBroken === true)) {
      throw conflictError(
        `destination already occupied: ${linkPath}`,
        existing.isSymbolicLink()
          ? 'it is a link and its target is reachable; to replace it use the owning command or doctor --fix'
          : 'it is a real directory; use skillo adopt to bring it into the SSOT',
      );
    }
    removeJunction(linkPath);
  }

  /* ── operate ── */
  fs.symlinkSync(target, linkPath, 'junction');

  /* ── verify (symlinkSync's success signal is not trustworthy) ── */
  try {
    const created = lstatOrNull(linkPath);
    if (created === null || !created.isSymbolicLink()) {
      throw new Error('entry is not a link after creation (it may have degraded into an empty directory)');
    }

    // Compare FULLY RESOLVED paths on both sides. `target` is frequently
    // `<anchor>/<skill>`, and the anchor is usually a junction — so comparing the
    // raw target string against the link's resolved path reports a mismatch on
    // every healthy link.
    const resolved = realpathOrNull(linkPath);
    const expected = realpathOrNull(target);
    if (resolved === null || expected === null || !samePath(resolved, expected)) {
      throw new Error(
        `link points somewhere unexpected: wanted ${expected ?? target}, got ${resolved ?? '(unresolvable)'}`,
      );
    }
    if (options.requireSkillMd === true && !isFile(path.join(linkPath, 'SKILL.md'))) {
      throw new Error('link is unreadable: missing SKILL.md');
    }
  } catch (err) {
    rollbackLink(linkPath);
    throw envError(
      `failed to create link, rolled back: ${linkPath}`,
      'if this is a permissions problem, check that the target directory is writable; if paths are too long, shorten the SSOT path',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Delete a junction. Refuses anything that is not a link.
 *
 * Uses `rmdir`, never `rm -r`: a recursive delete follows the link and takes
 * the source tree with it.
 */
export function removeJunction(linkPath: string): void {
  const st = lstatOrNull(linkPath);
  if (st === null) return;
  if (!st.isSymbolicLink()) {
    throw conflictError(
      `refusing to delete: ${linkPath} is not a link`,
      'Skillo only deletes links it created. Handle real directories by hand',
    );
  }
  fs.rmdirSync(linkPath);
}

/** Remove a partially created link without ever recursing. */
function rollbackLink(linkPath: string): void {
  const st = lstatOrNull(linkPath);
  if (st === null) return;
  try {
    if (st.isSymbolicLink()) {
      fs.rmdirSync(linkPath);
    } else if (st.isDirectory()) {
      // Only an empty directory can get here (the silent-failure artifact).
      fs.rmdirSync(linkPath);
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch {
    // Rollback is best effort; the caller already reports the original failure.
  }
}

/* ────────────────────────────── copying ───────────────────────────── */

export interface CopyTreeResult {
  copiedFiles: number;
  bytes: number;
  /** Links encountered and not followed — recorded so callers can warn. */
  skippedLinks: string[];
}

export interface CopyTreeOptions {
  onProgress?: (copied: number, total: number) => void;
  /**
   * File names to skip at any depth.
   *
   * Used to keep harness-private bookkeeping (`_user_meta.json`) out of the SSOT:
   * one portable tree must not carry another platform's metadata.
   */
  ignore?: ReadonlySet<string>;
}

/**
 * Recursively copy a directory tree. Never deletes the source.
 *
 * Links inside the tree are skipped rather than followed: copying through a
 * junction could duplicate an unrelated tree, and copying the link itself would
 * produce a dangling entry in the destination.
 */
export function copyTree(src: string, dst: string, options: CopyTreeOptions = {}): CopyTreeResult {
  const result: CopyTreeResult = { copiedFiles: 0, bytes: 0, skippedLinks: [] };
  if (!path.isAbsolute(dst)) {
    throw envError(`copy destination must be absolute: ${dst}`);
  }
  walk(src, dst);
  return result;

  function walk(from: string, to: string): void {
    const st = lstatOrNull(from);
    if (st === null) return;

    if (st.isSymbolicLink()) {
      result.skippedLinks.push(from);
      return;
    }

    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        if (options.ignore?.has(entry) === true) continue;
        walk(path.join(from, entry), path.join(to, entry));
      }
      return;
    }

    fs.copyFileSync(from, to);
    result.copiedFiles += 1;
    result.bytes += st.size;
    options.onProgress?.(result.copiedFiles, result.copiedFiles);
  }
}

/** Total byte size of a directory tree, ignoring links. */
export function treeSize(target: string): number {
  const st = lstatOrNull(target);
  if (st === null) return 0;
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;

  let total = 0;
  for (const entry of fs.readdirSync(target)) {
    total += treeSize(path.join(target, entry));
  }
  return total;
}

/* ─────────────────────────────── trash ─────────────────────────────── */

/**
 * Move a path into the trash directory instead of deleting it.
 *
 * Anything overwritten by `adopt` passes through here first — the project
 * already lost track of seven diverged skills once, so "probably fine" is not
 * an acceptable standard for destruction.
 *
 * Returns the destination path so callers can tell the user where it went.
 */
export function moveToTrash(target: string, trashRoot: string): string {
  ensureDir(trashRoot);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashRoot, `${stamp}-${path.basename(target)}`);

  try {
    fs.renameSync(target, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    // Cross-device move: copy first, verify, then remove the original.
    const copied = copyTree(target, dest);
    if (copied.skippedLinks.length > 0) {
      throw envError(
        `cross-volume move hit a link that could not be copied: ${copied.skippedLinks[0]}`,
        'the original content is still in place; migrate it by hand',
      );
    }
    removeTree(target, path.dirname(target));
  }

  return dest;
}

/**
 * Recursive delete, but only inside an explicitly declared boundary.
 *
 * This is the single place in the codebase permitted to call `rmSync` with
 * `recursive: true`. The boundary argument is not decoration: it is why every
 * other module can be written without that option, and why a mistyped path
 * fails here instead of erasing a skill tree.
 */
export function removeTree(target: string, boundary: string): void {
  if (samePath(boundary, target)) {
    throw envError(`refusing to delete the boundary itself: ${target}`);
  }
  if (!isInside(boundary, target)) {
    throw envError(`refusing to delete a path outside the boundary: ${target}`, `boundary is ${boundary}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/* ─────────────────────────────── basics ────────────────────────────── */

export function ensureDir(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

export function readTextFile(target: string): string | null {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * A half-written config is worse than no config, because it looks valid.
 */
export function writeFileAtomic(target: string, content: string): void {
  ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}
