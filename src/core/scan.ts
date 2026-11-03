/**
 * SSOT scanning.
 *
 * Reads the directory once and produces the skill list. No source resolution or
 * harness knowledge here — that layer is `source.ts` and `relation.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Skill } from '../types.ts';
import { lstatOrNull, readTextFile, treeSize } from './fs-safe.ts';
import { parseFrontmatter } from '../util/frontmatter.ts';

export interface ScanResult {
  skills: Skill[];
  /** Non-fatal oddities worth surfacing (missing manifest, unreadable entry). */
  warnings: string[];
}

/**
 * Names sitting at the SSOT root, without reading any skill content.
 *
 * Deliberately unfiltered: a plain file with the same name also stops `adopt`
 * from copying a directory in, so the caller wants to know about it too.
 */
export function ssotEntryNames(ssotRoot: string): Set<string> {
  try {
    return new Set(fs.readdirSync(ssotRoot));
  } catch {
    return new Set<string>();
  }
}

export function scanSkills(ssotRoot: string): ScanResult {
  const warnings: string[] = [];
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(ssotRoot).sort();
  } catch {
    return { skills, warnings: [`cannot read the SSOT directory: ${ssotRoot}`] };
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue;

    const dir = path.join(ssotRoot, name);
    const st = lstatOrNull(dir);
    if (st === null) continue;

    // Plain files at SSOT root (skills-lock.json) are bookkeeping, not skills.
    if (!st.isDirectory() && !st.isSymbolicLink()) continue;

    const manifest = readTextFile(path.join(dir, 'SKILL.md'));
    if (manifest === null) {
      warnings.push(`${name}: missing SKILL.md, skipped`);
      continue;
    }

    const front = parseFrontmatter(manifest);
    skills.push({
      name,
      path: dir,
      // Filled in by resolveSources(). `local` is the default because the skill
      // literally exists here — "we don't know where it came from" and "it lives
      // in your SSOT" describe the same situation from the user's side.
      source: 'local',
      origin: null,
      description: front.description ?? '',
      sizeBytes: treeSize(dir),
      mtimeMs: st.mtimeMs,
    });
  }

  return { skills, warnings };
}
