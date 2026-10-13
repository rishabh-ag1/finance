import { localStorage } from './local';
import { driveStorage, driveConfigured } from './drive';

/**
 * Where attachment files live (M15, I14). FILE_STORAGE=drive puts them in Google Drive under
 * /Finance/{FY}/{Module}/{Record}; anything else keeps them in a local folder with the same
 * layout (FILE_STORAGE_DIR, default backend/.files) until Drive is set up.
 */
export type StoredFile = { storage: 'local' | 'drive'; storageKey: string };

export type FileStorage = {
  name: 'local' | 'drive';
  put(folderPath: string, fileName: string, mimeType: string, content: Buffer): Promise<StoredFile>;
  get(storageKey: string): Promise<Buffer>;
};

export function activeStorage(): FileStorage {
  if (process.env.FILE_STORAGE === 'drive') {
    if (!driveConfigured()) throw new Error('FILE_STORAGE=drive needs GOOGLE_SERVICE_ACCOUNT_JSON and DRIVE_ROOT_FOLDER_ID');
    return driveStorage;
  }
  return localStorage;
}

export function storageFor(name: string): FileStorage {
  return name === 'drive' ? driveStorage : localStorage;
}
