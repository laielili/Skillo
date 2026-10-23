/**
 * `skillo adopt`
 *
 * Pulls real directories out of a harness and into the SSOT, then replaces them
 * with links. This is the only command that overwrites content, so every
 * destructive step is preceded by a copy into the trash directory and followed by
 * a hash check.
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
  moveToTrash,
  readlinkOrNull,
  removeTree,
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
  /** Set when something was moved aside; the user may want to recover it. */
  trashPath?: string;
  diff?: string;
}

export interface AdoptInput {
  env: Env;
  from: string;
  /** Restrict to these skills; null means every adoptable directory. */
  skills: string[] | null;
  keep: 'ssot' | 'harness' | null;
  dryRun: boolean;
  diff: boolean;
}

export interface AdoptOutcome {
  items: AdoptItem[];
  dryRun: boolean;
  exitCode: ExitCode;
}

/**
 * Platform bookkeeping that lives inside skill directories but is not content.
 *
 * WorkBuddy drops `_user_meta.json` and `_skillhub_meta.json` next to SKILL.md.
 * Comparing them as content would report six false collisions on this machine
 * alone. They are excluded from comparison and, by design, left behind in the
 * trash when a harness directory is replaced by a link: the SSOT stays portable,
 * and provenance belongs in `annotations.json`, not in the skill tree.
 */
const PLATFORM_META: ReadonlySet<string> = new Set(['_user_meta.json', '_skillhub_meta.json']);

interface Context {
  env: Env;
  anchorPath: string;
  ssotRoot: string;
  trashRoot: string;
  harness: Harness;
}

export function runAdopt(input: AdoptInput): AdoptOutcome {
  const config = readConfig(input.env);
  if (config === null) {
    throw envError('尚未初始化', '运行 skillo init 建立锚点与配置');
  }

  const harness = config.harnesses.find((candidate) => candidate.id === input.from);
  if (harness === undefined) {
    throw usageError(
      `未知 harness：${input.from}`,
      `已注册：${config.harnesses.map((candidate) => candidate.id).join(', ') || '(无)'}`,
    );
  }

  const anchor = detectAnchor(config.anchor);
  if (anchor.ssotRoot === null || !isDirectory(anchor.ssotRoot)) {
    throw envError(`锚点不可用：${config.anchor}`, '先运行 skillo init');
  }

  if (lstatOrNull(harness.path)?.isSymbolicLink() === true) {
    throw usageError(
      `${harness.id} 的 skills 目录本身是链接（→ ${readlinkOrNull(harness.path) ?? '?'}）`,
      `先运行 skillo doctor --fix ${harness.id} 把它改成逐技能结构`,
    );
  }

  const context: Context = {
    env: input.env,
    anchorPath: config.anchor,
    ssotRoot: anchor.ssotRoot,
    trashRoot: path.join(skilloHome(input.env), '.trash'),
    harness,
  };

  const candidates = input.skills ?? listAdoptable(harness.path);
  if (candidates.length === 0) {
    return { items: [], dryRun: input.dryRun, exitCode: EXIT.OK };
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
  return { items, dryRun: input.dryRun, exitCode: blocked ? EXIT.CONFLICT : EXIT.OK };
}

/** Move a directory to the trash, retrying the transient Windows lock errors. */
function trashWithRetry(target: string, trashRoot: string, attempts = 3): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return moveToTrash(target, trashRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
      lastError = err;
      sleepMs(60 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    return { skill: name, action: 'failed', detail: '目录不存在' };
  }
  if (st.isSymbolicLink()) {
    return { skill: name, action: 'skipped', detail: '已经是链接' };
  }
  if (!isFile(path.join(harnessPath, 'SKILL.md'))) {
    return { skill: name, action: 'skipped', detail: '缺少 SKILL.md' };
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
        detail: '[dry-run] 除平台元数据外内容相同，仅替换为链接',
      };
    }
    const trash = trashWithRetry(harnessPath, context.trashRoot);
    return replaceWithLink(context, name, harnessPath, {
      action: 'adopted-identical',
      trashPath: trash,
      detail: '平台元数据（_user_meta.json 等）随原目录进入 trash；来源信息可用 skillo annotate 补登记',
    });
  }

  if (input.diff) {
    return { skill: name, action: 'diff', diff: runDiff(ssotPath, harnessPath) };
  }

  if (input.keep === null) {
    return {
      skill: name,
      action: 'conflict',
      detail: `内容不同（SSOT ${ssotHash.fileCount} 文件 / harness ${harnessHash.fileCount} 文件）`,
    };
  }

  if (input.keep === 'ssot') {
    if (input.dryRun) {
      return { skill: name, action: 'adopted-kept-ssot', detail: '[dry-run] 保留 SSOT 版本' };
    }
    const trash = trashWithRetry(harnessPath, context.trashRoot);
    return replaceWithLink(context, name, harnessPath, {
      action: 'adopted-kept-ssot',
      trashPath: trash,
    });
  }

  // keep === 'harness'
  if (input.dryRun) {
    return { skill: name, action: 'adopted-kept-harness', detail: '[dry-run] 用 harness 版本覆盖 SSOT' };
  }

  const ssotBackup = trashWithRetry(ssotPath, context.trashRoot);
  removeTree(ssotPath, context.ssotRoot);
  const copy = copyChecked(harnessPath, ssotPath);
  if (!copy.ok) {
    return {
      skill: name,
      action: 'failed',
      detail: `复制后校验失败：${copy.reason}`,
      trashPath: ssotBackup,
    };
  }

  const harnessTrash = trashWithRetry(harnessPath, context.trashRoot);
  return replaceWithLink(context, name, harnessPath, {
    action: 'adopted-kept-harness',
    trashPath: ssotBackup,
    detail: `harness 版本已写入 SSOT；原 SSOT 版本在 ${ssotBackup}，原 harness 目录在 ${harnessTrash}`,
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
    return { skill: name, action: 'adopted', detail: '[dry-run] 复制进 SSOT 并替换为链接' };
  }

  const copy = copyChecked(harnessPath, ssotPath);
  if (!copy.ok) {
    return { skill: name, action: 'failed', detail: `复制后校验失败：${copy.reason}` };
  }

  const trash = trashWithRetry(harnessPath, context.trashRoot);
  return replaceWithLink(context, name, harnessPath, { action: 'adopted', trashPath: trash });
}

interface ReplaceOptions {
  action: AdoptAction;
  trashPath: string;
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
      detail: `建立链接失败：${err instanceof Error ? err.message : String(err)}`,
      trashPath: options.trashPath,
    };
  }

  return {
    skill: name,
    action: options.action,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    trashPath: options.trashPath,
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
      return { ok: false, reason: `目录内含链接，无法完整复制：${result.skippedLinks[0]}` };
    }
    const before = dirHash(source, { ignore: PLATFORM_META });
    const after = dirHash(destination, { ignore: PLATFORM_META });
    if (before.hash !== after.hash || before.fileCount !== after.fileCount) {
      return { ok: false, reason: `哈希不一致（${before.fileCount} vs ${after.fileCount} 个文件）` };
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
    return `无法运行 git diff：${result.error.message}\n  SSOT:    ${left}\n  harness: ${right}`;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return output === '' ? '(无差异)' : output;
}
