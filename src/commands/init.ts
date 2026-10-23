/**
 * `skillo init`
 *
 * Establishes the anchor, discovers installed harnesses, writes the config.
 * Deliberately conservative: if the anchor is a dangling junction it stops and
 * says so. Creating a fresh empty anchor there would look like success and feel
 * like data loss.
 */

import path from 'node:path';

import type { AnchorInfo, Env, Harness, SkilloConfig } from '../types.ts';
import { detectAnchor } from '../core/anchor.ts';
import { writeConfig } from '../core/config.ts';
import { ensureDir, isDirectory } from '../core/fs-safe.ts';
import { defaultAnchor } from '../core/paths.ts';
import { HARNESS_PRESETS, PRESET_VERSION, harnessFromPreset } from '../presets/harnesses.ts';
import { envError } from '../util/errors.ts';

export interface InitInput {
  env: Env;
  /** Explicit SSOT path. When omitted the anchor's current target is used. */
  ssot?: string;
}

export interface InitResult {
  config: SkilloConfig;
  anchor: AnchorInfo;
  registered: Harness[];
  /** Preset ids that exist on disk but were not registered. */
  skipped: string[];
  createdAnchor: boolean;
}

export function runInit(input: InitInput): InitResult {
  const { env } = input;
  const anchorPath = defaultAnchor(env);
  const anchor = detectAnchor(anchorPath);

  if (anchor.mode === 'broken') {
    throw envError(
      `锚点指向的目标不可达：${anchorPath}`,
      anchor.danglingTarget === null
        ? '目标路径已不存在。若在移动硬盘上，请先挂载'
        : `它原本指向 ${anchor.danglingTarget}。恢复该路径，或先删除这个断链`,
    );
  }

  let createdAnchor = false;
  let ssotRoot: string;

  if (input.ssot !== undefined) {
    ssotRoot = path.resolve(input.ssot);
    if (!isDirectory(ssotRoot)) {
      throw envError(`指定的 SSOT 不是目录：${ssotRoot}`, '先创建该目录，或去掉 --ssot 使用当前锚点');
    }
    // Creating the anchor is out of scope until `ssot set` exists; refuse rather
    // than silently write a config that points somewhere unwired.
    if (anchor.mode !== 'junction') {
      throw envError(
        `锚点当前是 ${anchor.mode}，尚未接入指定 SSOT`,
        '先运行一次不带 --ssot 的 init 建立锚点，再用 skillo ssot set 迁移',
      );
    }
  } else if (anchor.mode === 'absent') {
    ensureDir(anchorPath);
    ssotRoot = anchorPath;
    createdAnchor = true;
  } else {
    ssotRoot = anchor.ssotRoot ?? anchorPath;
  }

  if (anchor.mode === 'junction' && anchor.ssotRoot !== null && !isDirectory(anchor.ssotRoot)) {
    throw envError(`锚点目标不是目录：${anchor.ssotRoot}`);
  }

  const registered: Harness[] = [];
  const skipped: string[] = [];

  for (const preset of HARNESS_PRESETS) {
    const candidate = path.join(env.home, ...preset.segments);
    if (isDirectory(candidate)) {
      registered.push(harnessFromPreset(preset, env));
    } else {
      skipped.push(preset.id);
    }
  }

  const config: SkilloConfig = {
    version: 1,
    anchor: anchorPath,
    ssotRoot,
    harnesses: registered,
  };
  writeConfig(env, config);

  return { config, anchor: detectAnchor(anchorPath), registered, skipped, createdAnchor };
}

/** Preset version in play, exported for `doctor` to compare against config. */
export { PRESET_VERSION };
