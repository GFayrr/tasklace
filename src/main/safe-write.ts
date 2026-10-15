import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Writes content to a file without ever leaving it half written: into a temporary file beside it, forced to disk, then renamed over it, the temporary file being removed on failure, a failed removal only logged. */
export async function writeFileSafely(path: string, content: Uint8Array | string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeAndSync(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch((removal: unknown) => {
      console.error(`The temporary file ${temporary} could not be removed:`, removal);
    });
    throw error;
  }
}

/** Creates a new file, writes content into it, forces it to disk and closes it, a file that cannot be closed after a failed write being logged so that the error given stays that of the write. */
async function writeAndSync(path: string, content: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch((closing: unknown) => {
      console.error('The temporary file could not be closed after a failed write:', closing);
    });
    throw error;
  }
  await handle.close();
}
