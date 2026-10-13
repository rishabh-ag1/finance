import jwt from 'jsonwebtoken';
import type { FileStorage } from './index';

/**
 * Google Drive storage (I14) through the Drive v3 REST API with a service account - no SDK, so
 * the backend stays light. Needs:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service account key (same variable the spec sync uses)
 *   DRIVE_ROOT_FOLDER_ID         a folder in a Shared Drive, shared with the service account
 *                                (service accounts have no storage of their own)
 * Folders /Finance/{FY}/{Module}/{Record} are created on demand under the root.
 * Written to the Drive v3 documentation; it runs only once these two settings are filled in.
 */

type ServiceAccount = { client_email: string; private_key: string };

export function driveConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !!process.env.DRIVE_ROOT_FOLDER_ID;
}

let cachedToken: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google sign-in for Drive failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function drive(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const res = await fetch(`https://www.googleapis.com${pathAndQuery}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Google Drive answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const folderCache = new Map<string, string>();

/** Finds or creates each folder of the path under the root folder. */
async function folderId(folderPath: string): Promise<string> {
  let parent = process.env.DRIVE_ROOT_FOLDER_ID!;
  let soFar = '';
  for (const name of folderPath.split('/').filter(Boolean)) {
    soFar += `/${name}`;
    const known = folderCache.get(soFar);
    if (known) { parent = known; continue; }
    const q = `name = '${name.replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const found = (await (await drive(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()) as { files: { id: string }[] };
    const id = found.files[0]?.id ?? ((await (await drive('/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
    })).json()) as { id: string }).id;
    folderCache.set(soFar, id);
    parent = id;
  }
  return parent;
}

export const driveStorage: FileStorage = {
  name: 'drive',
  async put(folderPath, fileName, mimeType, content) {
    const parent = await folderId(folderPath);
    const boundary = `finance${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileName, parents: [parent] })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await drive('/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return { storage: 'drive', storageKey: ((await res.json()) as { id: string }).id };
  },
  async get(storageKey) {
    const res = await drive(`/drive/v3/files/${encodeURIComponent(storageKey)}?alt=media&supportsAllDrives=true`);
    return Buffer.from(await res.arrayBuffer());
  },
};
