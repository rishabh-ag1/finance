import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { UserError } from './http';

/** A spreadsheet cell as read from CSV or XLSX. */
export type Cell = string | number | Date | null | undefined;

/** First sheet of an .xlsx, or a .csv, as rows of cells (formula results and rich text as text). */
export async function readTableFile(fileName: string, content: Buffer): Promise<Cell[][]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) {
    return parseCsv(content.toString('utf8').replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: true }) as string[][];
  }
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(content as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    if (!sheet) throw new UserError('The workbook has no sheets');
    const table: Cell[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      table.push((row.values as Cell[]).slice(1).map((v) => {
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          const o = v as { text?: string; result?: Cell; richText?: { text: string }[] };
          return o.richText ? o.richText.map((t) => t.text).join('') : o.text ?? o.result ?? '';
        }
        return v;
      }));
    });
    return table;
  }
  throw new UserError('Upload a .csv or .xlsx file');
}

/** Header names compared without case, spaces or punctuation ("Settlement ID" = "settlement_id"). */
export const headerKey = (c: Cell) => String(c ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
