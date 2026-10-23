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
    throw envError('尚未初始化', '运行 skillo init 建立锚点与配置');
  }

  if (!isDirectory(config.ssotRoot)) {
    throw envError(
      `SSOT 目录不存在：${config.ssotRoot}`,
      '可能是移动硬盘未挂载，或路径已被移动。恢复后再试',
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
          ? '锚点断链，目标不可达'
          : `锚点断链，原本指向 ${anchor.danglingTarget}`;
      break;
    case 'real-dir':
      anchorNote = '锚点是实体目录，未启用间接层（ssot set 需要额外确认）';
      break;
    case 'absent':
      anchorNote = '锚点不存在，所有链接都会失效';
      break;
    default:
      if (anchor.ssotRoot !== null && !samePath(anchor.ssotRoot, config.ssotRoot)) {
        anchorNote = `锚点指向 ${anchor.ssotRoot}，与配置记录不一致`;
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
      throw usageError(`找不到技能：${input.skill}`, suggest(input.skill, rows));
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
    return '运行 skillo list 查看全部技能';
  }
  return `你是不是想找：${close.join('、')}`;
}
