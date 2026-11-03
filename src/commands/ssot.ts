/**
 * `skillo ssot set` — move the SSOT and retarget the anchor.
 *
 * Orchestration only; every file-system step lives in `core/migrate.ts` and
 * `core/fs-safe.ts`.
 */

import type { Env } from '../types.ts';
import { executeMigration, type MigrateResult } from '../core/migrate.ts';
import { EXIT, type ExitCode } from '../util/errors.ts';

export interface SsotSetInput {
  env: Env;
  target: string;
  dryRun: boolean;
  yes: boolean;
  keepOld: boolean;
}

export interface SsotSetOutcome {
  result: MigrateResult;
  exitCode: ExitCode;
}

export function runSsotSet(input: SsotSetInput): SsotSetOutcome {
  const result = executeMigration(input);
  return { result, exitCode: EXIT.OK };
}
