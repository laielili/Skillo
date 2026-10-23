/**
 * Anchor state detection.
 *
 * The anchor is the single indirection between harness links and the SSOT. Its
 * four states are not cosmetic: `broken` in particular must never be treated as
 * `absent`, because recreating the directory would make the user believe their
 * skills vanished.
 */

import type { AnchorInfo } from '../types.ts';
import { lstatOrNull, readlinkOrNull, realpathOrNull } from './fs-safe.ts';

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
