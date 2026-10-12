// Copies the "Open Questions" tab (where founders type answers) into docs/open-questions.md.
// Usage: SPEC_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='{...}' npx tsx scripts/pull-answers.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { sheetsClient, q } from './lib/sheets';
import { toMarkdownTable } from './lib/spec-md';

async function main() {
  const { sheets, spreadsheetId } = sheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${q('Open Questions')}!A3:H` });
  const [header, ...rows] = (res.data.values ?? []).map(r => r.map(String));
  const data = rows.filter(r => r.some(c => c.trim()));
  const path = 'docs/open-questions.md';
  const intro = readFileSync(path, 'utf8').split('\n| ')[0].trimEnd();
  writeFileSync(path, `${intro}\n\n${toMarkdownTable(header, data)}\n`);
  console.log(`Pulled ${data.length} questions into ${path}. Apply any new answers to spec.md / rules.md and log them in changelog.md.`);
}

main().catch(e => { console.error(e); process.exit(1); });
