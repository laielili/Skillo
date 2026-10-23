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
import { defaultAnchor, samePath } from '../core/paths.ts';
import { HARNESS_PRESETS, harnessFromPreset } from '../presets/harnesses.ts';
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
  /**
   * Presets whose skills directory is the anchor itself.
   *
   * Not registered on purpose: they already see every skill, so a config entry
   * would only add a line to the header. Telling the user is enough.
   */
  nativeShared: string[];
  createdAnchor: boolean;
}

export function runInit(input: InitInput): InitResult {
  const { env } = input;
  const anchorPath = defaultAnchor(env);
  const anchor = detectAnchor(anchorPath);

  if (anchor.mode === 'broken') {
    throw envError(
      `the anchor target is unreachable: ${anchorPath}`,
      anchor.danglingTarget === null
        ? 'the target path no longer exists. if it lives on an external drive, mount it first'
        : `it used to point at ${anchor.danglingTarget}. restore that path, or delete the broken link first`,
    );
  }

  let createdAnchor = false;
  let ssotRoot: string;

  if (input.ssot !== undefined) {
    ssotRoot = path.resolve(input.ssot);
    if (!isDirectory(ssotRoot)) {
      throw envError(`the given SSOT is not a directory: ${ssotRoot}`, 'create it first, or drop --ssot to use the current anchor');
    }
    // Creating the anchor is out of scope until `ssot set` exists; refuse rather
    // than silently write a config that points somewhere unwired.
    if (anchor.mode !== 'junction') {
      throw envError(
        `the anchor is currently ${anchor.mode} and is not wired to the given SSOT`,
        'run init once without --ssot to create the anchor, then use skillo ssot set to migrate',
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
    throw envError(`anchor target is not a directory: ${anchor.ssotRoot}`);
  }

  const registered: Harness[] = [];
  const skipped: string[] = [];
  const nativeShared: string[] = [];

  for (const preset of HARNESS_PRESETS) {
    const candidate = path.join(env.home, ...preset.segments);
    if (!isDirectory(candidate)) {
      skipped.push(preset.id);
      continue;
    }
    // A preset that points at the anchor needs no registration: it is already
    // reading the SSOT, and a config entry would only duplicate the header line.
    if (samePath(candidate, anchorPath) || samePath(candidate, ssotRoot)) {
      nativeShared.push(preset.id);
      continue;
    }
    registered.push(harnessFromPreset(preset, env));
  }

  const config: SkilloConfig = {
    version: 1,
    anchor: anchorPath,
    ssotRoot,
    harnesses: registered,
  };
  writeConfig(env, config);

  return { config, anchor: detectAnchor(anchorPath), registered, skipped, nativeShared, createdAnchor };
}
