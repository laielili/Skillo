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
    throw envError('尚未初始化', '运行 skillo init 建立锚点与配置');
  }

  const anchor = detectAnchor(config.anchor);
  const findings: DoctorFinding[] = [];

  /* ── anchor ── */
  if (anchor.mode === 'broken') {
    findings.push({
      scope: 'anchor',
      severity: 'error',
      code: 'anchor-broken',
      message: `锚点断链，原本指向 ${anchor.danglingTarget ?? '(无法读取)'}`,
      detail: '恢复该路径后重试。doctor 不会重建锚点，因为那会让内容看起来消失了',
      fixable: false,
    });
  } else if (anchor.mode === 'real-dir') {
    findings.push({
      scope: 'anchor',
      severity: 'warn',
      code: 'anchor-real-dir',
      message: '锚点是实体目录，未启用间接层',
      detail: 'ssot set 迁移时需要额外确认，且无法回滚到旧路径',
      fixable: false,
    });
  } else if (anchor.mode === 'junction') {
    findings.push({
      scope: 'anchor',
      severity: 'ok',
      code: 'anchor-ok',
      message: `锚点 junction → ${anchor.ssotRoot ?? '?'}`,
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
        message: '原生读取锚点，全部技能已可见',
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
      message: '已禁用，跳过',
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
      message: `目录不存在：${harness.path}`,
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
      message: `skills 目录本身是链接（→ ${target ?? '无法读取'}）`,
      detail: '逐技能链接无法生效；--fix 会拆掉它并按技能重建，空窗期内该工具读不到技能',
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
      message: `${broken.length} 个链接断链`,
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
      message: `${foreign.length} 个链接绕过锚点`,
      detail: `${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ' …' : ''}（SSOT 迁移时会失效）`,
      fixable: true,
      subjects: foreign,
    });
  }

  if (conflict.length > 0) {
    out.push({
      scope: harness.id,
      severity: 'error',
      code: 'links-conflict',
      message: `${conflict.length} 个同名实体目录占位`,
      detail: `需要 skillo adopt 纳入 SSOT，doctor 不会删除它们：${conflict.slice(0, 8).join(', ')}`,
      fixable: false,
      subjects: conflict,
    });
  }

  if (invalid.length > 0) {
    out.push({
      scope: harness.id,
      severity: 'error',
      code: 'links-invalid',
      message: `${invalid.length} 个同名文件占位`,
      detail: `不是目录，Skillo 不会删除：${invalid.slice(0, 8).join(', ')}`,
      fixable: false,
      subjects: invalid,
    });
  }

  if (undistributed > 0) {
    out.push({
      scope: harness.id,
      severity: 'ok',
      code: 'links-undistributed',
      message: `${undistributed} 个技能未分发到此`,
      fixable: false,
    });
  }

  if (out.length === 0) {
    out.push({
      scope: harness.id,
      severity: 'ok',
      code: 'harness-ok',
      message: '正常',
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
      `拆掉整目录链接后无法创建目录：${harness.path}`,
      '原链接指向的目标仍在原处，请手动重建该目录后再运行 link',
      err instanceof Error ? err.message : String(err),
    );
  }
}
