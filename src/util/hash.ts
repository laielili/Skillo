/**
 * Content hashing for directory trees.
 *
 * Used to prove a copy is byte-identical before anything is deleted. Hashes are
 * order-independent with respect to directory listing order (entries are sorted)
 * because `readdir` order is not guaranteed across file systems.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lstatOrNull } from '../core/fs-safe.ts';

export interface DirHashResult {
  /** Hex digest over relative paths and file contents. */
  hash: string;
  fileCount: number;
  /** Links that were skipped rather than followed. */
  skippedLinks: number;
}

export interface DirHashOptions {
  /**
   * File names to exclude at any depth.
   *
   * Needed because harness platforms drop their own bookkeeping into skill
   * directories (`_user_meta.json`, `_skillhub_meta.json`). Counting those as
   * content makes every marketplace-installed skill look divergent from the same
   * skill stored in the SSOT.
   */
  ignore?: ReadonlySet<string>;
}

/** Hash a directory tree's structure and contents. Links are not followed. */
export function dirHash(root: string, options: DirHashOptions = {}): DirHashResult {
  const hash = crypto.createHash('sha256');
  const ignore = options.ignore;
  let fileCount = 0;
  let skippedLinks = 0;

  walk(root, '');
  return { hash: hash.digest('hex'), fileCount, skippedLinks };

  function walk(absolute: string, relative: string): void {
    if (ignore !== undefined && relative !== '' && ignore.has(path.basename(absolute))) return;

    const st = lstatOrNull(absolute);
    if (st === null) return;

    if (st.isSymbolicLink()) {
      skippedLinks += 1;
      return;
    }

    if (st.isDirectory()) {
      hash.update(`d:${relative}\n`);
      const entries = fs.readdirSync(absolute).sort();
      for (const entry of entries) {
        walk(path.join(absolute, entry), relative === '' ? entry : `${relative}/${entry}`);
      }
      return;
    }

    hash.update(`f:${relative}:${st.size}\n`);
    hash.update(fs.readFileSync(absolute));
    hash.update('\n');
    fileCount += 1;
  }
}

/** Short hash for display purposes. */
export function shortHash(full: string): string {
  return full.slice(0, 12);
}
