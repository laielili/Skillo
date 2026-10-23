# Skillo

> One skill, one source of truth, every agentic tool.

[README-ZH](README-ZH.md)

Every agentic tool keeps its own `skills/` directory, so one skill gets copied N times and drifts N ways — and nobody notices when a link breaks. Skillo fixes that with a single source of truth plus per-skill Windows junctions: skill content lives in exactly one place, harnesses read it through links, and one edit takes effect everywhere.

Compatible on Windows systems. Available commands: `init` / `list` / `link` / `unlink` / `doctor` / `harness` / `adopt`; `ssot set` and `annotate` are not implemented yet.

Design documents live in `plan/PRD.md`, `plan/SPEC.md` and `plan/TECH_DESIGN.md` (all in Chinese).

## Install

Published to npm: **[skillo](https://www.npmjs.com/package/skillo)**, requires Node ≥ 18.

```bash
npx skillo --help        # run it without installing
npm i -g skillo          # or install globally, then call skillo <command> directly
```

Three steps to get started. `init` writes `~/.skillo/config.json` and creates the anchor at `~/.agents/skills`; the third step adds `--dry-run`, which only prints the plan and touches no harness directory:

```bash
npx skillo init
npx skillo list
npx skillo link --dry-run     # drop --dry-run once the plan looks right
```

## Development mode

You do **not** need to compile during development. Imports in the source carry a `.ts` suffix and run directly through Node's native type stripping.

Prerequisites:

- Node **≥ 22.18** (type stripping is on by default). Confirm with `node -v`; this repo is verified on v22.22.2.
- Run from the repository root (the scripts in `package.json` use relative paths).
- Install dependencies: `npm install`. The `prepare` hook declares a build, but npm 12 blocks install scripts by default (`install-scripts ... blocked`), so it never actually runs; the dev flow does not need it.

```bash
npm run dev -- --help
npm run dev -- init
npm run dev -- list --matrix
npm run dev -- link find-skills --to [harness] --dry-run
```

The `--` between the command and its arguments is required, otherwise npm swallows the arguments.

## Build

```bash
npm run build     # tsc -p tsconfig.build.json → dist/
```

- Input `src/**/*.ts`, output `dist/**/*.js` (with `.js.map`); the entry point is `dist/bin/skillo.js`, the shebang is preserved, so `node dist/bin/skillo.js` works directly.
- `rewriteRelativeImportExtensions` rewrites the `.ts` suffix to `.js` at build time, so `dist/` runs on Node 18+ (the lower bound declared in `engines`); only dev mode needs 22.18+.
- To see source line numbers: `node --enable-source-maps dist/bin/skillo.js list`.

Other scripts:

| Command         | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `npm run check` | `tsc --noEmit` full type check                                        |
| `npm test`      | unit + integration tests (120 cases), each in a sandboxed `HOME`      |
| `npm link`      | register the local source as a global `skillo`, shadowing the npm one |

Note: npm 12 blocks install scripts such as `prepare` by default, so `npm link` does not rebuild — after installing you are still running whatever was in `dist/` **at that moment**. After changing the source, either run `npm run build` first, or just use `npm run dev --` while developing. Uninstall with `npm unlink -g skillo`.

By the same token, both `npx skillo` and a global `skillo` run the **published package**, not your local source. To confirm a local change works, trust only `npm run dev --`.

### Publishing

```bash
npm run build && npm pack --dry-run   # confirm dist is current and README is in the package
npm publish
```

npm 12 blocks `prepare`, so do not expect `npm publish` to build for you — run `npm run build` by hand first, otherwise you ship the stale code sitting in `dist/`.

## Command reference

```
skillo init                 create the anchor ~/.agents/skills, detect installed harnesses
skillo list [skill]         skill x harness distribution; --matrix for the matrix view
skillo link [skill...]      distribute to harnesses; defaults to all skills x all harnesses
skillo unlink [skill...]    remove distribution; deletes links only, never content
skillo doctor [harness]     diagnose broken links / conflicts / anchor problems; --fix repairs
skillo adopt --from <id>    adopt real skill directories from a harness into the SSOT
```

Common options: `--dry-run` prints the plan only, `--json` for machine-readable output, `-h` / `-v`. `list --json` gives machine-readable output.

## Doctor

`skillo doctor [harness]` scans in two layers, anchor → each harness, and only lists problems without changing anything; add `--fix` to actually repair, `--dry-run` to print the repairs without writing them. Pass a harness id to check just that one. Without `--fix`, any `error`-level finding makes the exit code non-zero, so it can be dropped into a scheduled job as a health check.

```
skillo doctor            # full diagnosis
skillo doctor [harness]  # one harness only
skillo doctor --dry-run  # only say what would be fixed
skillo doctor --fix      # actually fix
```

Findings come in three tiers:

| Tier    | Common findings                                                                                                    | Action               |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| ✓ ok    | anchor junction healthy / reads the anchor natively / disabled / N skill(s) not distributed                        | nothing to do        |
| ! warn  | anchor is a real directory / harness directory missing / N link(s) bypass the anchor                               | last two are fixable |
| ✗ error | anchor link broken / skills directory is itself a link / N broken link(s) / name taken by a real directory or file | see below            |

The repair set is deliberately narrow — exactly four things: **detach a whole-directory junction and rebuild it per skill immediately** (no gap is left, though for a moment that tool may see no skills), **rebuild broken links**, **redirect links that bypass the anchor back through it**, and **create missing harness directories**.

What it does **not** do matters just as much: it does not rebuild the anchor (rebuilding an empty one over a broken link makes skills look like they vanished); it deletes no skill content; it never widens your distribution — repairs for broken or anchor-bypassing links touch only the affected skills, and anything you deliberately left undistributed is not distributed as a side effect (the one exception is a whole-directory junction, which is rebuilt wholesale by nature); it leaves entries it did not create alone.

Two situations need a human: a real directory occupying the same name, which you resolve with `skillo adopt --from <harness>` to bring it into the SSOT; and a broken anchor, where you restore the original path (mount the drive again if it is unmounted) — doctor only tells you where it used to point. A **file** occupying the same name is likewise never deleted by Skillo; handle it by hand.

## Layout

```
src/
  bin/skillo.ts     process entry; only reads/writes stdout/stderr
  cli/              argument parsing, routing, coloured output
  commands/         init / list / link / unlink / doctor / adopt / harness
  core/             anchor detection, config persistence, scanning, relations, safe fs ops
  presets/          default harness path table
  util/             errors, frontmatter, hashing, text
test/
  unit/             pure functions
  integration/      full CLI runs inside a temporary HOME
```

Config lives in `~/.skillo/config.json` (written atomically; a corrupt file is reported rather than overwritten); directories replaced by `adopt` are moved to `~/.skillo/.trash/`.
