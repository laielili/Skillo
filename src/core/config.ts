/**
 * Configuration persistence.
 *
 * Two rules, both learned from tools that annoyed their users:
 *   - A corrupt config is reported, never silently overwritten. Overwriting
 *     destroys the only record of where the user pointed things.
 *   - Writes are atomic. A truncated JSON file reads as "no config" and would
 *     trigger a fresh init on top of a valid setup.
 */

import { envError } from '../util/errors.ts';
import type { Annotations, Env, Harness, SkilloConfig } from '../types.ts';
import { annotationsFile, configFile } from './paths.ts';
import { readTextFile, writeFileAtomic } from './fs-safe.ts';

/* ─────────────────────────────── reading ───────────────────────────── */

export function readConfig(env: Env): SkilloConfig | null {
  const file = configFile(env);
  const raw = readTextFile(file);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw envError(
      `配置文件不是合法 JSON：${file}`,
      '修复它，或删掉后重新运行 skillo init。Skillo 不会自动覆盖',
      err instanceof Error ? err.message : String(err),
    );
  }

  return validateConfig(parsed, file);
}

export function writeConfig(env: Env, config: SkilloConfig): void {
  writeFileAtomic(configFile(env), `${JSON.stringify(config, null, 2)}\n`);
}

export function readAnnotations(env: Env): Annotations {
  const file = annotationsFile(env);
  const raw = readTextFile(file);
  if (raw === null) return { version: 1, skills: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Annotations are advisory; a damaged file degrades to "nothing annotated"
    // rather than blocking every command.
    return { version: 1, skills: {} };
  }

  const record = asRecord(parsed);
  const skills = asRecord(record['skills']);
  const out: Annotations['skills'] = {};

  for (const [name, value] of Object.entries(skills)) {
    const entry = asRecord(value);
    const source = entry['source'];
    if (typeof source !== 'string') continue;
    out[name] = {
      source: source as Annotations['skills'][string]['source'],
      origin: typeof entry['origin'] === 'string' ? entry['origin'] : null,
      annotatedAt: typeof entry['annotatedAt'] === 'string' ? entry['annotatedAt'] : '',
    };
  }

  return { version: 1, skills: out };
}

export function writeAnnotations(env: Env, annotations: Annotations): void {
  writeFileAtomic(annotationsFile(env), `${JSON.stringify(annotations, null, 2)}\n`);
}

/* ───────────────────────────── validation ──────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function validateConfig(value: unknown, file: string): SkilloConfig {
  const obj = asRecord(value);

  if (obj['version'] !== 1) {
    throw envError(
      `配置版本不受支持：${String(obj['version'])}（${file}）`,
      '本版本只识别 version: 1。若是旧配置，请备份后重新 init',
    );
  }

  const anchor = obj['anchor'];
  const ssotRoot = obj['ssotRoot'];
  if (typeof anchor !== 'string' || typeof ssotRoot !== 'string') {
    throw envError(`配置缺少 anchor 或 ssotRoot（${file}）`, '重新运行 skillo init 可重建配置');
  }

  const rawHarnesses = obj['harnesses'];
  if (!Array.isArray(rawHarnesses)) {
    throw envError(`配置里的 harnesses 不是数组（${file}）`);
  }

  const harnesses: Harness[] = [];
  for (const item of rawHarnesses) {
    const rec = asRecord(item);
    const id = rec['id'];
    const harnessPath = rec['path'];
    if (typeof id !== 'string' || typeof harnessPath !== 'string') continue;

    const preset = rec['preset'];
    harnesses.push({
      id,
      name: typeof rec['name'] === 'string' ? rec['name'] : id,
      path: harnessPath,
      preset: preset === 'overridden' || preset === 'custom' ? preset : 'builtin',
      enabled: rec['enabled'] !== false,
      presetVersion: typeof rec['presetVersion'] === 'number' ? rec['presetVersion'] : 0,
    });
  }

  return { version: 1, anchor, ssotRoot, harnesses };
}
