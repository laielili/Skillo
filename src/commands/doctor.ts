/**
 * `skillo doctor`
 *
 * Diagnoses, and with `--fix`, repairs. The repair set is deliberately narrow:
 * rebuild broken links, redirect links that bypass the anchor, create missing
 * harness directories, and detach whole-directory junctions. It never deletes
 * skill content, and it never touches entries it did not create.
 */

import type { Env, Harness } from '../types.ts';
import { detectAnchor } from '../core/anchor.ts';
import { readConfig } from '../core/config.ts';
import { ensureDir, lstatOrNull, readlinkOrNull, removeJunction } from '../core/fs-safe.ts';
import { buildRelations, isNativeHarness } from '../core/relation.ts';
import { scanSkills } from '../core/scan.ts';
import { EXIT, envError, type ExitCode } from '../util/errors.ts';
import { runLink } from './link.ts';

export type FindingCode =
  | 'anchor-ok'
  | 'anchor-real-dir'
  | 'anchor-broken'
  | 'harness-missing'
  | 'harness-ok'
  | 'harness-native'
  | 'harness-whole-dir'
  | 'links-broken'
  | 'links-foreign'
  | 'links-conflict'
  | 'links-invalid'
  | 'links-undistributed';

export interface DoctorFinding {
  scope: string;
  severity: 'ok' | 'warn' | 'error';
  code: FindingCode;
  message: string;
  detail?: string;
  fixable: boolean;
  /**
   * Concrete skills this finding is about.
   *
   * A repair must touch exactly the skills that are broken. Passing "all skills"
   * to `link` would also distribute skills the user deliberately left out, which
   * turns a repair into an unrequested policy change.
   */
  subjects?: string[];
}

export interface DoctorInput {
  env: Env;
  fix: boolean;
  dryRun: boolean;
  /** Restrict to a single harness id. */
  target?: string;
}

export interface DoctorOutcome {
  findings: DoctorFinding[];
  /** Codes that were actually repaired on this run. */
  repaired: FindingCode[];
  /** Set when a repair changed the link graph. */
  relinked: number;
  exitCode: ExitCode;
}

export function runDoctor(input: DoctorInput): DoctorOutcome {
  const { env } = input;
  const config = readConfig(env);
  if (config === null) {
    throw envError('not initialized yet', 'run skillo init to create the anchor and config');
  }

  const anchor = detectAnchor(config.anchor);
  const findings: DoctorFinding[] = [];

  /* ── anchor ── */
  if (anchor.mode === 'broken') {
    findings.push({
      scope: 'anchor',
      severity: 'error',
      code: 'anchor-broken',
      message: `anchor link is broken; it used to point at ${anchor.danglingTarget ?? '(unreadable)'}`,
      detail: 'restore that path and retry. doctor will not rebuild the anchor, because that would make content look like it vanished',
      fixable: false,
    });
  } else if (anchor.mode === 'real-dir') {
    findings.push({
      scope: 'anchor',
      severity: 'warn',
      code: 'anchor-real-dir',
      message: 'anchor is a real directory, no indirection layer',
      detail: '`ssot set` will need extra confirmation and cannot roll back to the old path',
      fixable: false,
    });
  } else if (anchor.mode === 'junction') {
    findings.push({
      scope: 'anchor',
      severity: 'ok',
      code: 'anchor-ok',
      message: `anchor junction → ${anchor.ssotRoot ?? '?'}`,
      fixable: false,
    });
  }

  if (anchor.ssotRoot === null) {
    return { findings, repaired: [], relinked: 0, exitCode: EXIT.ENV };
  }

  /* ── per harness ── */
  const selected = config.harnesses.filter(
    (harness) => input.target === undefined || harness.id === input.target,
  );

  for (const harness of selected) {
    // Native harnesses read the anchor directly: nothing to link, nothing to fix.
    if (isNativeHarness(harness, config.anchor, anchor.ssotRoot)) {
      findings.push({
        scope: harness.id,
        severity: 'ok',
        code: 'harness-native',
        message: 'reads the anchor natively, every skill is already visible',
        fixable: false,
      });
      continue;
    }
    findings.push(...inspectHarness(harness, config.ssotRoot, anchor.anchorPath, anchor.ssotRoot));
  }

  const needsFix = findings.some((finding) => finding.fixable && finding.severity !== 'ok');
  if (!input.fix || !needsFix) {
    return {
      findings,
      repaired: [],
      relinked: 0,
      exitCode: findings.some((finding) => finding.severity === 'error') ? EXIT.ENV : EXIT.OK,
    };
  }

  /* ── repair ── */
  const repaired: FindingCode[] = [];
  let relinked = 0;

  for (const finding of findings) {
    if (!finding.fixable) continue;
    const harness = selected.find((candidate) => candidate.id === finding.scope);
    if (harness === undefined) continue;

    switch (finding.code) {
      case 'harness-whole-dir': {
        if (input.dryRun) {
          repaired.push(finding.code);
          break;
        }
        detachWholeDir(harness);
        // Re-populate immediately: detaching without relinking would leave the
        // harness unable to see any skill, which is strictly worse than before.
        const result = runLink({
          env,
          skills: null,
          harnesses: [harness.id],
          dryRun: false,
          replaceForeign: false,
        });
        relinked += result.items.filter((item) => item.action === 'created').length;
        repaired.push(finding.code);
        break;
      }

      case 'links-broken':
      case 'links-foreign': {
        const result = runLink({
          env,
          // Repair only the affected skills. Everything else keeps its current
          // distribution — a fix must not silently widen what a tool can see.
          skills: finding.subjects ?? null,
          harnesses: [harness.id],
          dryRun: input.dryRun,
          replaceForeign: true,
        });
        relinked += result.items.filter(
          (item) => item.action === 'created' || item.action === 'replaced-broken',
        ).length;
        repaired.push(finding.code);
        break;
      }

      case 'harness-missing': {
        if (!input.dryRun) ensureDir(harness.path);
        repaired.push(finding.code);
        break;
      }

      default:
        break;
    }
  }

  return {
    findings,
    repaired,
    relinked,
    exitCode: EXIT.OK,
  };
}

function inspectHarness(harness: Harness, ssotRoot: string, anchorPath: string, anchorReal: string): DoctorFinding[] {
  const out: DoctorFinding[] = [];

  if (!harness.enabled) {
    out.push({
      scope: harness.id,
      severity: 'ok',
      code: 'harness-ok',
      message: 'disabled, skipped',
      fixable: false,
    });
    return out;
  }

  const st = lstatOrNull(harness.path);
  if (st === null) {
    out.push({
      scope: harness.id,
      severity: 'warn',
      code: 'harness-missing',
      message: `directory does not exist: ${harness.path}`,
      fixable: true,
    });
    return out;
  }

  if (st.isSymbolicLink()) {
    const target = readlinkOrNull(harness.path);
    out.push({
      scope: harness.id,
      severity: 'error',
      code: 'harness-whole-dir',
      message: `skills directory is itself a link (→ ${target ?? 'unreadable'})`,
      detail: 'per-skill links cannot work here; --fix detaches it and rebuilds per skill, during which the tool briefly sees no skills',
      fixable: true,
    });
    return out;
  }

  const scan = scanSkills(ssotRoot);
  const rows = buildRelations({
    skills: scan.skills,
    harnesses: [harness],
    anchorReal,
    anchorPath,
  });

  const broken = rows.filter((row) => row.cells.some((cell) => cell.state === 'broken')).map((row) => row.skill.name);
  const foreign = rows.filter((row) => row.cells.some((cell) => cell.state === 'foreign')).map((row) => row.skill.name);
  const conflict = rows.filter((row) => row.cells.some((cell) => cell.state === 'conflict')).map((row) => row.skill.name);
  const invalid = rows.filter((row) => row.cells.some((cell) => cell.state === 'invalid')).map((row) => row.skill.name);
  const undistributed = rows.filter((row) => row.cells.every((cell) => cell.state === 'absent')).length;

  if (broken.length > 0) {
    out.push({
      scope: harness.id,
      severity: 'error',
      code: 'links-broken',
      message: `${broken.length} broken link(s)`,
      detail: broken.slice(0, 8).join(', ') + (broken.length > 8 ? ' …' : ''),
      fixable: true,
      subjects: broken,
    });
  }

  if (foreign.length > 0) {
    out.push({
      scope: harness.id,
      severity: 'warn',
      code: 'links-foreign',
      message: `${foreign.length} link(s) bypass the anchor`,
      detail: `${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ' …' : ''} (they will break when the SSOT moves)`,
      fixable: true,
      subjects: foreign,
    });
  }

  if (conflict.length > 0) {
    out.push({
      scope: harness.id,
      severity: 'error',
      code: 'links-conflict',
      message: `${conflict.length} real director(ies) occupying the same name`,
      detail: `they need \`skillo adopt\` to enter the SSOT; doctor will not delete them: ${conflict.slice(0, 8).join(', ')}`,
      fixable: false,
      subjects: conflict,
    });
  }

  if (invalid.length > 0) {
    out.push({
      scope: harness.id,
      severity: 'error',
      code: 'links-invalid',
      message: `${invalid.length} file(s) occupying the same name`,
      detail: `not a directory; Skillo will not delete them: ${invalid.slice(0, 8).join(', ')}`,
      fixable: false,
      subjects: invalid,
    });
  }

  if (undistributed > 0) {
    out.push({
      scope: harness.id,
      severity: 'ok',
      code: 'links-undistributed',
      message: `${undistributed} skill(s) not distributed here`,
      fixable: false,
    });
  }

  if (out.length === 0) {
    out.push({
      scope: harness.id,
      severity: 'ok',
      code: 'harness-ok',
      message: 'healthy',
      fixable: false,
    });
  }

  return out;
}

/**
 * Replace a whole-directory link with a real directory.
 *
 * The link's target is not deleted — `removeJunction` uses `rmdir`, which only
 * unlinks. The caller is responsible for re-populating the directory right away.
 */
function detachWholeDir(harness: Harness): void {
  const st = lstatOrNull(harness.path);
  if (st === null || !st.isSymbolicLink()) return;

  removeJunction(harness.path);

  try {
    ensureDir(harness.path);
  } catch (err) {
    throw envError(
      `could not create the directory after detaching the whole-directory link: ${harness.path}`,
      'the old link target is still where it was; recreate that directory by hand, then run link again',
      err instanceof Error ? err.message : String(err),
    );
  }
}
