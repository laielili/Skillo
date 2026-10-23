/**
 * `skillo link` / `skillo unlink`
 *
 * Link targets always point at the *anchor* path, never at the resolved SSOT.
 * That extra hop is the entire reason `ssot set` can be O(1): every harness link
 * follows the anchor automatically.
 */

import path from 'node:path';

import type { Env, Harness, RelationState } from '../types.ts';
import { detectAnchor } from '../core/anchor.ts';
import { readConfig } from '../core/config.ts';
import { classifyEntry, createJunction, isDirectory, removeJunction } from '../core/fs-safe.ts';
import { isNativeHarness } from '../core/relation.ts';
import { scanSkills } from '../core/scan.ts';
import { EXIT, envError, usageError, type ExitCode } from '../util/errors.ts';

export type LinkAction =
  | 'created'
  | 'unlinked'
  | 'skipped-linked'
  | 'skipped-foreign'
  | 'replaced-broken'
  | 'conflict'
  | 'refused-invalid'
  | 'missing-skill'
  | 'failed';

export interface LinkItem {
  skill: string;
  harness: string;
  action: LinkAction;
  detail?: string;
}

export interface LinkInput {
  env: Env;
  /** Skill names, or null for every skill in the SSOT. */
  skills: string[] | null;
  /** Harness ids, or null for every enabled harness. */
  harnesses: string[] | null;
  dryRun: boolean;
  /** Also redirect links that currently bypass the anchor. */
  replaceForeign: boolean;
}

export interface LinkOutcome {
  items: LinkItem[];
  dryRun: boolean;
  exitCode: ExitCode;
}

interface Context {
  env: Env;
  anchorPath: string;
  anchorReal: string;
  harnesses: Harness[];
  /** Harnesses excluded because they read the anchor directly. */
  nativeIds: string[];
  skillNames: string[];
}

function prepare(env: Env): Context {
  const config = readConfig(env);
  if (config === null) {
    throw envError('尚未初始化', '运行 skillo init 建立锚点与配置');
  }

  const anchor = detectAnchor(config.anchor);
  if (anchor.ssotRoot === null || !isDirectory(anchor.ssotRoot)) {
    throw envError(
      `锚点不可用：${config.anchor}`,
      anchor.mode === 'broken'
        ? `它指向的目标 ${anchor.danglingTarget ?? '(未知)'} 当前不可达`
        : '先运行 skillo init',
    );
  }

  const scan = scanSkills(anchor.ssotRoot);
  return {
    env,
    anchorPath: config.anchor,
    anchorReal: anchor.ssotRoot,
    // Native harnesses see the anchor directly; creating links inside them would
    // put entries into the anchor itself. They are filtered out rather than
    // reported as "already linked", because there is nothing to link.
    harnesses: config.harnesses.filter(
      (harness) => harness.enabled && !isNativeHarness(harness, config.anchor, anchor.ssotRoot),
    ),
    nativeIds: config.harnesses
      .filter((harness) => isNativeHarness(harness, config.anchor, anchor.ssotRoot))
      .map((harness) => harness.id),
    skillNames: scan.skills.map((skill) => skill.name),
  };
}

function resolveHarnesses(context: Context, requested: string[] | null): Harness[] {
  if (requested === null) return context.harnesses;

  const native = requested.filter((id) => context.nativeIds.includes(id));
  if (native.length > 0) {
    throw usageError(
      `${native.join(', ')} 原生读取锚点，无需链接`,
      '这类 harness 的 skills 目录就是锚点本身，技能本来就全部可见',
    );
  }

  const wanted = new Set(requested);
  const unknown = [...wanted].filter((id) => !context.harnesses.some((harness) => harness.id === id));
  if (unknown.length > 0) {
    throw usageError(
      `未知 harness：${unknown.join(', ')}`,
      `已注册：${context.harnesses.map((harness) => harness.id).join(', ') || '(无)'}`,
    );
  }

  return context.harnesses.filter((harness) => wanted.has(harness.id));
}

function resolveSkills(context: Context, requested: string[] | null): string[] {
  if (requested === null) return context.skillNames;

  const known = new Set(context.skillNames);
  const missing = requested.filter((name) => !known.has(name));
  if (missing.length > 0) {
    throw usageError(
      `SSOT 里没有这些技能：${missing.join(', ')}`,
      `可用技能：${context.skillNames.slice(0, 10).join(', ')}${context.skillNames.length > 10 ? ' …' : ''}`,
    );
  }

  return requested;
}

export function runLink(input: LinkInput): LinkOutcome {
  const context = prepare(input.env);
  const harnesses = resolveHarnesses(context, input.harnesses);
  const skills = resolveSkills(context, input.skills);
  const items: LinkItem[] = [];

  for (const harness of harnesses) {
    // The harness directory itself may be a link (whole-directory wiring). In
    // that case every entry inside is a plain directory and per-skill linking is
    // meaningless — refuse loudly rather than write links into a phantom tree.
    if (!input.dryRun && !isDirectory(harness.path)) {
      items.push({
        skill: '*',
        harness: harness.id,
        action: 'failed',
        detail: `目录不存在：${harness.path}`,
      });
      continue;
    }

    for (const skill of skills) {
      items.push(linkOne(context, harness, skill, input));
    }
  }

  return { items, dryRun: input.dryRun, exitCode: exitCodeFor(items) };
}

function linkOne(context: Context, harness: Harness, skill: string, input: LinkInput): LinkItem {
  const slot = path.join(harness.path, skill);
  const target = path.join(context.anchorPath, skill);

  const state: RelationState = classifyEntry(slot, {
    anchorReal: context.anchorReal,
    anchorPath: context.anchorPath,
  });

  switch (state) {
    case 'linked':
      return { skill, harness: harness.id, action: 'skipped-linked' };

    case 'foreign':
      if (!input.replaceForeign) {
        return {
          skill,
          harness: harness.id,
          action: 'skipped-foreign',
          detail: '指向锚点之外，加 --replace 可重定向',
        };
      }
      if (!input.dryRun) removeJunction(slot);
      break;

    case 'broken':
      if (!input.dryRun) removeJunction(slot);
      break;

    case 'conflict':
      return {
        skill,
        harness: harness.id,
        action: 'conflict',
        detail: '实体目录占位，用 skillo adopt 纳入 SSOT',
      };

    case 'invalid':
      return {
        skill,
        harness: harness.id,
        action: 'refused-invalid',
        detail: '同名文件占位，Skillo 不会删除非链接条目',
      };

    case 'absent':
      break;
  }

  if (input.dryRun) {
    return {
      skill,
      harness: harness.id,
      action: state === 'absent' ? 'created' : 'replaced-broken',
      detail: '[dry-run]',
    };
  }

  try {
    createJunction(target, slot, { requireSkillMd: true });
    return {
      skill,
      harness: harness.id,
      action: state === 'absent' ? 'created' : 'replaced-broken',
    };
  } catch (err) {
    return {
      skill,
      harness: harness.id,
      action: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface UnlinkInput {
  env: Env;
  skills: string[] | null;
  harnesses: string[] | null;
  dryRun: boolean;
}

export function runUnlink(input: UnlinkInput): LinkOutcome {
  const context = prepare(input.env);
  const harnesses = resolveHarnesses(context, input.harnesses);
  const skills = resolveSkills(context, input.skills);
  const items: LinkItem[] = [];

  for (const harness of harnesses) {
    for (const skill of skills) {
      const slot = path.join(harness.path, skill);
      const state = classifyEntry(slot, {
        anchorReal: context.anchorReal,
        anchorPath: context.anchorPath,
      });

      switch (state) {
        case 'absent':
          continue;
        case 'conflict':
          items.push({
            skill,
            harness: harness.id,
            action: 'conflict',
            detail: '实体目录不是 Skillo 建的链接，未删除',
          });
          continue;
        case 'invalid':
          items.push({
            skill,
            harness: harness.id,
            action: 'refused-invalid',
            detail: '同名文件，未删除',
          });
          continue;
        default:
          break;
      }

      if (!input.dryRun) {
        try {
          removeJunction(slot);
        } catch (err) {
          items.push({
            skill,
            harness: harness.id,
            action: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      items.push({ skill, harness: harness.id, action: 'unlinked' });
    }
  }

  return { items, dryRun: input.dryRun, exitCode: exitCodeFor(items) };
}

function exitCodeFor(items: readonly LinkItem[]): ExitCode {
  const blocked = items.some(
    (item) => item.action === 'conflict' || item.action === 'failed' || item.action === 'refused-invalid',
  );
  return blocked ? EXIT.PARTIAL : EXIT.OK;
}
