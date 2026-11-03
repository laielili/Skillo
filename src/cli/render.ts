/**
 * Command renderers.
 *
 * Kept out of the router so dispatch and presentation change for different
 * reasons. Pure string building: no file system, no config.
 */

import type { Env } from '../types.ts';
import type { Palette } from './output.ts';
import type { LinkItem } from '../commands/link.ts';
import type { AdoptItem } from '../commands/adopt.ts';
import type { DoctorFinding } from '../commands/doctor.ts';
import type { HarnessListResult } from '../commands/harness.ts';
import type { MigrateResult } from '../core/migrate.ts';
import { toDisplay } from '../core/paths.ts';
import { formatBytes, padDisplay } from '../util/text.ts';

export function renderLinkItems(
  items: readonly LinkItem[],
  palette: Palette,
  title: string,
  warnings: readonly string[] = [],
): string {
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

  for (const warning of warnings) {
    lines.push(palette.warn(`  ! ${warning}`));
  }

  return `${lines.join('\n')}\n`;
}

export function renderAdopt(items: readonly AdoptItem[], palette: Palette, harness: string, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(palette.bold(`adopt from ${harness}${dryRun ? ' (dry-run)' : ''}`));
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
    lines.push(palette.dim(`    skillo adopt ${harness} ${first} --diff`));
    lines.push(palette.dim(`    skillo adopt ${harness} ${first} --keep ssot`));
    lines.push(palette.dim(`    skillo adopt ${harness} ${first} --keep harness`));
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

  const retained = items.filter((item) => item.stagedPaths !== undefined);
  if (retained.length > 0) {
    lines.push(palette.warn('  packages left in ~/.skillo/.tmp/ — a verified transfer deletes them, so these mark unfinished work'));
    for (const item of retained) {
      for (const staged of item.stagedPaths ?? []) {
        lines.push(palette.dim(`    ${item.skill} → ${staged}`));
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function renderHarnessList(result: HarnessListResult, env: Env, palette: Palette): string {
  const lines: string[] = [];
  lines.push(palette.bold('harness'));
  lines.push('');

  if (result.direct.length > 0) {
    const shown = result.direct.slice(0, 8).map((entry) => entry.name).join(', ');
    const more = result.direct.length > 8 ? ', …' : '';
    lines.push(`Harnesses linked to Anchor directly: ${shown}${more}`);
    lines.push('');
  }

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

export function renderSsotSet(result: MigrateResult, env: Env, palette: Palette): string {
  const { plan } = result;
  const lines: string[] = [];
  lines.push(palette.bold(`ssot set${result.dryRun ? ' (dry-run)' : ''}`));
  lines.push('');
  lines.push(`  ${palette.dim('From  ')} ${toDisplay(plan.source, env)}`);
  lines.push(`  ${palette.dim('To    ')} ${toDisplay(plan.target, env)}`);
  lines.push(`  ${palette.dim('Anchor')} ${toDisplay(plan.anchorPath, env)}`);
  lines.push(`  ${palette.dim('Size  ')} ${plan.files} file(s) · ${formatBytes(plan.bytes)}`);
  lines.push(
    `  ${palette.dim('Free  ')} ${plan.free === null ? 'unknown' : formatBytes(plan.free)} on the target volume`,
  );
  lines.push('');

  if (result.dryRun) {
    lines.push(palette.dim('  copy → verify hashes → repoint the anchor → update config'));
    lines.push(
      palette.dim(
        `  the old SSOT would ${
          plan.keepOld ? `move to ${toDisplay(plan.backupHint ?? plan.source, env)}` : 'be deleted after verification'
        }`,
      ),
    );
    lines.push(palette.dim('  no changes made'));
  } else {
    lines.push(`${palette.ok('✓')} migrated`);
    lines.push(
      `  ${palette.dim('Copied')} ${result.copiedFiles} file(s) · ${formatBytes(result.copiedBytes)} · ${result.attempts} attempt(s)`,
    );
    lines.push(`  ${palette.dim('Anchor')} → ${toDisplay(plan.target, env)}`);
    if (result.oldSsotPath !== null) {
      lines.push(`  ${palette.dim('Old SSOT')} → ${toDisplay(result.oldSsotPath, env)}`);
    } else {
      lines.push(`  ${palette.dim('Old SSOT')} deleted`);
    }
    lines.push('');
    lines.push(palette.dim('  next: skillo list'));
    lines.push(palette.dim('        skillo doctor'));
  }

  for (const warning of result.warnings) {
    lines.push(palette.warn(`  ! ${warning}`));
  }

  return `${lines.join('\n')}\n`;
}

export function renderFinding(finding: DoctorFinding, palette: Palette): string {
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

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
