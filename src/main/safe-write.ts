import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Writes content to a file without ever leaving it half written: into a new temporary file beside it, forced to disk, then renamed over it, the temporary file being removed if anything fails. */
export async function writeFileSafely(path: string, content: Uint8Array | string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeAndSync(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Creates a new file, writes content into it and forces it to disk. */
async function writeAndSync(path: string, content: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
