#!/usr/bin/env node
/**
 * Process entry point.
 *
 * Deliberately thin: build the environment from the real process, delegate to
 * the router, write what it returns. Keeping this file free of logic is what
 * lets `runCli(argv, env)` serve as the single test seam.
 */

import os from 'node:os';
import process from 'node:process';

import { runCli } from '../cli/router.ts';
import type { Env } from '../types.ts';

const env: Env = {
  home: os.homedir(),
  cwd: process.cwd(),
};

const result = runCli(process.argv.slice(2), env);

if (result.stdout !== '') process.stdout.write(result.stdout);
if (result.stderr !== '') process.stderr.write(result.stderr);

process.exitCode = result.exitCode;
