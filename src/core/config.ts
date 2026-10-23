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

/** Values `annotations.json` is allowed to carry. Kept in sync with `SkillSource`. */
const VALID_SOURCES: ReadonlySet<string> = new Set(['local', 'git', 'market', 'plugin']);
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
      `config file is not valid JSON: ${file}`,
      'fix it, or delete it and run skillo init again. Skillo never overwrites it automatically',
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
    // Unknown or stale values (e.g. the retired `unknown`) are ignored rather than
    // passed through, so a hand-edited file cannot inject a value the renderer has
    // no label for. Falling back to the default is the correct degradation.
    if (typeof source !== 'string' || !VALID_SOURCES.has(source)) continue;
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
      `unsupported config version: ${String(obj['version'])} (${file})`,
      'this version only understands version: 1. for an old config, back it up and init again',
    );
  }

  const anchor = obj['anchor'];
  const ssotRoot = obj['ssotRoot'];
  if (typeof anchor !== 'string' || typeof ssotRoot !== 'string') {
    throw envError(`config is missing anchor or ssotRoot (${file})`, 'run skillo init again to rebuild the config');
  }

  const rawHarnesses = obj['harnesses'];
  if (!Array.isArray(rawHarnesses)) {
    throw envError(`harnesses in the config is not an array (${file})`);
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
