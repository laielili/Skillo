/**
 * Shared type definitions.
 *
 * Everything that touches the file system takes an {@link Env} rather than
 * reading `os.homedir()` directly. That single rule is what makes the whole
 * CLI testable through one seam — see `plan/SPEC.md` §Testing Decisions.
 */

/** Injected runtime environment. Tests substitute a sandbox. */
export interface Env {
  /** Stands in for the user's home directory. */
  home: string;
  /** Stands in for the process working directory. */
  cwd: string;
}

/** Where a skill's content came from. Decides whether updating will clobber local edits. */
export type SkillSource = 'local' | 'git' | 'market' | 'plugin';

export interface Skill {
  /** Directory name inside the SSOT; doubles as the unique id. */
  name: string;
  /** Absolute path inside the SSOT. */
  path: string;
  source: SkillSource;
  /** git: repository slug. market: marketplace skill id. Otherwise null. */
  origin: string | null;
  /** Taken from the SKILL.md frontmatter. */
  description: string;
  sizeBytes: number;
  mtimeMs: number | null;
}

/** Tracks whether a harness path still matches the built-in preset. */
export type PresetState = 'builtin' | 'overridden' | 'custom';

export interface Harness {
  id: string;
  /** Human-facing label, e.g. "Claude Code". */
  name: string;
  /** Absolute path to the harness's skills directory. */
  path: string;
  preset: PresetState;
  enabled: boolean;
  /** Bumped when a built-in path changes, so stale presets can be migrated. */
  presetVersion: number;
}

/**
 * State of a single skill inside a single harness.
 *
 * Exhaustive `switch` over this union is enforced by the compiler via a
 * `never` fallback — adding a seventh state breaks the build everywhere it
 * matters instead of silently rendering an empty string.
 */
export type RelationState =
  /** Points inside the anchor, SKILL.md readable. Healthy. */
  | 'linked'
  /** Points outside the anchor but resolves. Needs redirecting via `doctor --fix`. */
  | 'foreign'
  /** Link exists, target unreachable. Needs rebuilding. */
  | 'broken'
  /** A real directory occupies the name. Needs `adopt`. */
  | 'conflict'
  /** The name is taken by a file, not a directory. Needs a human. */
  | 'invalid'
  /** Nothing there. `link` may create it. */
  | 'absent';

/** State of the anchor directory itself. */
export type AnchorMode =
  /** Path does not exist. `init` will create it. */
  | 'absent'
  /** A junction pointing at the SSOT. The healthy state. */
  | 'junction'
  /** A plain directory — the indirection layer is not in use yet. */
  | 'real-dir'
  /** A junction whose target is unreachable (unmounted drive, deleted SSOT). */
  | 'broken';

export interface AnchorInfo {
  mode: AnchorMode;
  /** Absolute path of the anchor itself. */
  anchorPath: string;
  /** Resolved SSOT root. Null when the anchor is absent or broken. */
  ssotRoot: string | null;
  /** Where a broken anchor used to point, recovered via readlink. Null otherwise. */
  danglingTarget: string | null;
}

export interface SkilloConfig {
  version: 1;
  /** Absolute path of the anchor directory. */
  anchor: string;
  /** Absolute path of the real SSOT. Kept separately so a broken anchor is recoverable. */
  ssotRoot: string;
  harnesses: Harness[];
}

export interface Annotations {
  version: 1;
  skills: Record<string, { source: SkillSource; origin: string | null; annotatedAt: string }>;
}
