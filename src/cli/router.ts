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

USAGE
  skillo <command> [options]

COMMANDS
  init                    First-time setup: create the anchor, detect harnesses
  list [skill]            Show how skills are distributed across harnesses
  link [skill...]         Distribute skills to harnesses
  unlink [skill...]       Remove distribution
  doctor [harness]        Diagnose and repair
  harness [list]          Show registered / addable harnesses
  harness add <id>        Register a harness (built-in preset or --path)
  harness remove <id>     Unregister a harness
  adopt                   Adopt real skill directories into the SSOT   (M4)
  ssot set <path>         Move the SSOT to a new location              (M6)
  annotate                Backfill skill provenance                    (M7)

OPTIONS
  --to <ids|all>          Target harnesses for link (default: all)
  --from <ids|all>        Source harnesses for unlink / adopt
  --path <dir>            Directory for harness add (defaults to preset)
  --name <label>          Display name for the harness
  --all                   Apply to every skill
  --replace               Redirect links that bypass the anchor (link)
  --fix                   Apply repairs (doctor)
  --dry-run               Print the plan, change nothing
  --json                  Machine-readable output
  --matrix                Skill x harness matrix (list)
  -h, --help              Show help
  -v, --version           Show version`;

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
      throw usageError('`annotate` is not implemented yet', 'this version ships init / list / link / unlink / doctor / adopt');
    case 'ssot':
      throw usageError('`ssot set` is not implemented yet', 'this version ships init / list / link / unlink / doctor / adopt');
    default:
      throw usageError(`unknown command: ${command}`, 'run skillo --help to see available commands');
  }
}

/* ─────────────────────────────── init ──────────────────────────────── */

function initCommand(args: ParsedArgs, env: Env): RunOutcome {
  const ssot = stringFlag(args, 'ssot');
  const result = runInit({ env, ...(ssot === undefined ? {} : { ssot }) });
  const palette = makePalette(colourEnabled(process.stdout));

  const lines: string[] = [];
  lines.push(`${palette.ok('✓')} initialized`);
  lines.push(`  ${palette.dim('Anchor')} ${toDisplay(result.config.anchor, env)}`);

  const { anchor } = result;
  if (anchor.mode === 'junction' && anchor.ssotRoot !== null) {
    lines.push(`  ${palette.dim('Points')} ${toDisplay(anchor.ssotRoot, env)}`);
  }
  lines.push(`  ${palette.dim('SSOT  ')} ${toDisplay(result.config.ssotRoot, env)}`);
  lines.push('');
  lines.push(`  ${palette.dim('Registered')} ${result.registered.length} harness(es)`);

  for (const harness of result.registered) {
    lines.push(`    ${palette.accent(harness.id)} ${palette.dim(harness.path)}`);
  }

  if (result.skipped.length > 0) {
    lines.push(`  ${palette.dim(`${result.skipped.length} not installed: ${result.skipped.join(', ')}`)}`);
  }
  if (result.nativeShared.length > 0) {
    lines.push(
      `  ${palette.ok('≡')} ${palette.dim('read the anchor natively, no registration needed: ')}${result.nativeShared.join(', ')}`,
    );
  }

  lines.push('');
  lines.push(`  ${palette.dim('Next')} skillo list`);

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
    lines.push(palette.dim('  nothing to do'));
  }

  lines.push('');
  const summary = [...totals.entries()].map(([action, count]) => `${count} ${action}`).join(' · ');
  lines.push(palette.dim(`  total ${summary === '' ? 'no changes' : summary}`));

  if ((totals.get('conflict') ?? 0) > 0) {
    lines.push('');
    lines.push(palette.dim('  real directories need `skillo adopt` to enter the SSOT (doctor never deletes them)'));
  }

  return `${lines.join('\n')}\n`;
}

/* ─────────────────────────────── adopt ─────────────────────────────── */

function adoptCommand(args: ParsedArgs, env: Env): RunOutcome {
  const from = stringFlag(args, 'from');
  if (from === undefined) {
    throw usageError('missing --from <harness>', 'example: skillo adopt --from workbuddy');
  }

  const keepRaw = stringFlag(args, 'keep');
  if (keepRaw !== undefined && keepRaw !== 'ssot' && keepRaw !== 'harness') {
    throw usageError(`--keep must be either ssot or harness, got: ${keepRaw}`);
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
    lines.push(palette.dim('  no real directories to adopt'));
    return `${lines.join('\n')}\n`;
  }

  const done = items.filter((item) => item.action.startsWith('adopted'));
  const conflicts = items.filter((item) => item.action === 'conflict');
  const diffs = items.filter((item) => item.action === 'diff');
  const skipped = items.filter((item) => item.action === 'skipped');
  const failed = items.filter((item) => item.action === 'failed');

  if (done.length > 0) {
    lines.push(palette.ok(`  ✓ adopted (${done.length})`));
    for (const item of done) {
      lines.push(`    ${padDisplay(item.skill, 28)}${palette.dim(item.action)}`);
      if (item.detail !== undefined) lines.push(`      ${palette.dim(item.detail)}`);
    }
    lines.push('');
  }

  if (conflicts.length > 0) {
    lines.push(palette.error(`  ! conflict (${conflicts.length})  pass --keep to continue`));
    for (const item of conflicts) {
      lines.push(`    ${padDisplay(item.skill, 28)}${palette.dim(item.detail ?? '')}`);
    }
    lines.push('');
    lines.push(palette.dim('  to resolve a conflict'));
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
    lines.push(palette.dim(`  · skipped ${skipped.length}`));
    for (const item of skipped) {
      lines.push(palette.dim(`    ${item.skill} — ${item.detail ?? ''}`));
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push(palette.error(`  ✗ failed ${failed.length}`));
    for (const item of failed) {
      lines.push(`    ${item.skill} — ${item.detail ?? ''}`);
    }
    lines.push('');
  }

  const trashPaths = items.filter((item) => item.trashPath !== undefined);
  if (trashPaths.length > 0) {
    lines.push(palette.dim('  replaced directories were moved to ~/.skillo/.trash/ and can be recovered by hand'));
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
          'missing harness id',
          'example: skillo harness add cursor   or   skillo harness add my-tool --path D:\\tools\\skills',
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
        `${palette.ok('✓')} added ${palette.accent(result.harness.id)} → ${toDisplay(result.harness.path, env)}`,
      ];
      if (result.createdDir) {
        lines.push(palette.dim('  the directory did not exist and was created'));
      }
      if (result.native) {
        lines.push(palette.dim('  reads the anchor natively: every skill is already visible, no link needed'));
      } else {
        lines.push(palette.dim(`  next: skillo link --all --to ${result.harness.id}`));
      }
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: EXIT.OK };
    }

    case 'remove': {
      const id = args.positionals[1];
      if (id === undefined) throw usageError('missing harness id', 'example: skillo harness remove cursor');

      const result = runHarnessRemove(env, id);
      const lines = [`${palette.ok('✓')} removed ${result.harness.id} (unregistered only, no files touched)`];
      if (result.leftoverEntries > 0) {
        lines.push(
          palette.dim(
            `  ${toDisplay(result.harness.path, env)} still holds ${result.leftoverEntries} entries; clean them up by hand if you want`,
          ),
        );
      }
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: EXIT.OK };
    }

    default:
      throw usageError(`unknown subcommand: harness ${sub}`, 'available: list / add / remove');
  }
}

function renderHarnessList(env: Env, palette: Palette): string {
  const result = runHarnessList(env);
  const lines: string[] = [];
  lines.push(palette.bold('harness'));
  lines.push('');

  lines.push(palette.dim(`  registered (${result.registered.length})`));
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
      ? palette.error('directory missing')
      : probe.native
        ? palette.dim('reads the anchor natively')
        : probe.isLink
          ? palette.warn(`directory itself is a link → ${probe.linkTarget ?? '?'}`)
          : '';
    lines.push(
      `    ${marker} ${padDisplay(probe.harness.id, 18)}${palette.dim(toDisplay(probe.harness.path, env))} ${note}`,
    );
  }

  if (result.addable.length > 0) {
    lines.push('');
    lines.push(palette.dim(`  addable (${result.addable.length})  directory exists but is not registered`));
    for (const entry of result.addable) {
      lines.push(`    ${padDisplay(entry.id, 18)}${palette.dim(toDisplay(entry.path, env))}`);
    }
    lines.push(palette.dim(`    skillo harness add ${result.addable[0]?.id ?? '<id>'}`));
  }

  if (result.nativePresets.length > 0) {
    lines.push('');
    lines.push(palette.dim(`  read the anchor natively (${result.nativePresets.length})  nothing to add, all skills already visible`));
    lines.push(palette.dim(`    ${result.nativePresets.join(', ')}`));
  }

  if (result.absent.length > 0) {
    lines.push('');
    lines.push(palette.dim(`  built-in presets not installed on this machine (${result.absent.length})`));
    lines.push(palette.dim(`    ${result.absent.join(', ')}`));
  }

  lines.push('');
  lines.push(palette.dim('  custom: skillo harness add <id> --path <dir>'));
  lines.push(palette.dim('  14 built-in presets are available; add one with skillo harness add <id>'));

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
    lines.push(`${palette.ok('✓')} repaired: ${outcome.repaired.join(', ')}`);
    if (outcome.relinked > 0) {
      lines.push(palette.dim(`  rebuilt ${outcome.relinked} link(s)`));
    }
    lines.push(palette.dim('  run skillo list to confirm'));
  } else if (outcome.findings.some((finding) => finding.fixable)) {
    lines.push('');
    lines.push(palette.dim('  repairable issues found: run skillo doctor --fix'));
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
