/**
 * Source provenance resolution.
 *
 * Order is deliberate: machine-written evidence (`skills-lock.json`, marketplace
 * metadata) outranks human annotations, which outrank a bare `.git` directory,
 * which outranks the default.
 *
 * The fallback is `local`, not `unknown`. From the user's side, "no trace of where
 * this came from" and "this is mine, it lives here" are the same situation: the
 * skill is present in the SSOT and nothing external will overwrite it. Calling it
 * `unknown` only produced a column full of question marks that answered nothing.
 * `skillo annotate` still exists for recording the real origin when it is known.
 */

import path from 'node:path';

import type { Env, Skill, SkillSource } from '../types.ts';
import { readAnnotations } from './config.ts';
import { isDirectory, readTextFile } from './fs-safe.ts';

interface LockEntry {
  source?: string;
  sourceType?: string;
  skillPath?: string;
}

export interface SourceDecision {
  source: SkillSource;
  origin: string | null;
}

/** Parse `skills-lock.json`, the ledger `npx skills` maintains at the SSOT root. */
export function readLockFile(ssotRoot: string): Record<string, LockEntry> {
  const raw = readTextFile(path.join(ssotRoot, 'skills-lock.json'));
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const skills = (parsed as { skills?: unknown }).skills;
    if (typeof skills !== 'object' || skills === null) return {};
    return skills as Record<string, LockEntry>;
  } catch {
    return {};
  }
}

interface MarketMeta {
  skillId?: string;
  name?: string;
}

function readMarketMeta(skillDir: string): MarketMeta | null {
  const raw = readTextFile(path.join(skillDir, '_skillhub_meta.json'));
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as MarketMeta;
  } catch {
    return null;
  }
}

export function resolveSources(skills: readonly Skill[], ssotRoot: string, env: Env): Skill[] {
  const lock = readLockFile(ssotRoot);
  const annotations = readAnnotations(env);

  return skills.map((skill) => {
    const fromLock = lock[skill.name];
    if (fromLock !== undefined) {
      return { ...skill, source: 'git' as const, origin: fromLock.source ?? null };
    }

    const meta = readMarketMeta(skill.path);
    if (meta !== null) {
      return { ...skill, source: 'market' as const, origin: meta.skillId ?? null };
    }

    const annotation = annotations.skills[skill.name];
    if (annotation !== undefined) {
      return { ...skill, source: annotation.source, origin: annotation.origin };
    }

    if (isDirectory(path.join(skill.path, '.git'))) {
      return { ...skill, source: 'git' as const, origin: null };
    }

    return { ...skill, source: 'local' as const, origin: null };
  });
}
