// Parses the docs/*.md spec files into tables keyed by Google Sheet tab name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Table = { tab: string; headerRow: number; header: string[]; rows: string[][] };

// Row (1-based) where each tab's header sits in the sheet; rows above it (title, subtitle) are never touched.
export const HEADER_ROW: Record<string, number> = { README: 4 };
const headerRowFor = (tab: string) => HEADER_ROW[tab] ?? 3;

export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length && (body[i + 1] === '|' || body[i + 1] === '\\')) {
      cur += body[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim().replace(/<br>/g, '\n'));
}

const isSeparator = (line: string) => /^\|?\s*:?-{3,}/.test(line.trim());

/** docs/spec.md: every `## Heading` is a tab; all table rows under it form that tab's table. */
export function parseSpec(path: string): Table[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const tables: Table[] = [];
  let cur: Table | null = null;
  for (const line of lines) {
    const h2 = line.match(/^## (.+?)\s*$/);
    if (h2) {
      cur = { tab: h2[1], headerRow: headerRowFor(h2[1]), header: [], rows: [] };
      tables.push(cur);
      continue;
    }
    if (!cur || !line.trim().startsWith('|') || isSeparator(line)) continue;
    const cells = splitRow(line);
    if (cur.header.length === 0) cur.header = cells;
    else if (cells.join('') === cur.header.join('')) continue; // repeated header of a sub-table
    else cur.rows.push(cells);
  }
  return tables.filter(t => t.header.length > 0);
}

/** docs/rules.md: `## BR-xx - Title` followed by `- **Field:** value` lines. */
export function parseRules(path: string): Table {
  const header = ['ID', 'Module', 'Rule', 'Trigger', 'Logic', 'Worked example', 'Confidence'];
  const rows: string[][] = [];
  let rec: Record<string, string> | null = null;
  const flush = () => { if (rec) rows.push(header.map(h => rec![h] ?? '')); };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = line.match(/^## (BR-\d+)\s+-\s+(.+?)\s*$/);
    if (h) { flush(); rec = { ID: h[1], Rule: h[2] }; continue; }
    const f = line.match(/^- \*\*(.+?):\*\*\s?(.*)$/);
    if (f && rec) {
      const v = f[2].replace(/\\\|/g, '|').replace(/\\\\/g, '\\').replace(/<br>/g, '\n');
      rec[f[1]] = v === '-' ? '' : v;
    }
  }
  flush();
  return { tab: 'Business Rules', headerRow: 3, header, rows };
}

/** A file holding a single markdown table (changelog, open questions). */
export function parseSingleTable(path: string, tab: string): Table {
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim().startsWith('|') && !isSeparator(l));
  const [header, ...rows] = lines.map(splitRow);
  return { tab, headerRow: headerRowFor(tab), header, rows };
}

export function loadAll(root: string): Table[] {
  return [
    ...parseSpec(join(root, 'docs/spec.md')),
    parseRules(join(root, 'docs/rules.md')),
    parseSingleTable(join(root, 'docs/changelog.md'), 'Change Log'),
  ];
}

export function toMarkdownTable(header: string[], rows: string[][]): string {
  const esc = (s: string) => (s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r/g, '').replace(/\n/g, '<br>');
  return [
    '| ' + header.map(esc).join(' | ') + ' |',
    '|' + header.map(() => '---').join('|') + '|',
    ...rows.map(r => '| ' + header.map((_, i) => esc(r[i] ?? '')).join(' | ') + ' |'),
  ].join('\n');
}
