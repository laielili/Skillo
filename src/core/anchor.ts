/**
 * Anchor state detection.
 *
 * The anchor is the single indirection between harness links and the SSOT. Its
 * four states are not cosmetic: `broken` in particular must never be treated as
 * `absent`, because recreating the directory would make the user believe their
 * skills vanished.
 */

import type { AnchorInfo, AnchorMode } from '../types.ts';
import {
  createJunction,
  lstatOrNull,
  moveSibling,
  readlinkOrNull,
  realpathOrNull,
  removeJunction,
  renamePath,
} from './fs-safe.ts';
import { samePath } from './paths.ts';
import { envError } from '../util/errors.ts';

export function detectAnchor(anchorPath: string): AnchorInfo {
  const st = lstatOrNull(anchorPath);

  if (st === null) {
    return { mode: 'absent', anchorPath, ssotRoot: null, danglingTarget: null };
  }

  if (!st.isSymbolicLink()) {
    return {
      mode: 'real-dir',
      anchorPath,
      ssotRoot: realpathOrNull(anchorPath) ?? anchorPath,
      danglingTarget: null,
    };
  }

  const resolved = realpathOrNull(anchorPath);
  if (resolved === null) {
    // `readlink` still reports the original target on a dangling link, which is
    // the difference between "your drive is not mounted" and "something is broken".
    return {
      mode: 'broken',
      anchorPath,
      ssotRoot: null,
      danglingTarget: readlinkOrNull(anchorPath),
    };
  }

  return { mode: 'junction', anchorPath, ssotRoot: resolved, danglingTarget: null };
}

export interface AnchorSwitch {
  anchorPath: string;
  previousMode: AnchorMode;
  previousTarget: string | null;
  /** Where a real-directory anchor was moved, if one had to be replaced. */
  backupPath: string | null;
}

/**
 * Point the anchor at a new SSOT, rolling back on failure.
 *
 * A junction is deleted and recreated (Windows junctions cannot be retargeted).
 * A real-directory anchor is renamed aside first, so the skills it held are
 * never deleted in place.
 */
export function switchAnchorTarget(
  anchorPath: string,
  newTarget: string,
  backupSuffix: string,
): AnchorSwitch {
  const before = detectAnchor(anchorPath);

  if (before.mode === 'absent') {
    throw envError(
      `anchor does not exist: ${anchorPath}`,
      'run skillo init first, then retry the migration',
    );
  }
  if (before.mode === 'broken') {
    throw envError(
      `anchor link is broken: ${anchorPath}`,
      `it used to point at ${before.danglingTarget ?? '(unknown)'}. restore that path or remove the broken link first`,
    );
  }

  if (before.mode === 'real-dir') {
    const backupPath = moveSibling(anchorPath, backupSuffix);
    try {
      createJunction(newTarget, anchorPath);
    } catch (err) {
      try {
        renamePath(backupPath, anchorPath);
      } catch (rollbackErr) {
        throw envError(
          `failed to convert the anchor and could not move the original directory back: ${anchorPath}`,
          `the original content is at ${backupPath}; move it back by hand`,
          `${reason(err)} / rollback: ${reason(rollbackErr)}`,
        );
      }
      throw envError(
        `failed to convert the anchor to a junction: ${anchorPath}`,
        'the original directory was restored, nothing was lost',
        reason(err),
      );
    }
    return {
      anchorPath,
      previousMode: 'real-dir',
      previousTarget: before.ssotRoot,
      backupPath,
    };
  }

  const previousTarget = before.ssotRoot;
  if (previousTarget === null) {
    throw envError(`anchor target is unreadable: ${anchorPath}`);
  }

  removeJunction(anchorPath);
  try {
    createJunction(newTarget, anchorPath);
  } catch (err) {
    try {
      createJunction(previousTarget, anchorPath);
    } catch (rollbackErr) {
      throw envError(
        `failed to repoint the anchor and could not rebuild the old link: ${anchorPath}`,
        `recreate a junction from ${anchorPath} to ${previousTarget} by hand`,
        `${reason(err)} / rollback: ${reason(rollbackErr)}`,
      );
    }
    throw envError(
      `failed to repoint the anchor, rolled back to ${previousTarget}`,
      'the old SSOT is still in place',
      reason(err),
    );
  }

  return {
    anchorPath,
    previousMode: 'junction',
    previousTarget,
    backupPath: null,
  };
}

/** Undo a successful switch, used when config writing or verification fails. */
export function restoreAnchor(switched: AnchorSwitch, currentTarget: string): void {
  if (switched.previousMode === 'junction' && switched.previousTarget !== null) {
    removeJunction(switched.anchorPath);
    createJunction(switched.previousTarget, switched.anchorPath);
    return;
  }

  if (switched.previousMode === 'real-dir' && switched.backupPath !== null) {
    removeJunction(switched.anchorPath);
    renamePath(switched.backupPath, switched.anchorPath);
    return;
  }

  throw envError(
    `cannot roll the anchor back automatically: ${switched.anchorPath}`,
    `restore it by hand so that it points at ${switched.previousTarget ?? currentTarget}`,
  );
}

/** Verify the anchor resolves to the expected target. */
export function anchorPointsAt(anchorPath: string, expected: string): boolean {
  const info = detectAnchor(anchorPath);
  return info.mode === 'junction' && info.ssotRoot !== null && samePath(info.ssotRoot, expected);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
