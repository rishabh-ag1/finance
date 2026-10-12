// Pushes docs/spec.md, docs/rules.md and docs/changelog.md into the Google Sheet PRD.
// One-way: the repo is the source of truth. The "Open Questions" tab is never overwritten
// (founders type answers there; see scripts/pull-answers.ts).
// Usage: SPEC_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='{...}' npx tsx scripts/sync-spec-to-sheet.ts [--dry-run]
import { loadAll } from './lib/spec-md';
import { sheetsClient, q } from './lib/sheets';

const SKIP = new Set(['Open Questions']);
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const tables = loadAll(process.cwd()).filter(t => !SKIP.has(t.tab));
  if (dryRun) {
    for (const t of tables) console.log(`${t.tab}: ${t.rows.length} rows, ${t.header.length} cols (header row ${t.headerRow})`);
    return;
  }
  const { sheets, spreadsheetId } = sheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title),bandedRanges)' });
  const byTitle = new Map((meta.data.sheets ?? []).map(s => [s.properties!.title!, s]));

  for (const t of tables) {
    const sheet = byTitle.get(t.tab);
    if (!sheet) { console.warn(`Tab "${t.tab}" not in sheet, skipped. Add the tab by hand first.`); continue; }
    const width = t.header.length;
    const values = [t.header, ...t.rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''))];
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${q(t.tab)}!A${t.headerRow}:Z` });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${q(t.tab)}!A${t.headerRow}`, valueInputOption: 'RAW', requestBody: { values },
    });
    // Stretch the alternating-colour band to cover the new row count.
    const band = sheet.bandedRanges?.[0];
    if (band) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ updateBanding: {
          bandedRange: { bandedRangeId: band.bandedRangeId, range: {
            sheetId: sheet.properties!.sheetId, startRowIndex: t.headerRow - 1,
            endRowIndex: t.headerRow - 1 + values.length, startColumnIndex: 0, endColumnIndex: width } },
          fields: 'range' } }] },
      });
    }
    console.log(`Synced ${t.tab}: ${t.rows.length} rows`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
