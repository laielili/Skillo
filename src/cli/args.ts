/**
 * Argument parsing.
 *
 * Hand-rolled on purpose: eight commands and about twenty flags do not justify a
 * dependency in a binary that ships with zero runtime packages.
 *
 * Supported forms: `--key=value`, `--key value`, `--flag`, `-h`, `-v`, `--`.
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
  errors: string[];
}

/** Short flags that are always booleans, never take a value. */
const BOOLEAN_SHORT: ReadonlySet<string> = new Set(['h', 'v', 'y']);

/** Long flags that never consume the next token, even if it looks like a value. */
const BOOLEAN_LONG: ReadonlySet<string> = new Set([
  'help',
  'version',
  'json',
  'dry-run',
  'matrix',
  'all',
  'force',
  'fix',
  'verbose',
  'yes',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const errors: string[] = [];

  let index = 0;
  let command: string | null = null;
  let literal = false;

  while (index < argv.length) {
    const token = argv[index] ?? '';
    index += 1;

    if (literal) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      literal = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');

      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }

      if (BOOLEAN_LONG.has(body)) {
        flags.set(body, true);
        continue;
      }

      const next = argv[index];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1);
      if (BOOLEAN_SHORT.has(short)) {
        flags.set(short, true);
      } else if (short === 'a') {
        flags.set('to', 'all');
      } else {
        errors.push(`unknown option: -${short}`);
      }
      continue;
    }

    if (command === null) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags, errors };
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === 'true';
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** Parse a comma or space separated list flag, e.g. `--to a,b`. */
export function listFlag(args: ParsedArgs, name: string): string[] | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const parts = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}
