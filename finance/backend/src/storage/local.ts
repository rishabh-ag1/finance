import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileStorage } from './index';

/** Local folder storage with the same /Finance/{FY}/{Module}/{Record} layout as Drive. */
export function localRoot(): string {
  return path.resolve(process.env.FILE_STORAGE_DIR || path.join(__dirname, '../../.files'));
}

function safeJoin(root: string, relative: string): string {
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) throw new Error('Refusing a path outside the storage folder');
  return full;
}

export const localStorage: FileStorage = {
  name: 'local',
  async put(folderPath, fileName, _mimeType, content) {
    const root = localRoot();
    const relativeFolder = folderPath.replace(/^\/+/, '');
    // Never overwrite: a second file with the same name gets a numbered suffix.
    const ext = path.extname(fileName);
    const base = fileName.slice(0, fileName.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const name = n === 1 ? fileName : `${base} (${n})${ext}`;
      const relative = path.posix.join(relativeFolder, name);
      const full = safeJoin(root, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      try {
        await fs.writeFile(full, content, { flag: 'wx' });
        return { storage: 'local', storageKey: relative };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    throw new Error('Too many files with the same name');
  },
  async get(storageKey) {
    return fs.readFile(safeJoin(localRoot(), storageKey));
  },
};
