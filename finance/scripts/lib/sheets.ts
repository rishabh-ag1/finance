import { google, sheets_v4 } from 'googleapis';

export function sheetsClient(): { sheets: sheets_v4.Sheets; spreadsheetId: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const spreadsheetId = process.env.SPEC_SHEET_ID;
  if (!raw || !spreadsheetId) throw new Error('Set GOOGLE_SERVICE_ACCOUNT_JSON and SPEC_SHEET_ID');
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId };
}

export const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
