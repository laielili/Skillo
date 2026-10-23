/**
 * Pure-function unit tests: no file system, no sandbox needed.
 *
 * These three modules are the only ones tested in isolation. They are boundary
 * dense (path traversal, CJK width) and getting them wrong has consequences
 * that a CLI-level test would not localise.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  defaultAnchor,
  expandHome,
  isInside,
  isUnc,
  samePath,
  skilloHome,
  toDisplay,
} from '../../src/core/paths.ts';
import { displayWidth, padDisplay, truncateDisplay } from '../../src/util/text.ts';

const isWindows = process.platform === 'win32';
/** Drive letters differ per platform; derive a stable base from the platform. */
const BASE = isWindows ? 'C:\\sandbox\\home' : '/sandbox/home';
const DRIVE = isWindows ? 'D:\\' : '/';

describe('expandHome', () => {
  test('bare tilde resolves to home', () => {
    assert.equal(expandHome('~', BASE), path.resolve(BASE));
  });

  test('tilde with forward slash', () => {
    assert.equal(expandHome('~/skills', BASE), path.resolve(BASE, 'skills'));
  });

  test('tilde with backslash (windows style)', () => {
    assert.equal(expandHome('~\\skills', BASE), path.resolve(BASE, 'skills'));
  });

  test('absolute path passes through', () => {
    const target = path.join(DRIVE, 'elsewhere');
    assert.equal(expandHome(target, BASE), path.resolve(target));
  });

  test('tilde inside a name is not expanded', () => {
    const weird = path.join(DRIVE, 'a~b');
    assert.equal(expandHome(weird, BASE), path.resolve(weird));
  });
});

describe('isInside', () => {
  const parent = path.join(DRIVE, 'skills');

  test('self counts as inside', () => {
    assert.equal(isInside(parent, parent), true);
  });

  test('direct child', () => {
    assert.equal(isInside(parent, path.join(parent, 'alpha')), true);
  });

  test('nested child', () => {
    assert.equal(isInside(parent, path.join(parent, 'alpha', 'deep')), true);
  });

  test('sibling with shared prefix is outside', () => {
    assert.equal(isInside(parent, path.join(DRIVE, 'skills-old')), false);
  });

  test('parent directory is outside', () => {
    assert.equal(isInside(parent, path.join(DRIVE)), false);
  });

  test('dot-dot traversal escapes', () => {
    const escaped = path.join(parent, '..', 'secret');
    assert.equal(isInside(parent, escaped), false);
  });

  test('deep traversal escapes', () => {
    const escaped = path.join(parent, 'a', '..', '..', 'secret');
    assert.equal(isInside(parent, escaped), false);
  });

  test('windows comparison is case insensitive', () => {
    if (!isWindows) return;
    assert.equal(isInside('D:\\Skills', 'd:\\skills\\alpha'), true);
  });
});

describe('isUnc', () => {
  test('backslash UNC', () => {
    assert.equal(isUnc('\\\\server\\share\\skills'), true);
  });

  test('forward slash UNC', () => {
    assert.equal(isUnc('//server/share/skills'), true);
  });

  test('drive letter is not UNC', () => {
    assert.equal(isUnc(path.join(DRIVE, 'skills')), false);
  });

  test('relative path is not UNC', () => {
    assert.equal(isUnc('skills\\a'), false);
  });
});

describe('samePath', () => {
  test('trailing separator is insignificant', () => {
    assert.equal(samePath(path.join(DRIVE, 'skills'), `${path.join(DRIVE, 'skills')}${path.sep}`), true);
  });

  test('different names differ', () => {
    assert.equal(samePath(path.join(DRIVE, 'a'), path.join(DRIVE, 'b')), false);
  });
});

describe('toDisplay', () => {
  test('home becomes tilde', () => {
    assert.equal(toDisplay(BASE, { home: BASE, cwd: BASE }), '~');
  });

  test('path under home is abbreviated', () => {
    const shown = toDisplay(path.join(BASE, 'skills'), { home: BASE, cwd: BASE });
    assert.ok(shown.startsWith('~'));
    assert.ok(shown.includes('skills'));
  });
});

describe('derived locations', () => {
  const env = { home: BASE, cwd: BASE };

  test('config dir hangs off home', () => {
    assert.equal(skilloHome(env), path.join(BASE, '.skillo'));
  });

  test('default anchor is the shared agents directory', () => {
    assert.equal(defaultAnchor(env), path.join(BASE, '.agents', 'skills'));
  });
});

describe('displayWidth', () => {
  test('latin counts one per char', () => {
    assert.equal(displayWidth('abc'), 3);
  });

  test('cjk counts two per char', () => {
    assert.equal(displayWidth('技能'), 4);
  });

  test('mixed content sums correctly', () => {
    assert.equal(displayWidth('a技b'), 4);
  });

  test('emoji counts two', () => {
    assert.equal(displayWidth('🤝'), 2);
  });
});

describe('padDisplay', () => {
  test('pads latin to width', () => {
    assert.equal(padDisplay('ab', 5), 'ab   ');
  });

  test('accounts for cjk width', () => {
    assert.equal(padDisplay('技能', 6), '技能  ');
  });

  test('never truncates longer text', () => {
    assert.equal(padDisplay('abcdef', 3), 'abcdef');
  });
});

describe('truncateDisplay', () => {
  test('leaves short text alone', () => {
    assert.equal(truncateDisplay('abc', 10), 'abc');
  });

  test('cuts and appends ellipsis', () => {
    const out = truncateDisplay('abcdefghij', 5);
    assert.ok(displayWidth(out) <= 5);
    assert.ok(out.endsWith('…'));
  });

  test('respects cjk width when cutting', () => {
    const out = truncateDisplay('技能技能技能', 5);
    assert.ok(displayWidth(out) <= 5);
  });
});
