import fs from 'node:fs';
import path from 'node:path';
import type { TxnNature } from '@prisma/client';
import { natureFromLabel } from './nature';

/**
 * Reads the Category Master table straight from docs/spec.md, so the seeded categories are
 * always the documented ones (the docs are the source of truth, CLAUDE.md).
 */

export type CategoryMasterRow = {
  category: string;
  subCategory: string;
  nature: TxnNature;
  plGroup: string;
  note: string;
};

export const SPEC_PATH = path.resolve(__dirname, '../../../docs/spec.md');

function cells(line: string): string[] {
  // Split on pipes that are not escaped as \|
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|').replace(/<br>/g, ' '));
}

export function parseCategoryMaster(markdown: string): CategoryMasterRow[] {
  const start = markdown.indexOf('\n## Category Master');
  if (start < 0) throw new Error('docs/spec.md has no "## Category Master" section');
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf('\n## ', 3);
  const section = end < 0 ? rest : rest.slice(0, end);
  const tableLines = section.split('\n').filter((l) => l.trim().startsWith('|'));
  const [header, , ...body] = tableLines;
  const cols = cells(header).map((c) => c.toLowerCase());
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`Category Master has no "${name}" column`);
    return i;
  };
  const iCat = at('category');
  const iSub = at('sub-category');
  const iNature = at('nature');
  const iGroup = at('management p&l group');
  const iNote = at('note');
  return body.map((line) => {
    const c = cells(line);
    return {
      category: c[iCat],
      subCategory: c[iSub],
      nature: natureFromLabel(c[iNature]),
      plGroup: c[iGroup],
      note: c[iNote] ?? '',
    };
  });
}

export function readCategoryMaster(specPath = SPEC_PATH): CategoryMasterRow[] {
  return parseCategoryMaster(fs.readFileSync(specPath, 'utf8'));
}

export type CategorySeed = {
  name: string;
  natureDefault: TxnNature;
  sortOrder: number;
  subs: { name: string; natureOverride: TxnNature | null; plGroup: string; note: string }[];
};

/**
 * Groups rows into categories. A category's default nature is the nature most of its
 * sub-categories have (ties: the first one listed); sub-categories that differ keep an override.
 */
export function groupCategoryMaster(rows: CategoryMasterRow[]): CategorySeed[] {
  const order: string[] = [];
  const byCat = new Map<string, CategoryMasterRow[]>();
  for (const r of rows) {
    if (!byCat.has(r.category)) { byCat.set(r.category, []); order.push(r.category); }
    byCat.get(r.category)!.push(r);
  }
  return order.map((name, i) => {
    const subs = byCat.get(name)!;
    const counts = new Map<TxnNature, number>();
    for (const s of subs) counts.set(s.nature, (counts.get(s.nature) ?? 0) + 1);
    let natureDefault = subs[0].nature;
    for (const s of subs) if ((counts.get(s.nature) ?? 0) > (counts.get(natureDefault) ?? 0)) natureDefault = s.nature;
    return {
      name,
      natureDefault,
      sortOrder: (i + 1) * 10,
      subs: subs.map((s) => ({
        name: s.subCategory,
        natureOverride: s.nature === natureDefault ? null : s.nature,
        plGroup: s.plGroup,
        note: s.note,
      })),
    };
  });
}
