/**
 * `skillo list`
 *
 * The only command in M2, and the one that has to earn trust: everything it
 * prints is recomputed from the file system on every run. No cached relation
 * state exists to disagree with reality.
 */

import type { Env } from '../types.ts';
import { detectAnchor } from '../core/anchor.ts';
import { readConfig } from '../core/config.ts';
import { isDirectory } from '../core/fs-safe.ts';
import { samePath } from '../core/paths.ts';
import {
  buildRelations,
  countGroups,
  inspectHarnesses,
  nativeHarnessIds,
  type SkillRelations,
} from '../core/relation.ts';
import { scanSkills } from '../core/scan.ts';
import { resolveSources } from '../core/source.ts';
import {
  colourEnabled,
  makePalette,
  renderDetail,
  renderMatrix,
  renderOverview,
  listJson,
  type Palette,
  type ListView,
} from '../cli/output.ts';
import { EXIT, envError, usageError, type ExitCode } from '../util/errors.ts';

export interface ListInput {
  env: Env;
  /** Restrict to a single skill and render its detail view. */
  skill?: string;
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
    default:
      if (anchor.ssotRoot !== null && !samePath(anchor.ssotRoot, config.ssotRoot)) {
        anchorNote = `anchor points at ${anchor.ssotRoot}, which disagrees with the config`;
      }
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
      text: input.json === true ? jsonOf(target) : renderDetail(target, { env, palette }),
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

function jsonOf(row: SkillRelations): string {
  return `${JSON.stringify(
    {
      ok: true,
      data: {
        name: row.skill.name,
        path: row.skill.path,
        source: row.skill.source,
        origin: row.skill.origin,
        description: row.skill.description,
        group: row.group,
        cells: row.cells.map((cell) => ({ harness: cell.harnessId, state: cell.state })),
      },
      warnings: [],
    },
    null,
    2,
  )}\n`;
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
