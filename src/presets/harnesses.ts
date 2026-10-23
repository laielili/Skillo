/**
 * Built-in harness presets.
 *
 * Paths here are defaults, not law. Every harness tool has moved its skills
 * directory at least once (Windsurf sits under `.codeium`, Copilot uses
 * `.copilot` rather than `.github` globally), so the config records whether a
 * path is still `builtin` or has been `overridden` by the user. A future preset
 * migration may only touch `builtin` entries.
 */

import path from 'node:path';
import type { Env, Harness, PresetState } from '../types.ts';

export const PRESET_VERSION = 1;

export interface HarnessPreset {
  id: string;
  name: string;
  /** Path segments appended to `home`. */
  segments: readonly string[];
  /** Whether the location has been verified on a real machine. */
  verified: boolean;
}

/**
 * Ordered by likelihood of being installed. `verified` marks presets confirmed
 * on this machine (2026-10-23); the rest come from the `skills` CLI 1.7.0 agent
 * table and are unconfirmed here.
 */
export const HARNESS_PRESETS: readonly HarnessPreset[] = [
  { id: 'claude-code', name: 'Claude Code', segments: ['.claude', 'skills'], verified: true },
  // WorkBuddy is absent from the skills CLI table entirely — path confirmed here.
  { id: 'workbuddy', name: 'WorkBuddy', segments: ['.workbuddy', 'skills'], verified: true },
  { id: 'qoder', name: 'Qoder', segments: ['.qoder', 'skills'], verified: true },
  { id: 'codex', name: 'Codex', segments: ['.codex', 'skills'], verified: true },
  { id: 'cursor', name: 'Cursor', segments: ['.cursor', 'skills'], verified: false },
  { id: 'github-copilot', name: 'GitHub Copilot', segments: ['.copilot', 'skills'], verified: false },
  { id: 'gemini-cli', name: 'Gemini CLI', segments: ['.gemini', 'skills'], verified: false },
  { id: 'windsurf', name: 'Windsurf', segments: ['.codeium', 'windsurf', 'skills'], verified: false },
  { id: 'opencode', name: 'OpenCode', segments: ['.config', 'opencode', 'skills'], verified: false },
  { id: 'cline', name: 'Cline', segments: ['.cline', 'skills'], verified: false },
  { id: 'kiro-cli', name: 'Kiro CLI', segments: ['.kiro', 'skills'], verified: false },
  { id: 'amp', name: 'Amp', segments: ['.config', 'agents', 'skills'], verified: false },
  { id: 'hermes', name: 'Hermes', segments: ['.hermes', 'skills'], verified: false },
];

export function findPreset(id: string): HarnessPreset | undefined {
  return HARNESS_PRESETS.find((preset) => preset.id === id);
}

/** Absolute path a preset maps to for the given environment. */
export function presetPath(preset: HarnessPreset, env: Env): string {
  return path.join(env.home, ...preset.segments);
}

/** Build a harness record from a preset. */
export function harnessFromPreset(
  preset: HarnessPreset,
  env: Env,
  overrides: { path?: string; enabled?: boolean } = {},
): Harness {
  const defaultPath = presetPath(preset, env);
  const actualPath = overrides.path ?? defaultPath;
  const presetState: PresetState = overrides.path === undefined ? 'builtin' : 'overridden';

  return {
    id: preset.id,
    name: preset.name,
    path: actualPath,
    preset: presetState,
    enabled: overrides.enabled ?? true,
    presetVersion: PRESET_VERSION,
  };
}

/** Human label for a harness id, falling back to the raw id. */
export function harnessLabel(id: string): string {
  return findPreset(id)?.name ?? id;
}
