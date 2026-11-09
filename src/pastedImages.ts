import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boardPastedImagesDir } from './config';
import { fileMention } from './core/composer';
import { removeOldFiles } from './core/oldFiles';
import { decodePastedImage, isPastedImageName, PASTED_IMAGE_MAX_AGE_MS, pastedImageName } from './core/pastedImage';
import { log } from './log';

/**
 * Saves an image pasted into the Claude Board's prompt box (`data`: base64) in `devdesk.board.pastedImagesDir`; its
 * `@` mention for the prompt. Throws when the image cannot be used.
 */
export async function savePastedImage(mime: string, data: string): Promise<string> {
  const name = pastedImageName(mime, new Date(), randomBytes(4).toString('hex'));
  if (!name) throw new Error(`Cannot paste a ${mime || 'file of unknown type'}: Claude reads PNG, JPEG, GIF and WebP images.`);
  const bytes = decodePastedImage(data);
  if (!bytes) throw new Error('The pasted image is empty or larger than 20 MB.');
  const dir = boardPastedImagesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  await writeFile(file, bytes, { mode: 0o600 });
  void deleteOldPastedImages(dir);
  return fileMention(file);
}

/** Deletes the images pasted more than 30 days ago (only files `savePastedImage` named). */
async function deleteOldPastedImages(dir: string): Promise<void> {
  try {
    await removeOldFiles(dir, isPastedImageName, Date.now() - PASTED_IMAGE_MAX_AGE_MS);
  } catch (err) {
    log.warn(`cannot clean up pasted images in ${dir}: ${(err as Error).message}`);
  }
}
