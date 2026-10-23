/**
 * Minimal YAML frontmatter reader.
 *
 * Deliberately not a YAML parser. SKILL.md frontmatter uses a tiny subset:
 * flat `key: value` pairs, occasionally a literal (`|`) or folded (`>`) block
 * for multi-line descriptions. Pulling in a full parser would add a dependency
 * to a tool whose whole point is having none.
 */

export interface Frontmatter {
  name: string | null;
  description: string | null;
  raw: Record<string, string>;
}

const KEY_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
    }
  }
  return trimmed;
}

export function parseFrontmatter(source: string): Frontmatter {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const lines = text.split(/\r?\n/);

  if ((lines[0] ?? '').trim() !== '---') {
    return { name: null, description: null, raw: {} };
  }

  const raw: Record<string, string> = {};
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '---') break;

    const match = KEY_LINE.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }

    const key = match[1];
    const rest = (match[2] ?? '').trim();
    if (key === undefined) {
      index += 1;
      continue;
    }
    index += 1;

    if (rest === '|' || rest === '>') {
      const folded = rest === '>';
      const collected: string[] = [];

      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (next.trim() === '---') break;
        // A non-indented, non-empty line starts the next key.
        if (next.length > 0 && !/^[ \t]/.test(next)) break;
        collected.push(next.trim());
        index += 1;
      }

      while (collected.length > 0 && collected[collected.length - 1] === '') {
        collected.pop();
      }

      raw[key] = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n');
      continue;
    }

    raw[key] = unquote(rest);
  }

  return {
    name: raw['name'] ?? null,
    description: raw['description'] ?? null,
    raw,
  };
}
