/**
 * `skillo adopt`
 *
 * Pulls real directories out of a harness and into the SSOT, then replaces them
 * with links. This is the only command that overwrites content, so every
 * destructive step moves the original into the staging directory (`~/.skillo/.tmp`)
 * first, verifies the transfer by hash, and deletes the staged package once the
 * link reads correctly. A package left in staging is the signal that a step did
 * not complete — keeping verified duplicates would put a second copy of the SSOT
 * where there is supposed to be exactly one.
 *
 * Collisions are never resolved automatically. Seven of this project's own skills
 * had already diverged before the tool existed; two files that both "look right"
 * cannot be merged by an algorithm, only by a person.
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { Env, Harness } from '../types.ts';
import { detectAnchor } from '../core/anchor.ts';
import { readConfig } from '../core/config.ts';
import {
  copyTree,
  createJunction,
  isDirectory,
  isFile,
  lstatOrNull,
  moveToStaging,
  purgeTree,
  readlinkOrNull,
} from '../core/fs-safe.ts';
import { skilloHome } from '../core/paths.ts';
import { EXIT, envError, usageError, type ExitCode } from '../util/errors.ts';
import { dirHash } from '../util/hash.ts';

export type AdoptAction =
  | 'adopted'
  | 'adopted-identical'
  | 'adopted-kept-harness'
  | 'adopted-kept-ssot'
  | 'conflict'
  | 'diff'
  | 'skipped'
  | 'failed';

export interface AdoptItem {
  skill: string;
  action: AdoptAction;
  detail?: string;
  /**
   * Staged packages that could not be deleted, so the step is not finished.
   * Absent means everything staged was verified and discarded.
   */
  stagedPaths?: string[];
  diff?: string;
}

export interface AdoptInput {
  env: Env;
  /** Id of the harness to pull skills out of; given as the first positional. */
  harness: string;
  /** Restrict to these skills; null means every adoptable directory. */
  skills: string[] | null;
  keep: 'ssot' | 'harness' | null;
  dryRun: boolean;
  diff: boolean;
}

export interface AdoptOutcome {
  items: AdoptItem[];
  exitCode: ExitCode;
}

/**
 * Platform bookkeeping that lives inside skill directories but is not content.
 *
 * WorkBuddy drops `_user_meta.json` and `_skillhub_meta.json` next to SKILL.md.
 * Comparing them as content would report six false collisions on this machine
 * alone. They are excluded from comparison and, by design, never enter the SSOT:
 * it stays portable, and provenance belongs in `annotations.json`, not in the
 * skill tree. They leave with the staged package, so a market-installed skill
 * loses WorkBuddy's local record of where it came from — `skillo annotate` is how
 * that gets written down before adopting.
 */
const PLATFORM_META: ReadonlySet<string> = new Set(['_user_meta.json', '_skillhub_meta.json']);

interface Context {
  env: Env;
  anchorPath: string;
  ssotRoot: string;
  stagingRoot: string;
  harness: Harness;
}

export function runAdopt(input: AdoptInput): AdoptOutcome {
  const config = readConfig(input.env);
  if (config === null) {
    throw envError('not initialized yet', 'run skillo init to create the anchor and config');
  }

  const harness = config.harnesses.find((candidate) => candidate.id === input.harness);
  if (harness === undefined) {
    throw usageError(
      `unknown harness: ${input.harness}`,
      'the first argument is the harness, not the skill: skillo adopt <harness> [skill]',
      `registered: ${config.harnesses.map((candidate) => candidate.id).join(', ') || '(none)'}`,
    );
  }

  const anchor = detectAnchor(config.anchor);
  if (anchor.ssotRoot === null || !isDirectory(anchor.ssotRoot)) {
    throw envError(`anchor is unusable: ${config.anchor}`, 'run skillo init first');
  }

  if (lstatOrNull(harness.path)?.isSymbolicLink() === true) {
    throw usageError(
      `the skills directory of ${harness.id} is itself a link (→ ${readlinkOrNull(harness.path) ?? '?'})`,
      `run skillo doctor --fix ${harness.id} first to turn it into a per-skill layout`,
    );
  }

  const context: Context = {
    env: input.env,
    anchorPath: config.anchor,
    ssotRoot: anchor.ssotRoot,
    stagingRoot: path.join(skilloHome(input.env), '.tmp'),
    harness,
  };

  const candidates = input.skills ?? listAdoptable(harness.path);
  if (candidates.length === 0) {
    return { items: [], exitCode: EXIT.OK };
  }

  const items: AdoptItem[] = [];
  for (const name of candidates) {
    // One locked directory must not abort the whole batch. Windows routinely
    // returns EPERM/EBUSY while another process still holds a handle — the file
    // is fine, it is just busy for a moment.
    try {
      items.push(adoptOne(context, name, input));
    } catch (err) {
      items.push({
        skill: name,
        action: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const blocked = items.some((item) => item.action === 'conflict' || item.action === 'failed');
  return { items, exitCode: blocked ? EXIT.CONFLICT : EXIT.OK };
}

/** Errors Windows throws when a handle is merely busy, not when the step failed. */
const LOCK_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

function withLockRetry<T>(action: () => T, attempts = 3): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return action();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code !== 'string' || !LOCK_CODES.has(code)) throw err;
      lastError = err;
      sleepMs(60 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Move a directory into staging, retrying the transient Windows lock errors. */
function stageWithRetry(target: string, stagingRoot: string, label: string): string {
  return withLockRetry(() => moveToStaging(target, stagingRoot, label));
}

/**
 * Delete the staged packages of a transfer that verified.
 *
 * Returns whatever survives. A package left in staging is not a cleanup detail —
 * it is the sign that this skill is still holding two copies of itself.
 */
function discardStaged(stagingRoot: string, staged: readonly string[]): string[] {
  const retained: string[] = [];
  for (const target of staged) {
    try {
      withLockRetry(() => purgeTree(target, stagingRoot));
    } catch {
      retained.push(target);
    }
  }
  return retained;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Real directories under the harness that look like skills. */
function listAdoptable(harnessPath: string): string[] {
  let entries: string[];
  try {
    entries = readdirSorted(harnessPath);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(harnessPath, name);
    const st = lstatOrNull(full);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) continue;
    if (!isFile(path.join(full, 'SKILL.md'))) continue;
    out.push(name);
  }
  return out;
}

function readdirSorted(target: string): string[] {
  return fs.readdirSync(target).sort();
}

function adoptOne(context: Context, name: string, input: AdoptInput): AdoptItem {
  const harnessPath = path.join(context.harness.path, name);
  const ssotPath = path.join(context.ssotRoot, name);

  const st = lstatOrNull(harnessPath);
  if (st === null) {
    return { skill: name, action: 'failed', detail: 'directory does not exist' };
  }
  if (st.isSymbolicLink()) {
    return { skill: name, action: 'skipped', detail: 'already a link' };
  }
  if (!isFile(path.join(harnessPath, 'SKILL.md'))) {
    return { skill: name, action: 'skipped', detail: 'missing SKILL.md' };
  }

  const harnessHash = dirHash(harnessPath, { ignore: PLATFORM_META });

  if (!isDirectory(ssotPath)) {
    return adoptNew(context, name, harnessPath, ssotPath, input);
  }

  const ssotHash = dirHash(ssotPath, { ignore: PLATFORM_META });
  const identical = ssotHash.hash === harnessHash.hash && ssotHash.fileCount === harnessHash.fileCount;

  if (identical) {
    if (input.dryRun) {
      return {
        skill: name,
        action: 'adopted-identical',
        detail: '[dry-run] identical apart from platform metadata, will only be replaced by a link',
      };
    }
    const staged = stageWithRetry(harnessPath, context.stagingRoot, 'harness');
    return replaceWithLink(context, name, harnessPath, {
      action: 'adopted-identical',
      staged: [staged],
      detail: 'identical to the SSOT apart from platform metadata; the staged copy is discarded with it — use skillo annotate to record provenance',
    });
  }

  if (input.diff) {
    return { skill: name, action: 'diff', diff: runDiff(ssotPath, harnessPath) };
  }

  if (input.keep === null) {
    return {
      skill: name,
      action: 'conflict',
      detail: `content differs (SSOT has ${ssotHash.fileCount} file(s), harness has ${harnessHash.fileCount})`,
    };
  }

  if (input.keep === 'ssot') {
    if (input.dryRun) {
      return { skill: name, action: 'adopted-kept-ssot', detail: '[dry-run] keep the SSOT version' };
    }
    const staged = stageWithRetry(harnessPath, context.stagingRoot, 'harness');
    return replaceWithLink(context, name, harnessPath, {
      action: 'adopted-kept-ssot',
      staged: [staged],
      detail: `harness version discarded (${harnessHash.fileCount} file(s) vs ${ssotHash.fileCount} in the SSOT); run --diff before --keep to see it first`,
    });
  }

  // keep === 'harness'
  if (input.dryRun) {
    return { skill: name, action: 'adopted-kept-harness', detail: '[dry-run] overwrite the SSOT with the harness version' };
  }

  const ssotBackup = stageWithRetry(ssotPath, context.stagingRoot, 'ssot');
  const copy = copyChecked(harnessPath, ssotPath);
  if (!copy.ok) {
    return {
      skill: name,
      action: 'failed',
      detail: `copy verification failed: ${copy.reason}; the SSOT entry was moved to staging and has not been restored`,
      stagedPaths: [ssotBackup],
    };
  }

  const harnessStaged = stageWithRetry(harnessPath, context.stagingRoot, 'harness');
  return replaceWithLink(context, name, harnessPath, {
    action: 'adopted-kept-harness',
    staged: [ssotBackup, harnessStaged],
    detail: `harness version written to the SSOT; the SSOT's previous version is in git history if it was ever committed`,
  });
}

function adoptNew(
  context: Context,
  name: string,
  harnessPath: string,
  ssotPath: string,
  input: AdoptInput,
): AdoptItem {
  if (input.dryRun) {
    return { skill: name, action: 'adopted', detail: '[dry-run] copy into the SSOT and replace with a link' };
  }

  const copy = copyChecked(harnessPath, ssotPath);
  if (!copy.ok) {
    return { skill: name, action: 'failed', detail: `copy verification failed: ${copy.reason}` };
  }

  const staged = stageWithRetry(harnessPath, context.stagingRoot, 'harness');
  return replaceWithLink(context, name, harnessPath, { action: 'adopted', staged: [staged] });
}

interface ReplaceOptions {
  action: AdoptAction;
  /** Packages moved aside for this skill; deleted once the link verifies. */
  staged: string[];
  detail?: string;
}

function replaceWithLink(
  context: Context,
  name: string,
  harnessPath: string,
  options: ReplaceOptions,
): AdoptItem {
  const target = path.join(context.anchorPath, name);
  try {
    createJunction(target, harnessPath, { requireSkillMd: true });
  } catch (err) {
    return {
      skill: name,
      action: 'failed',
      detail: `failed to create link, so nothing was discarded: ${err instanceof Error ? err.message : String(err)}`,
      stagedPaths: options.staged,
    };
  }

  // The link reads SKILL.md through the anchor, so the transfer is proven here —
  // which is the moment the staged copy stops being a backup and becomes a second
  // copy of the SSOT.
  const retained = discardStaged(context.stagingRoot, options.staged);

  return {
    skill: name,
    action: options.action,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(retained.length === 0 ? {} : { stagedPaths: retained }),
  };
}

interface CopyCheck {
  ok: boolean;
  reason?: string;
}

/** Copy a skill and prove the copy matches before anything is removed. */
function copyChecked(source: string, destination: string): CopyCheck {
  try {
    const result = copyTree(source, destination, { ignore: PLATFORM_META });
    if (result.skippedLinks.length > 0) {
      return { ok: false, reason: `directory contains links, cannot copy completely: ${result.skippedLinks[0]}` };
    }
    const before = dirHash(source, { ignore: PLATFORM_META });
    const after = dirHash(destination, { ignore: PLATFORM_META });
    if (before.hash !== after.hash || before.fileCount !== after.fileCount) {
      return { ok: false, reason: `hash mismatch (${before.fileCount} vs ${after.fileCount} files)` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function runDiff(left: string, right: string): string {
  const result = spawnSync('git', ['diff', '--no-index', '--color=never', left, right], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error !== undefined && result.error !== null) {
    return `could not run git diff: ${result.error.message}\n  SSOT:    ${left}\n  harness: ${right}`;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return output === '' ? '(no differences)' : output;
}
