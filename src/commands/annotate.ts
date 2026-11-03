/**
 * `skillo annotate` — record where a skill came from.
 *
 * Annotations outrank a bare `.git` directory but lose to machine-written
 * evidence (`skills-lock.json`, marketplace metadata). They exist for skills
 * installed before anyone kept a ledger.
 */

import type { Env, SkillSource } from '../types.ts';
import { readAnnotations, readConfig, writeAnnotations } from '../core/config.ts';
import { scanSkills } from '../core/scan.ts';
import { EXIT, envError, usageError, type ExitCode } from '../util/errors.ts';

const VALID_SOURCES: readonly SkillSource[] = ['local', 'git', 'market', 'plugin'];

export interface AnnotateInput {
  env: Env;
  skill: string;
  source?: string;
  origin?: string;
}

export interface AnnotateOutcome {
  skill: string;
  source: SkillSource;
  origin: string | null;
  exitCode: ExitCode;
}

export function runAnnotate(input: AnnotateInput): AnnotateOutcome {
  const config = readConfig(input.env);
  if (config === null) {
    throw envError('not initialized yet', 'run skillo init to create the anchor and config');
  }

  const scan = scanSkills(config.ssotRoot);
  if (!scan.skills.some((skill) => skill.name === input.skill)) {
    throw usageError(
      `skill not found in the SSOT: ${input.skill}`,
      `available skills: ${scan.skills.map((skill) => skill.name).slice(0, 10).join(', ') || '(none)'}`,
    );
  }

  if (input.source === undefined) {
    throw usageError(
      'missing --source',
      `example: skillo annotate ${input.skill} --source git --origin owner/repo`,
    );
  }
  if (!VALID_SOURCES.includes(input.source as SkillSource)) {
    throw usageError(
      `unknown source: ${input.source}`,
      `allowed values: ${VALID_SOURCES.join(', ')}`,
    );
  }

  const annotations = readAnnotations(input.env);
  const source = input.source as SkillSource;
  const origin = input.origin ?? null;
  annotations.skills[input.skill] = {
    source,
    origin,
    annotatedAt: new Date().toISOString(),
  };
  writeAnnotations(input.env, annotations);

  return { skill: input.skill, source, origin, exitCode: EXIT.OK };
}
