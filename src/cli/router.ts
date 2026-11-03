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
import { colourEnabled, makePalette } from './output.ts';
import { renderAdopt, renderFinding, renderHarnessList, renderLinkItems, renderSsotSet } from './render.ts';
import { runAdopt } from '../commands/adopt.ts';
import { runAnnotate } from '../commands/annotate.ts';
import { runDoctor } from '../commands/doctor.ts';
import { runHarnessAdd, runHarnessList, runHarnessRemove } from '../commands/harness.ts';
import { runInit } from '../commands/init.ts';
import { runLink, runUnlink } from '../commands/link.ts';
import { runList } from '../commands/list.ts';
import { runSsotSet } from '../commands/ssot.ts';
import { EXIT, SkilloError, toSkilloError, usageError, type ExitCode } from '../util/errors.ts';
import { toDisplay } from '../core/paths.ts';

export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: ExitCode;
}

export const VERSION = '0.1.6';

export const HELP = `skillo — one skill, one source of truth, every agentic tool

USAGE
  skillo <command> [options]

COMMANDS
  init                    First-time setup: create the anchor, detect harnesses
  list [skill]            Show how skills are distributed across harnesses
  list --harness <id>     Show every entry inside one harness, adopted or not
  link [skill...]         Distribute skills to harnesses
  unlink [skill...]       Remove distribution
  doctor [harness]        Diagnose and repair
  harness [list]          Show registered / addable harnesses
  harness add <id>        Register a harness (built-in preset or --path)
  harness remove <id>     Unregister a harness
  adopt <harness> [skill] Adopt real skill directories into the SSOT
  ssot set <path>         Move the SSOT to a new location
  annotate <skill>        Record where a skill came from

OPTIONS
  --to <ids|all>          Target harnesses for link (default: all)
  --from <ids|all>        Source harnesses for unlink
  --harness <id>          Scan one harness skills directory (list)
  --path <dir>            Directory for harness add (defaults to preset)
  --create                Create a missing skills directory (harness add)
  --name <label>          Display name for the harness
  --ssot <dir>            Adopt an existing SSOT during init
  --source <kind>         Provenance for annotate: local | git | market | plugin
  --origin <text>         Upstream identifier for annotate
  --all                   Apply to every skill
  --replace               Redirect links that bypass the anchor (link)
  --diff                  Show both versions of a conflicting skill (adopt)
  --keep <ssot|harness>   Which side wins when adopting a conflict
  --fix                   Apply repairs (doctor)
  --yes                   Confirm converting a real-directory anchor (ssot set)
  --keep-old              Keep the old SSOT as a renamed backup (ssot set)
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
    const error = toSkilloError(err);
    if (hasFlag(args, 'json')) {
      return {
        stdout: `${JSON.stringify(
          {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.hint === undefined ? {} : { hint: error.hint }),
            },
          },
          null,
          2,
        )}\n`,
        stderr: '',
        exitCode: error.exitCode,
      };
    }
    return { stdout: '', stderr: formatError(err), exitCode: error.exitCode };
  }
}

function jsonOutput(data: unknown, warnings: readonly string[] = []): string {
  return `${JSON.stringify({ ok: true, data, warnings }, null, 2)}\n`;
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
      return annotateCommand(args, env);
    case 'ssot':
      return ssotCommand(args, env);
    default:
      throw usageError(`unknown command: ${command}`, 'run skillo --help to see available commands');
  }
}

/* ─────────────────────────────── init ──────────────────────────────── */

function initCommand(args: ParsedArgs, env: Env): RunOutcome {
  const ssot = stringFlag(args, 'ssot');
  const result = runInit({ env, ...(ssot === undefined ? {} : { ssot }) });
  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput(result), stderr: '', exitCode: EXIT.OK };
  }
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
  // `--harness` with no value parses as a boolean; treating it as absent would
  // silently print the normal overview instead of the directory that was asked for.
  if (args.flags.get('harness') === true) {
    throw usageError('--harness needs a harness id', 'example: skillo list --harness workbuddy');
  }
  const harness = stringFlag(args, 'harness');

  const outcome = runList({
    env,
    matrix: hasFlag(args, 'matrix'),
    json: hasFlag(args, 'json'),
    ...(harness === undefined ? {} : { harness }),
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

  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput({ items: outcome.items, dryRun, warnings: outcome.warnings }), stderr: '', exitCode: outcome.exitCode };
  }

  const palette = makePalette(colourEnabled(process.stdout));
  return {
    stdout: renderLinkItems(outcome.items, palette, dryRun ? 'link (dry-run)' : 'link', outcome.warnings),
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

  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput({ items: outcome.items, dryRun, warnings: outcome.warnings }), stderr: '', exitCode: outcome.exitCode };
  }

  const palette = makePalette(colourEnabled(process.stdout));
  return {
    stdout: renderLinkItems(outcome.items, palette, dryRun ? 'unlink (dry-run)' : 'unlink', outcome.warnings),
    stderr: '',
    exitCode: outcome.exitCode,
  };
}

/* ─────────────────────────────── adopt ─────────────────────────────── */

function adoptCommand(args: ParsedArgs, env: Env): RunOutcome {
  const [harness, ...skills] = args.positionals;
  if (harness === undefined) {
    throw usageError('missing <harness>', 'example: skillo adopt workbuddy');
  }

  const keepRaw = stringFlag(args, 'keep');
  if (keepRaw !== undefined && keepRaw !== 'ssot' && keepRaw !== 'harness') {
    throw usageError(`--keep must be either ssot or harness, got: ${keepRaw}`);
  }

  const dryRun = hasFlag(args, 'dry-run');
  const outcome = runAdopt({
    env,
    harness,
    skills: skills.length === 0 ? null : skills,
    keep: keepRaw ?? null,
    dryRun,
    diff: hasFlag(args, 'diff'),
  });

  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput({ harness, items: outcome.items, dryRun }), stderr: '', exitCode: outcome.exitCode };
  }

  const palette = makePalette(colourEnabled(process.stdout));
  return {
    stdout: renderAdopt(outcome.items, palette, harness, dryRun),
    stderr: '',
    exitCode: outcome.exitCode,
  };
}

/* ────────────────────────────── harness ────────────────────────────── */

function harnessCommand(args: ParsedArgs, env: Env): RunOutcome {
  const palette = makePalette(colourEnabled(process.stdout));
  const sub = args.positionals[0];

  switch (sub) {
    case undefined:
    case 'list': {
      const result = runHarnessList(env);
      if (hasFlag(args, 'json')) {
        return { stdout: jsonOutput(result), stderr: '', exitCode: EXIT.OK };
      }
      return { stdout: renderHarnessList(result, env, palette), stderr: '', exitCode: EXIT.OK };
    }

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
        createDir: hasFlag(args, 'create'),
      });

      if (hasFlag(args, 'json')) {
        return { stdout: jsonOutput(result), stderr: '', exitCode: EXIT.OK };
      }

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
      if (hasFlag(args, 'json')) {
        return { stdout: jsonOutput(result), stderr: '', exitCode: EXIT.OK };
      }
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

/* ────────────────────────────── annotate ───────────────────────────── */

function annotateCommand(args: ParsedArgs, env: Env): RunOutcome {
  const skill = args.positionals[0];
  if (skill === undefined) {
    throw usageError(
      'missing skill name',
      'example: skillo annotate my-skill --source git --origin owner/repo',
    );
  }

  const source = stringFlag(args, 'source');
  const origin = stringFlag(args, 'origin');
  const outcome = runAnnotate({
    env,
    skill,
    ...(source === undefined ? {} : { source }),
    ...(origin === undefined ? {} : { origin }),
  });

  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput(outcome), stderr: '', exitCode: EXIT.OK };
  }

  const palette = makePalette(colourEnabled(process.stdout));
  const lines = [`${palette.ok('✓')} annotated ${palette.accent(outcome.skill)}`];
  lines.push(`  ${palette.dim('source')} ${outcome.source}`);
  if (outcome.origin !== null) lines.push(`  ${palette.dim('origin')} ${outcome.origin}`);
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: EXIT.OK };
}

/* ─────────────────────────────── ssot ──────────────────────────────── */

function ssotCommand(args: ParsedArgs, env: Env): RunOutcome {
  const sub = args.positionals[0];
  if (sub !== 'set') {
    throw usageError(
      `unknown ssot subcommand: ${sub ?? '(none)'}`,
      'available: skillo ssot set <path>',
    );
  }

  const target = args.positionals[1];
  if (target === undefined) {
    throw usageError('missing target path', 'example: skillo ssot set D:\\Projects\\Skills-moved');
  }

  const outcome = runSsotSet({
    env,
    target,
    dryRun: hasFlag(args, 'dry-run'),
    yes: hasFlag(args, 'yes'),
    keepOld: hasFlag(args, 'keep-old'),
  });

  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput(outcome.result), stderr: '', exitCode: outcome.exitCode };
  }

  const palette = makePalette(colourEnabled(process.stdout));
  return { stdout: renderSsotSet(outcome.result, env, palette), stderr: '', exitCode: outcome.exitCode };
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

  if (hasFlag(args, 'json')) {
    return { stdout: jsonOutput(outcome), stderr: '', exitCode: outcome.exitCode };
  }

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
