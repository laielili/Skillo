/**
 * `skillo harness` — inspect and manage harness registrations.
 *
 * Built-in presets cover the common tools, but a preset list can never be
 * complete: new agentic tools appear monthly, and existing ones move their skills
 * directory. `add` is therefore the escape hatch that keeps the preset table from
 * being a hardcoded limit.
 */

import path from 'node:path';
import fs from 'node:fs';

import type { Env, Harness } from '../types.ts';
import { readConfig, writeConfig } from '../core/config.ts';
import { ensureDir, isDirectory, lstatOrNull, readlinkOrNull, realpathOrNull } from '../core/fs-safe.ts';
import { expandHome, isUnc } from '../core/paths.ts';
import { isNativeHarness, isNativePath } from '../core/relation.ts';
import { HARNESS_PRESETS, PRESET_VERSION, findPreset, presetPath } from '../presets/harnesses.ts';
import { conflictError, envError, usageError } from '../util/errors.ts';

/** Ids become path segments and appear in output, so keep them boring. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface HarnessAddInput {
  env: Env;
  id: string;
  /** Omit to use the built-in preset path. */
  path?: string;
  name?: string;
}

export interface HarnessAddResult {
  harness: Harness;
  /** True when the directory had to be created. */
  createdDir: boolean;
  /** True when this harness reads the anchor directly and needs no links. */
  native: boolean;
}

export function runHarnessAdd(input: HarnessAddInput): HarnessAddResult {
  const config = readConfig(input.env);
  if (config === null) {
    throw envError('尚未初始化', '运行 skillo init 建立锚点与配置');
  }

  if (!ID_PATTERN.test(input.id)) {
    throw usageError(
      `harness id 只能包含小写字母、数字和连字符：${input.id}`,
      '例：claude-code / my-tool',
    );
  }

  if (config.harnesses.some((harness) => harness.id === input.id)) {
    throw conflictError(
      `harness 已注册：${input.id}`,
      `先 skillo harness remove ${input.id}，或改配置文件里的 path`,
    );
  }

  const preset = findPreset(input.id);
  const rawPath = input.path ?? (preset === undefined ? undefined : presetPath(preset, input.env));

  if (rawPath === undefined) {
    throw usageError(
      `未知 harness：${input.id}`,
      `自定义 harness 需要 --path。内置预设：${HARNESS_PRESETS.map((entry) => entry.id).join(', ')}`,
    );
  }

  const target = expandHome(rawPath, input.env.home);
  if (!path.isAbsolute(target)) {
    throw usageError(`路径必须是绝对路径：${target}`);
  }
  if (isUnc(target)) {
    throw usageError(
      `harness 路径不能是网络路径：${target}`,
      '链接需要建在该目录内部，而 junction 不支持 UNC 目标',
    );
  }

  let createdDir = false;
  if (!isDirectory(target)) {
    ensureDir(target);
    createdDir = true;
  }

  const presetState = preset === undefined ? 'custom' : input.path === undefined ? 'builtin' : 'overridden';

  const harness: Harness = {
    id: input.id,
    name: input.name ?? preset?.name ?? input.id,
    path: target,
    preset: presetState,
    enabled: true,
    presetVersion: PRESET_VERSION,
  };

  config.harnesses.push(harness);
  writeConfig(input.env, config);

  return {
    harness,
    createdDir,
    native: isNativeHarness(harness, config.anchor, realpathOrNull(config.anchor)),
  };
}

export interface HarnessRemoveResult {
  harness: Harness;
  /** Number of skill entries still sitting in that directory. */
  leftoverEntries: number;
}

export function runHarnessRemove(env: Env, id: string): HarnessRemoveResult {
  const config = readConfig(env);
  if (config === null) {
    throw envError('尚未初始化', '运行 skillo init 建立锚点与配置');
  }

  const index = config.harnesses.findIndex((harness) => harness.id === id);
  if (index < 0) {
    throw usageError(
      `未注册的 harness：${id}`,
      `已注册：${config.harnesses.map((harness) => harness.id).join(', ') || '(无)'}`,
    );
  }

  const [harness] = config.harnesses.splice(index, 1);
  if (harness === undefined) {
    throw usageError(`未注册的 harness：${id}`);
  }

  writeConfig(env, config);

  // The anchor itself is not leftover debris — it IS the SSOT. Telling the user
  // to "clean up" 21 entries there would be actively harmful advice.
  const native = isNativeHarness(harness, config.anchor, realpathOrNull(config.anchor));
  let leftoverEntries = 0;
  if (!native && isDirectory(harness.path)) {
    try {
      leftoverEntries = fs.readdirSync(harness.path).length;
    } catch {
      leftoverEntries = 0;
    }
  }

  return { harness, leftoverEntries };
}

export interface HarnessProbe {
  harness: Harness;
  exists: boolean;
  isLink: boolean;
  linkTarget: string | null;
  /** Reads the anchor directly — the directory being a link is expected here. */
  native: boolean;
}

export interface HarnessListResult {
  registered: HarnessProbe[];
  /** Presets whose directory exists but is NOT the anchor, so they can be added. */
  addable: Array<{ id: string; name: string; path: string }>;
  /** Presets that read the anchor directly — nothing to add or link. */
  nativePresets: string[];
  /** Presets with no directory on this machine. */
  absent: string[];
}

export function runHarnessList(env: Env): HarnessListResult {
  const config = readConfig(env);
  const registered: HarnessProbe[] = [];

  for (const harness of config?.harnesses ?? []) {
    const st = lstatOrNull(harness.path);
    registered.push({
      harness,
      exists: st !== null,
      isLink: st?.isSymbolicLink() === true,
      linkTarget: st?.isSymbolicLink() === true ? readlinkOrNull(harness.path) : null,
      native:
        config !== null && isNativeHarness(harness, config.anchor, realpathOrNull(config.anchor)),
    });
  }

  const known = new Set((config?.harnesses ?? []).map((harness) => harness.id));
  const addable: HarnessListResult['addable'] = [];
  const nativePresets: string[] = [];
  const absent: string[] = [];

  const anchorPath = config?.anchor;
  const anchorReal = anchorPath === undefined ? null : realpathOrNull(anchorPath);

  for (const preset of HARNESS_PRESETS) {
    if (known.has(preset.id)) continue;
    const candidate = presetPath(preset, env);
    if (!isDirectory(candidate)) {
      absent.push(preset.id);
      continue;
    }
    if (anchorPath !== undefined && isNativePath(candidate, anchorPath, anchorReal)) {
      nativePresets.push(preset.id);
      continue;
    }
    addable.push({ id: preset.id, name: preset.name, path: candidate });
  }

  return { registered, addable, nativePresets, absent };
}
