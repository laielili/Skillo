/**
 * `skillo list`
 *
 * The only command in M2, and the one that has to earn trust: everything it
 * prints is recomputed from the file system on every run. No cached relation
 * state exists to disagree with reality.
 */

import type { Env, SkilloConfig } from '../types.ts';
import { detectAnchor } from '../core/anchor.ts';
import { readConfig } from '../core/config.ts';
import { isDirectory } from '../core/fs-safe.ts';
import { samePath } from '../core/paths.ts';
import {
  buildRelations,
  countGroups,
  inspectHarnesses,
  isNativeHarness,
  nativeHarnessIds,
  scanHarnessEntries,
  type SkillRelations,
} from '../core/relation.ts';
import { scanSkills, ssotEntryNames } from '../core/scan.ts';
import { resolveSources } from '../core/source.ts';
import {
  colourEnabled,
  makePalette,
  renderDetail,
  renderHarnessView,
  renderMatrix,
  renderOverview,
  detailJson,
  harnessJson,
  listJson,
  type HarnessView,
  type ListView,
  type Palette,
} from '../cli/output.ts';
import { EXIT, envError, usageError, type ExitCode } from '../util/errors.ts';
import { assertNever } from '../util/assert.ts';

export interface ListInput {
  env: Env;
  /** Restrict to a single skill and render its detail view. */
  skill?: string;
  /** Render one harness's own directory instead of the SSOT's distribution. */
  harness?: string;
  matrix?: boolean;
  json?: boolean;
  palette?: Palette;
}

export interface ListOutcome {
  text: string;
  exitCode: ExitCode;
}

export function runList(input: ListInput): ListOutcome {
  const { env } = input;
  const palette = input.palette ?? makePalette(colourEnabled(process.stdout));

  const config = readConfig(env);
  if (config === null) {
    throw envError('not initialized yet', 'run skillo init to create the anchor and config');
  }

  if (!isDirectory(config.ssotRoot)) {
    throw envError(
      `SSOT directory does not exist: ${config.ssotRoot}`,
      'maybe an external drive is not mounted, or the path was moved. Restore it and retry',
    );
  }

  const anchor = detectAnchor(config.anchor);
  const anchorReal = anchor.ssotRoot;

  const warnings: string[] = [];
  let anchorNote: string | null = null;

  switch (anchor.mode) {
    case 'broken':
      anchorNote =
        anchor.danglingTarget === null
          ? 'anchor link is broken, target unreachable'
          : `anchor link is broken; it used to point at ${anchor.danglingTarget}`;
      break;
    case 'real-dir':
      anchorNote = 'anchor is a real directory, no indirection layer (ssot set needs extra confirmation)';
      break;
    case 'absent':
      anchorNote = 'anchor does not exist, every link will break';
      break;
    case 'junction':
      if (anchor.ssotRoot !== null && !samePath(anchor.ssotRoot, config.ssotRoot)) {
        anchorNote = `anchor points at ${anchor.ssotRoot}, which disagrees with the config`;
      }
      break;
    default:
      return assertNever(anchor.mode, 'unhandled anchor mode');
  }

  if (input.harness !== undefined) {
    return harnessDirectoryView(input, config, anchorReal, anchorNote, palette);
  }

  const scan = scanSkills(config.ssotRoot);
  warnings.push(...scan.warnings);

  const withSources = resolveSources(scan.skills, config.ssotRoot, env);
  const rows = buildRelations({
    skills: withSources,
    harnesses: config.harnesses,
    anchorReal,
    anchorPath: config.anchor,
  });

  const nativeIds = nativeHarnessIds(config.harnesses, config.anchor, anchorReal);
  const harnessNotes = inspectHarnesses(config.harnesses, nativeIds);

  if (input.skill !== undefined) {
    const target = rows.find((row) => row.skill.name === input.skill);
    if (target === undefined) {
      throw usageError(`skill not found: ${input.skill}`, suggest(input.skill, rows));
    }
    return {
      text:
        input.json === true
          ? `${JSON.stringify(detailJson(target, config.anchor), null, 2)}\n`
          : renderDetail(target, { env, palette, anchorPath: config.anchor }),
      exitCode: EXIT.OK,
    };
  }

  const view: ListView = {
    ssotRoot: config.ssotRoot,
    anchorPath: config.anchor,
    anchorNote,
    harnessNotes: harnessNotes.map((note) => note.message),
    nativeHarnessIds: nativeIds,
    harnesses: config.harnesses,
    rows,
    counts: countGroups(rows),
    warnings,
  };

  if (input.json === true) {
    return { text: `${JSON.stringify(listJson(view), null, 2)}\n`, exitCode: EXIT.OK };
  }

  if (input.matrix === true) {
    return { text: renderMatrix(rows, config.harnesses, { env, palette }), exitCode: EXIT.OK };
  }

  return { text: renderOverview(view, { env, palette }), exitCode: EXIT.OK };
}

/**
 * `skillo list --harness <id>`
 *
 * The inverse of the default view: it reads the harness's own directory, so the
 * skills the SSOT has never heard of are visible. That is how an installation
 * made outside Skillo gets discovered, and `adopt` is what it feeds.
 */
function harnessDirectoryView(
  input: ListInput,
  config: SkilloConfig,
  anchorReal: string | null,
  anchorNote: string | null,
  palette: Palette,
): ListOutcome {
  if (input.skill !== undefined) {
    throw usageError(
      '--harness lists a whole directory, not a single skill',
      'drop the skill name, or run skillo list <skill> without --harness',
    );
  }
  if (input.matrix === true) {
    throw usageError(
      '--harness cannot be combined with --matrix',
      'skillo list --matrix compares every harness at once',
    );
  }

  const harness = config.harnesses.find((candidate) => candidate.id === input.harness);
  if (harness === undefined) {
    throw usageError(
      `unknown harness: ${input.harness}`,
      'skillo harness list shows the registered ids',
      `registered: ${config.harnesses.map((candidate) => candidate.id).join(', ') || '(none)'}`,
    );
  }

  const native = isNativeHarness(harness, config.anchor, anchorReal);
  const notes = inspectHarnesses([harness], native ? [harness.id] : []).map((note) => note.message);
  if (!harness.enabled) notes.push(`${harness.id} is disabled, so link and list ignore it`);
  if (anchorNote !== null) notes.push(anchorNote);

  const view: HarnessView = {
    harness,
    ssotRoot: config.ssotRoot,
    native,
    notes,
    entries: scanHarnessEntries({
      harness,
      anchorPath: config.anchor,
      anchorReal,
      ssotNames: ssotEntryNames(config.ssotRoot),
    }),
  };

  if (input.json === true) {
    return { text: `${JSON.stringify(harnessJson(view), null, 2)}\n`, exitCode: EXIT.OK };
  }
  return { text: renderHarnessView(view, { env: input.env, palette }), exitCode: EXIT.OK };
}

/** Cheap suggestion: names sharing a prefix or a substring. */
function suggest(input: string, rows: readonly SkillRelations[]): string | undefined {
  const needle = input.toLowerCase();
  const close = rows
    .map((row) => row.skill.name)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.includes(needle) || needle.includes(lower);
    })
    .slice(0, 5);

  if (close.length === 0) {
    return 'run skillo list to see every skill';
  }
  return `did you mean: ${close.join(', ')}`;
}
