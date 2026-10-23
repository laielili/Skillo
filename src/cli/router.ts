/**
 * Command router — the single testable seam.
 *
 * `runCli(argv, env)` returns everything the user would see instead of printing
 * directly, so integration tests can assert on exit codes and output against a
 * sandboxed environment. `bin/skillo.ts` is the only place that touches the real
 * process.
 */

import type { Env } from '../types.ts';
import { hasFlag, listFlag, parseArgs, stringFlag, type ParsedArgs } from './args.ts';
import { colourEnabled, makePalette, type Palette } from './output.ts';
import { runAdopt, type AdoptItem } from '../commands/adopt.ts';
import { runDoctor, type DoctorFinding } from '../commands/doctor.ts';
import { runHarnessAdd, runHarnessList, runHarnessRemove } from '../commands/harness.ts';
import { runInit } from '../commands/init.ts';
import { runLink, runUnlink, type LinkItem } from '../commands/link.ts';
import { runList } from '../commands/list.ts';
import { EXIT, SkilloError, toSkilloError, usageError, type ExitCode } from '../util/errors.ts';
import { toDisplay } from '../core/paths.ts';
import { padDisplay } from '../util/text.ts';

export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: ExitCode;
}

export const VERSION = '0.1.0';

export const HELP = `skillo — one skill, one source of truth, every agentic tool

用法
  skillo <command> [options]

命令
  init                    首次配置：建立锚点、探测已安装的 harness
  list [skill]          查看技能在各 harness 中的分布
  link [skill...]         把技能分发到 harness
  unlink [skill...]       撤销分发
  doctor [harness]        诊断并修复
  harness [list]          查看已注册 / 可添加的 harness
  harness add <id>        添加 harness（内置预设或 --path 自定义）
  harness remove <id>     取消注册
  adopt                   把 harness 里的实体技能纳入 SSOT   (M4)
  ssot set <path>         迁移 SSOT 到新位置                 (M6)
  annotate                补登记技能来源                     (M7)

选项
  --to <ids|all>          link 的目标 harness（默认 all）
  --from <ids|all>        unlink / adopt 的来源 harness
  --path <dir>            harness add 的目录（省略则用内置预设）
  --name <label>          harness 的显示名
  --all                   作用于全部技能
  --replace               把绕过锚点的链接重定向（link）
  --fix                   执行修复（doctor）
  --dry-run               只显示计划，不改动任何东西
  --json                  机器可读输出
  --matrix                技能 × harness 矩阵（list）
  -h, --help              显示帮助
  -v, --version           显示版本`;

export function runCli(argv: readonly string[], env: Env): RunOutcome {
  const args = parseArgs(argv);

  if (args.errors.length > 0) {
    return { stdout: '', stderr: `${args.errors.join('\n')}\n`, exitCode: EXIT.USAGE };
  }

  if (hasFlag(args, 'help') || hasFlag(args, 'h')) {
    return { stdout: `${HELP}\n`, stderr: '', exitCode: EXIT.OK };
  }
  if (hasFlag(args, 'version') || hasFlag(args, 'v')) {
    return { stdout: `${VERSION}\n`, stderr: '', exitCode: EXIT.OK };
  }

  if (args.command === null) {
    return { stdout: `${HELP}\n`, stderr: '', exitCode: EXIT.OK };
  }

  try {
    return dispatch(args.command, args, env);
  } catch (err) {
    return { stdout: '', stderr: formatError(err), exitCode: exitCodeOf(err) };
  }
}

function dispatch(command: string, args: ParsedArgs, env: Env): RunOutcome {
  switch (command) {
    case 'init':
      return initCommand(args, env);
    case 'list':
      return listCommand(args, env);
    case 'link':
      return linkCommand(args, env);
    case 'unlink':
      return unlinkCommand(args, env);
    case 'doctor':
      return doctorCommand(args, env);
    case 'adopt':
      return adoptCommand(args, env);
    case 'harness':
      return harnessCommand(args, env);
    case 'annotate':
      throw usageError('`annotate` 尚未实现', '当前版本包含 init / list / link / unlink / doctor / adopt');
    case 'ssot':
      throw usageError('`ssot set` 尚未实现', '当前版本包含 init / list / link / unlink / doctor / adopt');
    default:
      throw usageError(`未知命令：${command}`, '运行 skillo --help 查看可用命令');
  }
}

/* ─────────────────────────────── init ──────────────────────────────── */

function initCommand(args: ParsedArgs, env: Env): RunOutcome {
  const ssot = stringFlag(args, 'ssot');
  const result = runInit({ env, ...(ssot === undefined ? {} : { ssot }) });
  const palette = makePalette(colourEnabled(process.stdout));

  const lines: string[] = [];
  lines.push(`${palette.ok('✓')} 已初始化`);
  lines.push(`  ${palette.dim('锚点')}   ${toDisplay(result.config.anchor, env)}`);

  const { anchor } = result;
  if (anchor.mode === 'junction' && anchor.ssotRoot !== null) {
    lines.push(`  ${palette.dim('指向')}   ${toDisplay(anchor.ssotRoot, env)}`);
  }
  lines.push(`  ${palette.dim('SSOT')}   ${toDisplay(result.config.ssotRoot, env)}`);
  lines.push('');
  lines.push(`  ${palette.dim('已注册')} ${result.registered.length} 个 harness`);

  for (const harness of result.registered) {
    lines.push(`    ${palette.accent(harness.id)} ${palette.dim(harness.path)}`);
  }

  if (result.skipped.length > 0) {
    lines.push(`  ${palette.dim(`未安装 ${result.skipped.length} 个：${result.skipped.join(', ')}`)}`);
  }
  if (result.nativeShared.length > 0) {
    lines.push(
      `  ${palette.ok('≡')} ${palette.dim('原生读取锚点，无需注册：')}${result.nativeShared.join(', ')}`,
    );
  }

  lines.push('');
  lines.push(`  ${palette.dim('下一步')} skillo list`);

  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: EXIT.OK };
}

/* ─────────────────────────────── list ──────────────────────────────── */

function listCommand(args: ParsedArgs, env: Env): RunOutcome {
  const outcome = runList({
    env,
    matrix: hasFlag(args, 'matrix'),
    json: hasFlag(args, 'json'),
    ...(args.positionals[0] === undefined ? {} : { skill: args.positionals[0] }),
  });

  return { stdout: outcome.text, stderr: '', exitCode: outcome.exitCode };
}

/* ─────────────────────────────── link ──────────────────────────────── */

/** Treat `--to all` and an absent flag as "every enabled harness". */
function harnessSelection(args: ParsedArgs, flag: string): string[] | null {
  const list = listFlag(args, flag);
  if (list === undefined) return null;
  if (list.length === 1 && list[0] === 'all') return null;
  return list;
}

function skillSelection(args: ParsedArgs): string[] | null {
  if (hasFlag(args, 'all')) return null;
  return args.positionals.length === 0 ? null : args.positionals;
}

function linkCommand(args: ParsedArgs, env: Env): RunOutcome {
  const dryRun = hasFlag(args, 'dry-run');
  const outcome = runLink({
    env,
    skills: skillSelection(args),
    harnesses: harnessSelection(args, 'to'),
    dryRun,
    replaceForeign: hasFlag(args, 'replace'),
  });

  const palette = makePalette(colourEnabled(process.stdout));
  return {
    stdout: renderLinkItems(outcome.items, palette, dryRun ? 'link (dry-run)' : 'link'),
    stderr: '',
    exitCode: outcome.exitCode,
  };
}

function unlinkCommand(args: ParsedArgs, env: Env): RunOutcome {
  const dryRun = hasFlag(args, 'dry-run');
  const outcome = runUnlink({
    env,
    skills: skillSelection(args),
    harnesses: harnessSelection(args, 'from'),
    dryRun,
  });

  const palette = makePalette(colourEnabled(process.stdout));
  return {
    stdout: renderLinkItems(outcome.items, palette, dryRun ? 'unlink (dry-run)' : 'unlink'),
    stderr: '',
    exitCode: outcome.exitCode,
  };
}

function renderLinkItems(items: readonly LinkItem[], palette: Palette, title: string): string {
  const lines: string[] = [];
  lines.push(palette.bold(title));

  const byHarness = new Map<string, LinkItem[]>();
  for (const item of items) {
    const bucket = byHarness.get(item.harness) ?? [];
    bucket.push(item);
    byHarness.set(item.harness, bucket);
  }

  const totals = new Map<string, number>();

  for (const [harness, bucket] of byHarness) {
    const counts = new Map<string, number>();
    for (const item of bucket) counts.set(item.action, (counts.get(item.action) ?? 0) + 1);

    const parts: string[] = [];
    for (const [action, count] of counts) {
      totals.set(action, (totals.get(action) ?? 0) + count);
      const label = `${count} ${action}`;
      if (action === 'created' || action === 'unlinked' || action === 'replaced-broken') {
        parts.push(palette.ok(label));
      } else if (action === 'conflict' || action === 'failed' || action === 'refused-invalid') {
        parts.push(palette.error(label));
      } else {
        parts.push(palette.dim(label));
      }
    }

    lines.push(`  ${palette.accent(harness.padEnd(16))}${parts.join(palette.dim(' · '))}`);

    for (const item of bucket) {
      if (item.action === 'conflict' || item.action === 'failed' || item.action === 'refused-invalid') {
        lines.push(`    ${palette.error('!')} ${item.skill} ${palette.dim(item.detail ?? '')}`);
      }
    }
  }

  if (items.length === 0) {
    lines.push(palette.dim('  没有需要处理的项'));
  }

  lines.push('');
  const summary = [...totals.entries()].map(([action, count]) => `${count} ${action}`).join(' · ');
  lines.push(palette.dim(`  合计 ${summary === '' ? '无变化' : summary}`));

  if ((totals.get('conflict') ?? 0) > 0) {
    lines.push('');
    lines.push(palette.dim('  实体目录需要 skillo adopt 纳入 SSOT（doctor 不会删除它们）'));
  }

  return `${lines.join('\n')}\n`;
}

/* ─────────────────────────────── adopt ─────────────────────────────── */

function adoptCommand(args: ParsedArgs, env: Env): RunOutcome {
  const from = stringFlag(args, 'from');
  if (from === undefined) {
    throw usageError('缺少 --from <harness>', '例：skillo adopt --from workbuddy');
  }

  const keepRaw = stringFlag(args, 'keep');
  if (keepRaw !== undefined && keepRaw !== 'ssot' && keepRaw !== 'harness') {
    throw usageError(`--keep 只能是 ssot 或 harness，收到：${keepRaw}`);
  }

  const dryRun = hasFlag(args, 'dry-run');
  const outcome = runAdopt({
    env,
    from,
    skills: args.positionals.length === 0 ? null : args.positionals,
    keep: keepRaw ?? null,
    dryRun,
    diff: hasFlag(args, 'diff'),
  });

  const palette = makePalette(colourEnabled(process.stdout));
  return {
    stdout: renderAdopt(outcome.items, palette, from, dryRun),
    stderr: '',
    exitCode: outcome.exitCode,
  };
}

function renderAdopt(
  items: readonly AdoptItem[],
  palette: Palette,
  from: string,
  dryRun: boolean,
): string {
  const lines: string[] = [];
  lines.push(palette.bold(`adopt from ${from}${dryRun ? ' (dry-run)' : ''}`));
  lines.push('');

  if (items.length === 0) {
    lines.push(palette.dim('  没有可纳入的实体目录'));
    return `${lines.join('\n')}\n`;
  }

  const done = items.filter((item) => item.action.startsWith('adopted'));
  const conflicts = items.filter((item) => item.action === 'conflict');
  const diffs = items.filter((item) => item.action === 'diff');
  const skipped = items.filter((item) => item.action === 'skipped');
  const failed = items.filter((item) => item.action === 'failed');

  if (done.length > 0) {
    lines.push(palette.ok(`  ✓ 已纳入 (${done.length})`));
    for (const item of done) {
      lines.push(`    ${padDisplay(item.skill, 28)}${palette.dim(item.action)}`);
      if (item.detail !== undefined) lines.push(`      ${palette.dim(item.detail)}`);
    }
    lines.push('');
  }

  if (conflicts.length > 0) {
    lines.push(palette.error(`  ! 冲突 (${conflicts.length})  需指定 --keep 才能继续`));
    for (const item of conflicts) {
      lines.push(`    ${padDisplay(item.skill, 28)}${palette.dim(item.detail ?? '')}`);
    }
    lines.push('');
    lines.push(palette.dim('  冲突处置'));
    const first = conflicts[0]?.skill ?? '<skill>';
    lines.push(palette.dim(`    skillo adopt --from ${from} ${first} --diff`));
    lines.push(palette.dim(`    skillo adopt --from ${from} ${first} --keep ssot`));
    lines.push(palette.dim(`    skillo adopt --from ${from} ${first} --keep harness`));
    lines.push('');
  }

  if (diffs.length > 0) {
    for (const item of diffs) {
      lines.push(palette.bold(`  diff ${item.skill}`));
      lines.push(indent(item.diff ?? '', '    '));
      lines.push('');
    }
  }

  if (skipped.length > 0) {
    lines.push(palette.dim(`  · 跳过 ${skipped.length} 个`));
    for (const item of skipped) {
      lines.push(palette.dim(`    ${item.skill} — ${item.detail ?? ''}`));
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push(palette.error(`  ✗ 失败 ${failed.length} 个`));
    for (const item of failed) {
      lines.push(`    ${item.skill} — ${item.detail ?? ''}`);
    }
    lines.push('');
  }

  const trashPaths = items.filter((item) => item.trashPath !== undefined);
  if (trashPaths.length > 0) {
    lines.push(palette.dim('  被替换的原目录已移入 ~/.skillo/.trash/，需要时可手动取回'));
  }

  return `${lines.join('\n')}\n`;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/* ────────────────────────────── harness ────────────────────────────── */

function harnessCommand(args: ParsedArgs, env: Env): RunOutcome {
  const palette = makePalette(colourEnabled(process.stdout));
  const sub = args.positionals[0];

  switch (sub) {
    case undefined:
    case 'list':
      return { stdout: renderHarnessList(env, palette), stderr: '', exitCode: EXIT.OK };

    case 'add': {
      const id = args.positionals[1];
      if (id === undefined) {
        throw usageError(
          '缺少 harness id',
          '例：skillo harness add cursor   或   skillo harness add my-tool --path D:\\tools\\skills',
        );
      }
      const explicitPath = stringFlag(args, 'path');
      const explicitName = stringFlag(args, 'name');
      const result = runHarnessAdd({
        env,
        id,
        ...(explicitPath === undefined ? {} : { path: explicitPath }),
        ...(explicitName === undefined ? {} : { name: explicitName }),
      });

      const lines = [
        `${palette.ok('✓')} 已添加 ${palette.accent(result.harness.id)} → ${toDisplay(result.harness.path, env)}`,
      ];
      if (result.createdDir) {
        lines.push(palette.dim('  目录原本不存在，已创建'));
      }
      if (result.native) {
        lines.push(palette.dim('  该 harness 原生读取锚点，全部技能已可见，无需 link'));
      } else {
        lines.push(palette.dim(`  下一步 skillo link --all --to ${result.harness.id}`));
      }
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: EXIT.OK };
    }

    case 'remove': {
      const id = args.positionals[1];
      if (id === undefined) throw usageError('缺少 harness id', '例：skillo harness remove cursor');

      const result = runHarnessRemove(env, id);
      const lines = [`${palette.ok('✓')} 已移除 ${result.harness.id}（仅取消注册，未改动文件）`];
      if (result.leftoverEntries > 0) {
        lines.push(
          palette.dim(
            `  ${toDisplay(result.harness.path, env)} 里还有 ${result.leftoverEntries} 个条目，需要时手动清理`,
          ),
        );
      }
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: EXIT.OK };
    }

    default:
      throw usageError(`未知子命令：harness ${sub}`, '可用：list / add / remove');
  }
}

function renderHarnessList(env: Env, palette: Palette): string {
  const result = runHarnessList(env);
  const lines: string[] = [];
  lines.push(palette.bold('harness'));
  lines.push('');

  lines.push(palette.dim(`  已注册 (${result.registered.length})`));
  for (const probe of result.registered) {
    const marker = !probe.exists
      ? palette.error('✗')
      : probe.native
        ? palette.ok('≡')
        : probe.isLink
          ? palette.warn('~')
          : palette.ok('✓');
    // For a native harness, the directory being a link is expected — it IS the
    // anchor. Warning about it would contradict the `≡` marker.
    const note = !probe.exists
      ? palette.error('目录不存在')
      : probe.native
        ? palette.dim('原生读取锚点')
        : probe.isLink
          ? palette.warn(`目录本身是链接 → ${probe.linkTarget ?? '?'}`)
          : '';
    lines.push(
      `    ${marker} ${padDisplay(probe.harness.id, 18)}${palette.dim(toDisplay(probe.harness.path, env))} ${note}`,
    );
  }

  if (result.addable.length > 0) {
    lines.push('');
    lines.push(palette.dim(`  可添加 (${result.addable.length})  目录已存在但未注册`));
    for (const entry of result.addable) {
      lines.push(`    ${padDisplay(entry.id, 18)}${palette.dim(toDisplay(entry.path, env))}`);
    }
    lines.push(palette.dim(`    skillo harness add ${result.addable[0]?.id ?? '<id>'}`));
  }

  if (result.nativePresets.length > 0) {
    lines.push('');
    lines.push(palette.dim(`  原生读取锚点 (${result.nativePresets.length})  无需添加，已能看到全部技能`));
    lines.push(palette.dim(`    ${result.nativePresets.join(', ')}`));
  }

  if (result.absent.length > 0) {
    lines.push('');
    lines.push(palette.dim(`  内置预设但本机未安装 (${result.absent.length})`));
    lines.push(palette.dim(`    ${result.absent.join(', ')}`));
  }

  lines.push('');
  lines.push(palette.dim('  自定义：skillo harness add <id> --path <目录>'));
  lines.push(palette.dim('  内置预设共 13 个，用 skillo harness add <id> 直接添加'));

  return `${lines.join('\n')}\n`;
}

/* ────────────────────────────── doctor ─────────────────────────────── */

function doctorCommand(args: ParsedArgs, env: Env): RunOutcome {
  const fix = hasFlag(args, 'fix');
  const outcome = runDoctor({
    env,
    fix,
    dryRun: hasFlag(args, 'dry-run'),
    ...(args.positionals[0] === undefined ? {} : { target: args.positionals[0] }),
  });

  const palette = makePalette(colourEnabled(process.stdout));
  const lines: string[] = [];
  lines.push(palette.bold(fix ? 'doctor --fix' : 'doctor'));

  for (const finding of outcome.findings) {
    lines.push(renderFinding(finding, palette));
  }

  if (outcome.repaired.length > 0) {
    lines.push('');
    lines.push(`${palette.ok('✓')} 已修复：${outcome.repaired.join(', ')}`);
    if (outcome.relinked > 0) {
      lines.push(palette.dim(`  重建 ${outcome.relinked} 个链接`));
    }
    lines.push(palette.dim('  运行 skillo list 确认结果'));
  } else if (outcome.findings.some((finding) => finding.fixable)) {
    lines.push('');
    lines.push(palette.dim('  有可修复项：运行 skillo doctor --fix'));
  }

  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: outcome.exitCode };
}

function renderFinding(finding: DoctorFinding, palette: Palette): string {
  const marker =
    finding.severity === 'ok'
      ? palette.ok('✓')
      : finding.severity === 'warn'
        ? palette.warn('!')
        : palette.error('✗');
  const head = `  ${marker} ${palette.accent(finding.scope.padEnd(14))}${finding.message}`;
  const tail = finding.detail === undefined ? '' : `\n      ${palette.dim(finding.detail)}`;
  return head + tail;
}

/* ────────────────────────────── helpers ────────────────────────────── */

function exitCodeOf(err: unknown): ExitCode {
  return err instanceof SkilloError ? err.exitCode : EXIT.GENERIC;
}

function formatError(err: unknown): string {
  const error = toSkilloError(err);
  const lines = [`✗ ${error.message}`];
  if (error.details !== undefined) lines.push(`  ${error.details}`);
  if (error.hint !== undefined) lines.push(`  ${error.hint}`);
  return `${lines.join('\n')}\n`;
}
