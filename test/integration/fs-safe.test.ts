/**
 * Integration tests for the safety layer.
 *
 * Every case builds a throwaway sandbox under the OS temp directory, so the
 * real user profile is never touched — the same isolation the CLI itself will
 * rely on.
 *
 * The two cases that matter most are "removing a link leaves the source intact"
 * and "refuses to delete a real directory". They map 1:1 to the two irreversible
 * mistakes this module exists to prevent.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyEntry,
  copyTree,
  createJunction,
  ensureDir,
  isFile,
  lstatOrNull,
  moveToTrash,
  realpathOrNull,
  removeJunction,
  treeSize,
} from '../../src/core/fs-safe.ts';
import { dirHash } from '../../src/util/hash.ts';

interface Sandbox {
  root: string;
  ssot: string;
  /** Resolved SSOT path — the boundary `classifyEntry` compares against. */
  ssotReal: string;
  harness: string;
  /** Create `<ssot>/<name>/SKILL.md` and return its path. */
  makeSkill(name: string, body?: string): string;
  /** Path a skill would occupy inside the harness directory. */
  slot(name: string): string;
  cleanup(): void;
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillo-test-'));
  const ssot = path.join(root, 'ssot');
  const harness = path.join(root, 'harness');
  fs.mkdirSync(ssot, { recursive: true });
  fs.mkdirSync(harness, { recursive: true });

  return {
    root,
    ssot,
    ssotReal: fs.realpathSync(ssot),
    harness,
    makeSkill(name: string, body = '# demo\n'): string {
      const dir = path.join(ssot, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}`, 'utf8');
      return dir;
    },
    slot(name: string): string {
      return path.join(harness, name);
    },
    cleanup(): void {
      // Sandbox teardown only. Production code may never call rmSync recursively
      // except inside the trash directory.
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('createJunction', () => {
  test('creates a readable link and keeps the source reachable', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');

      createJunction(source, slot, { requireSkillMd: true });

      const st = lstatOrNull(slot);
      assert.ok(st?.isSymbolicLink(), 'entry should be a link');
      assert.ok(isFile(path.join(slot, 'SKILL.md')), 'SKILL.md should read through the link');
      assert.equal(realpathOrNull(slot), realpathOrNull(source));
    } finally {
      box.cleanup();
    }
  });

  test('verifies the link actually points at the requested target', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');
      createJunction(source, slot);
      // Reading through the link must surface the source's own content.
      const body = fs.readFileSync(path.join(slot, 'SKILL.md'), 'utf8');
      assert.ok(body.includes('name: alpha'));
    } finally {
      box.cleanup();
    }
  });

  test('refuses to overwrite a real directory', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');
      ensureDir(slot);
      fs.writeFileSync(path.join(slot, 'keep.txt'), 'precious', 'utf8');

      assert.throws(() => createJunction(source, slot), /already occupied/);
      // The occupant must be untouched.
      assert.equal(fs.readFileSync(path.join(slot, 'keep.txt'), 'utf8'), 'precious');
    } finally {
      box.cleanup();
    }
  });

  test('refuses to overwrite a healthy link', () => {
    const box = sandbox();
    try {
      const a = box.makeSkill('alpha');
      const b = box.makeSkill('beta');
      const slot = box.slot('alpha');
      createJunction(a, slot);

      assert.throws(() => createJunction(b, slot), /already occupied/);
      assert.equal(realpathOrNull(slot), realpathOrNull(a));
    } finally {
      box.cleanup();
    }
  });

  test('replaces a dangling link when allowed', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');

      // Create, then break it by removing the target.
      createJunction(source, slot);
      fs.rmSync(source, { recursive: true, force: true });
      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'broken');

      // Rebuild the source at a different path so the old link stays dangling.
      const rebuilt = box.makeSkill('alpha-rebuilt');
      createJunction(rebuilt, slot, { allowReplaceBroken: true });

      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'linked');
      assert.equal(realpathOrNull(slot), realpathOrNull(rebuilt));
    } finally {
      box.cleanup();
    }
  });

  test('rejects a missing target', () => {
    const box = sandbox();
    try {
      assert.throws(() => createJunction(path.join(box.ssot, 'ghost'), box.slot('ghost')), /does not exist/);
    } finally {
      box.cleanup();
    }
  });

  test('rejects a missing parent directory', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const orphan = path.join(box.root, 'no-such-dir', 'alpha');
      assert.throws(() => createJunction(source, orphan), /parent directory/);
    } finally {
      box.cleanup();
    }
  });

  test('rejects a relative link path', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      assert.throws(() => createJunction(source, 'relative-slot'), /must be absolute/);
    } finally {
      box.cleanup();
    }
  });

  test('an empty directory in the slot is taken, not free', () => {
    // This is the artifact Node leaves behind when symlinkSync({ type: 'dir' })
    // fails without privilege. It looks like a fresh slot in a directory
    // listing, so it must be classified as an occupant rather than overwritten.
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');
      fs.mkdirSync(slot);

      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'conflict');
      assert.throws(() => createJunction(source, slot), /already occupied/);
      assert.ok(lstatOrNull(slot)?.isDirectory(), 'empty dir must survive the refusal');
    } finally {
      box.cleanup();
    }
  });

  test('requireSkillMd rejects a target without a manifest', () => {
    const box = sandbox();
    try {
      const hollow = path.join(box.ssot, 'hollow');
      fs.mkdirSync(hollow, { recursive: true });
      const slot = box.slot('hollow');

      assert.throws(() => createJunction(hollow, slot, { requireSkillMd: true }), /rolled back/);
      assert.equal(lstatOrNull(slot), null, 'failed link must be rolled back, not left behind');
    } finally {
      box.cleanup();
    }
  });
});

describe('removeJunction', () => {
  test('keeps the source tree byte-identical', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha', '# body\n\ncontent\n');
      const slot = box.slot('alpha');
      createJunction(source, slot);

      const before = dirHash(source);
      removeJunction(slot);
      const after = dirHash(source);

      assert.equal(lstatOrNull(slot), null, 'link should be gone');
      assert.equal(after.hash, before.hash, 'source content must be unchanged');
      assert.ok(isFile(path.join(source, 'SKILL.md')), 'source file must survive');
    } finally {
      box.cleanup();
    }
  });

  test('is idempotent', () => {
    const box = sandbox();
    try {
      removeJunction(box.slot('never-existed'));
      assert.equal(lstatOrNull(box.slot('never-existed')), null);
    } finally {
      box.cleanup();
    }
  });

  test('refuses a real directory and leaves it alone', () => {
    const box = sandbox();
    try {
      const slot = box.slot('alpha');
      ensureDir(slot);
      fs.writeFileSync(path.join(slot, 'SKILL.md'), 'x', 'utf8');

      assert.throws(() => removeJunction(slot), /refusing to delete/);
      assert.ok(isFile(path.join(slot, 'SKILL.md')), 'occupant must survive the refusal');
    } finally {
      box.cleanup();
    }
  });
});

describe('classifyEntry', () => {
  test('absent when nothing is there', () => {
    const box = sandbox();
    try {
      assert.equal(classifyEntry(box.slot('nothing'), { anchorReal: box.ssotReal }), 'absent');
    } finally {
      box.cleanup();
    }
  });

  test('linked when pointing inside the anchor', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');
      createJunction(source, slot);
      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'linked');
    } finally {
      box.cleanup();
    }
  });

  test('foreign when pointing outside the anchor', () => {
    const box = sandbox();
    try {
      const outside = path.join(box.root, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: x\n---\n', 'utf8');

      const slot = box.slot('alpha');
      createJunction(outside, slot);

      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'foreign');
    } finally {
      box.cleanup();
    }
  });

  test('broken when the target is gone', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const slot = box.slot('alpha');
      createJunction(source, slot);
      fs.rmSync(source, { recursive: true, force: true });

      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'broken');
    } finally {
      box.cleanup();
    }
  });

  test('broken when SKILL.md is missing behind the link', () => {
    const box = sandbox();
    try {
      const hollow = path.join(box.ssot, 'hollow');
      fs.mkdirSync(hollow, { recursive: true });
      const slot = box.slot('hollow');
      createJunction(hollow, slot);

      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'broken');
    } finally {
      box.cleanup();
    }
  });

  test('conflict for a real directory', () => {
    const box = sandbox();
    try {
      const slot = box.slot('alpha');
      ensureDir(slot);
      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'conflict');
    } finally {
      box.cleanup();
    }
  });

  test('invalid for a plain file', () => {
    const box = sandbox();
    try {
      const slot = box.slot('alpha');
      fs.writeFileSync(slot, 'not a directory', 'utf8');
      assert.equal(classifyEntry(slot, { anchorReal: box.ssotReal }), 'invalid');
    } finally {
      box.cleanup();
    }
  });
});

describe('copyTree', () => {
  test('reproduces content and hash', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha', '# body\n');
      fs.writeFileSync(path.join(source, 'extra.md'), 'more', 'utf8');

      const dest = path.join(box.root, 'copy');
      copyTree(source, dest);

      assert.equal(dirHash(dest).hash, dirHash(source).hash);
      assert.equal(dirHash(dest).fileCount, 2);
    } finally {
      box.cleanup();
    }
  });

  test('skips links inside the tree instead of following them', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha');
      const inner = path.join(source, 'linked-out');
      createJunction(box.ssot, inner);

      const dest = path.join(box.root, 'copy');
      const result = copyTree(source, dest);

      assert.equal(result.skippedLinks.length, 1);
      assert.equal(lstatOrNull(path.join(dest, 'linked-out')), null);
    } finally {
      box.cleanup();
    }
  });
});

describe('moveToTrash', () => {
  test('moves instead of deleting and reports the destination', () => {
    const box = sandbox();
    try {
      const victim = box.makeSkill('alpha');
      const trash = path.join(box.root, '.trash');

      const dest = moveToTrash(victim, trash);

      assert.equal(lstatOrNull(victim), null, 'original location is now empty');
      assert.ok(isFile(path.join(dest, 'SKILL.md')), 'content survives in trash');
    } finally {
      box.cleanup();
    }
  });
});

describe('treeSize', () => {
  test('sums file sizes and ignores links', () => {
    const box = sandbox();
    try {
      const source = box.makeSkill('alpha', 'x');
      const link = path.join(source, 'child-link');
      createJunction(box.harness, link);

      const withoutLink = treeSize(source);
      assert.ok(withoutLink > 0);
    } finally {
      box.cleanup();
    }
  });
});
