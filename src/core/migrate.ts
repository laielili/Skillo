/**
 * SSOT migration (`skillo ssot set`).
 *
 * The old tree is never touched until a byte-identical copy has been verified.
 * Only then does the anchor move, the config update, and the live check pass.
 * After that the old tree is deleted, because an SSOT is supposed to exist in
 * exactly one place. `--keep-old` opts into renaming it aside for a manual
 * recovery window.
 */

import path from 'node:path';

import type { AnchorMode, Env } from '../types.ts';
import { anchorPointsAt, detectAnchor, restoreAnchor, switchAnchorTarget, type AnchorSwitch } from './anchor.ts';
import { readConfig, writeConfig } from './config.ts';
import {
  MAX_WINDOWS_PATH,
  copyTree,
  entryCount,
  ensureDir,
  freeBytes,
  isDirectory,
  isFile,
  lstatOrNull,
  moveSibling,
  purgeTree,
  treeSize,
} from './fs-safe.ts';
import { expandHome, isInside, isUnc, samePath } from './paths.ts';
import { buildRelations } from './relation.ts';
import { scanSkills } from './scan.ts';
import { dirHash } from '../util/hash.ts';
import { conflictError, envError, usageError } from '../util/errors.ts';
import { formatBytes } from '../util/text.ts';

export interface MigrateInput {
  env: Env;
  target: string;
  dryRun: boolean;
  /** Required when the anchor is a real directory rather than a junction. */
  yes: boolean;
  /** Keep the old SSOT as `<old>.migrated-<timestamp>` instead of deleting it. */
  keepOld: boolean;
  /** Number of retries after the first copy attempt. */
  retries?: number;
}

export interface MigratePlan {
  source: string;
  target: string;
  anchorPath: string;
  anchorMode: AnchorMode;
  files: number;
  bytes: number;
  free: number | null;
  targetExisted: boolean;
  /** Links that bypass the anchor and will dangle after the move. */
  directLinks: string[];
  keepOld: boolean;
  /** Where a successful run will put the old tree (null when deleting it). */
  backupHint: string | null;
  stamp: string;
}

export interface MigrateResult {
  plan: MigratePlan;
  dryRun: boolean;
  copiedFiles: number;
  copiedBytes: number;
  attempts: number;
  oldSsotPath: string | null;
  anchorBackupPath: string | null;
  warnings: string[];
}

export function planMigration(input: MigrateInput): MigratePlan {
  const { env } = input;
  const config = readConfig(env);
  if (config === null) {
    throw envError('not initialized yet', 'run skillo init to create the anchor and config');
  }

  const anchor = detectAnchor(config.anchor);
  if (anchor.mode === 'absent' || anchor.mode === 'broken') {
    throw envError(
      `anchor is ${anchor.mode === 'absent' ? 'missing' : 'broken'}: ${config.anchor}`,
      'fix the anchor first (skillo doctor), then retry the migration',
    );
  }
  if (anchor.mode === 'real-dir' && !input.yes) {
    throw conflictError(
      `the anchor is a real directory, so this migration has no indirection layer to switch: ${config.anchor}`,
      're-run with --yes to convert the anchor into a junction (the original directory is renamed aside first)',
    );
  }

  const source = anchor.mode === 'junction' ? anchor.ssotRoot : anchor.anchorPath;
  if (source === null || !isDirectory(source)) {
    throw envError(
      `the current SSOT is not readable: ${source ?? '(unknown)'}`,
      'restore the directory or the drive first; nothing was changed',
    );
  }

  const target = resolveTarget(input);
  validateTarget(source, target);

  const sourceHash = dirHash(source);
  if (sourceHash.skippedLinks > 0) {
    throw envError(
      `the SSOT contains ${sourceHash.skippedLinks} link(s); migrating would leave them behind`,
      'turn those entries into real directories first, then retry',
    );
  }

  const bytes = treeSize(source);
  const free = probeFree(target);
  if (free !== null && free < bytes * 1.05) {
    throw envError(
      `not enough free space on the target volume: need ${formatBytes(bytes)}, ${formatBytes(free)} available`,
      'free some space or pick a different target path',
    );
  }

  const scan = scanSkills(source);
  const directLinks =
    anchor.mode === 'junction'
      ? buildRelations({
          skills: scan.skills,
          harnesses: config.harnesses,
          anchorReal: anchor.ssotRoot,
          anchorPath: config.anchor,
        })
          .flatMap((row) =>
            row.cells
              .filter((cell) => cell.state === 'foreign')
              .map((cell) => `${cell.harnessId}:${row.skill.name}`),
          )
      : [];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetExists = lstatOrNull(target) !== null;

  return {
    source,
    target,
    anchorPath: config.anchor,
    anchorMode: anchor.mode,
    files: sourceHash.fileCount,
    bytes,
    free,
    targetExisted: targetExists,
    directLinks,
    keepOld: input.keepOld,
    backupHint: input.keepOld ? `${source}.migrated-${stamp}` : null,
    stamp,
  };
}

export function executeMigration(input: MigrateInput): MigrateResult {
  const plan = planMigration(input);
  const { env } = input;

  if (input.dryRun) {
    return {
      plan,
      dryRun: true,
      copiedFiles: 0,
      copiedBytes: 0,
      attempts: 0,
      oldSsotPath: null,
      anchorBackupPath: null,
      warnings: planWarnings(plan),
    };
  }

  const maxRetries = input.retries ?? 3;
  const attemptsCap = maxRetries + 1;
  let copied: { files: number; bytes: number } | null = null;
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < attemptsCap; attempt += 1) {
    attempts = attempt + 1;
    try {
      copied = copyAndVerify(plan.source, plan.target);
      break;
    } catch (err) {
      lastError = err;
      cleanupPartial(plan.target);
      if (attempt < attemptsCap - 1) sleepMs(200 * (attempt + 1));
    }
  }

  if (copied === null) {
    throw envError(
      `migration failed after ${attempts} attempt(s): ${reasonOf(lastError)}`,
      hintFor(lastError),
      'the old SSOT and the anchor were not touched',
    );
  }

  const config = readConfig(env);
  if (config === null) {
    throw envError('the config disappeared during the migration', 'run skillo init and retry; the old SSOT is intact');
  }
  const previousConfig = { ...config };

  let switched: AnchorSwitch;
  try {
    switched = switchAnchorTarget(config.anchor, plan.target, `.migrated-${plan.stamp}`);
  } catch (err) {
    cleanupPartial(plan.target);
    throw err;
  }

  try {
    writeConfig(env, { ...config, ssotRoot: plan.target });
  } catch (err) {
    restoreAnchor(switched, plan.target);
    throw envError(
      `the copy succeeded but the config could not be written: ${reasonOf(err)}`,
      'the anchor was restored; the old SSOT is unchanged',
      `a verified copy remains at ${plan.target}`,
    );
  }

  try {
    verifyLive(config.anchor, plan.target, plan.files);
  } catch (err) {
    let configRestored = true;
    try {
      writeConfig(env, previousConfig);
    } catch {
      configRestored = false;
    }
    restoreAnchor(switched, plan.target);
    throw envError(
      `the copy looked good but the migrated SSOT failed its live check: ${reasonOf(err)}`,
      configRestored
        ? 'the anchor and config were restored; the old SSOT is unchanged'
        : 'the anchor was restored, but the config could not be; restore ~/.skillo/config.json by hand',
      `the verified copy remains at ${plan.target}`,
    );
  }

  const warnings: string[] = [];
  let oldSsotPath: string | null = null;

  // A real-directory anchor WAS the old SSOT, and switchAnchorTarget already
  // moved it aside. Touching plan.source again would rename the brand-new
  // anchor junction.
  const oldTree = switched.backupPath ?? plan.source;

  if (input.keepOld) {
    oldSsotPath = switched.backupPath ?? keepAside(oldTree, plan.stamp, warnings);
  } else {
    try {
      purgeTree(oldTree, path.dirname(oldTree));
    } catch (err) {
      warnings.push(`the migration succeeded, but the old SSOT could not be removed: ${reasonOf(err)}`);
      oldSsotPath = oldTree;
    }
  }

  return {
    plan,
    dryRun: false,
    copiedFiles: copied.files,
    copiedBytes: copied.bytes,
    attempts,
    oldSsotPath,
    anchorBackupPath: switched.backupPath,
    warnings: [...planWarnings(plan), ...warnings],
  };
}

function resolveTarget(input: MigrateInput): string {
  const raw = input.target;
  if (raw === '') {
    throw usageError('missing target path', 'example: skillo ssot set D:\\Projects\\Skills-moved');
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return expandHome(raw, input.env.home);
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(input.env.cwd, raw);
}

function validateTarget(source: string, target: string): void {
  if (isUnc(target)) {
    throw usageError(
      `the SSOT cannot live on a network path: ${target}`,
      'use a local drive; junctions do not support UNC targets',
    );
  }
  if (target.length >= MAX_WINDOWS_PATH) {
    throw usageError(
      `target path is too long for Windows (${target.length} chars): ${target}`,
      'choose a shorter path closer to the drive root',
    );
  }
  if (path.parse(target).root === target) {
    throw usageError(`refusing to use a drive root as the SSOT: ${target}`, 'pick a directory on that drive');
  }
  if (samePath(source, target)) {
    throw usageError(`the target is already the current SSOT: ${target}`);
  }
  if (isInside(source, target)) {
    throw usageError(
      `the target is inside the current SSOT: ${target}`,
      'choose a directory outside the tree you are moving',
    );
  }
  if (isInside(target, source)) {
    throw usageError(
      `the target contains the current SSOT: ${target}`,
      'choose a sibling or a different volume',
    );
  }

  const st = lstatOrNull(target);
  if (st === null) return;
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw conflictError(
      `the target exists but is not a plain directory: ${target}`,
      'choose a new or empty directory',
    );
  }
  if (entryCount(target) > 0) {
    throw conflictError(
      `the target directory is not empty: ${target}`,
      'choose an empty directory; Skillo will not mix the migrated SSOT with existing files',
    );
  }
}

function probeFree(target: string): number | null {
  let current = path.resolve(target);
  for (let depth = 0; depth < 64; depth += 1) {
    if (lstatOrNull(current) !== null) return freeBytes(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function copyAndVerify(source: string, target: string): { files: number; bytes: number } {
  ensureDir(target);

  const copy = copyTree(source, target);
  if (copy.skippedLinks.length > 0) {
    throw envError(
      `the copy skipped a link: ${copy.skippedLinks[0]}`,
      'the old SSOT is intact; remove the link or make it a real directory',
    );
  }

  const sourceHash = dirHash(source);
  const targetHash = dirHash(target);
  if (sourceHash.hash !== targetHash.hash || sourceHash.fileCount !== targetHash.fileCount) {
    throw new Error('content hash mismatch after copying');
  }

  for (const skill of scanSkills(source).skills) {
    const expected = dirHash(skill.path);
    const actual = dirHash(path.join(target, skill.name));
    if (expected.hash !== actual.hash || expected.fileCount !== actual.fileCount) {
      throw new Error(`content mismatch in skill "${skill.name}"`);
    }
  }

  return { files: copy.copiedFiles, bytes: copy.bytes };
}

function verifyLive(anchorPath: string, target: string, expectedFiles: number): void {
  if (!anchorPointsAt(anchorPath, target)) {
    throw new Error('the anchor does not resolve to the new SSOT');
  }

  const scan = scanSkills(anchorPath);
  for (const skill of scan.skills) {
    if (!isFile(path.join(anchorPath, skill.name, 'SKILL.md'))) {
      throw new Error(`skill is not readable through the anchor: ${skill.name}`);
    }
  }

  const live = dirHash(target);
  if (live.fileCount !== expectedFiles) {
    throw new Error('the new SSOT changed while it was being verified');
  }
}

function cleanupPartial(target: string): void {
  if (lstatOrNull(target) === null) return;
  try {
    purgeTree(target, path.dirname(target));
  } catch {
    // Best effort: the final error already names the target that needs cleaning.
  }
}

function planWarnings(plan: MigratePlan): string[] {
  const warnings: string[] = [];
  if (plan.directLinks.length > 0) {
    const sample = plan.directLinks.slice(0, 5).join(', ');
    warnings.push(
      `${plan.directLinks.length} harness link(s) bypass the anchor and will dangle after the move: ${sample}${
        plan.directLinks.length > 5 ? ' …' : ''
      }`,
    );
    warnings.push('run `skillo doctor --fix` before migrating to redirect them through the anchor');
  }
  return warnings;
}

function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOSPC':
      return 'the target volume ran out of space';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied (a file may be open in another program)';
    case 'EBUSY':
      return 'a file is busy (close tools that are reading the SSOT)';
    case 'EROFS':
      return 'the target volume is read-only';
    case 'ENAMETOOLONG':
      return 'a path is too long for Windows';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

function hintFor(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOSPC':
      return 'free some space or choose a different target volume';
    case 'EACCES':
    case 'EPERM':
    case 'EBUSY':
      return 'close programs that are reading the SSOT, then retry';
    case 'EROFS':
      return 'choose a writable volume';
    default:
      return 'retry; if it keeps failing, the reason above names the failing step';
  }
}

function keepAside(tree: string, stamp: string, warnings: string[]): string | null {
  try {
    return moveSibling(tree, `.migrated-${stamp}`);
  } catch (err) {
    warnings.push(`the migration succeeded, but the old SSOT could not be renamed aside: ${reasonOf(err)}`);
    return null;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
