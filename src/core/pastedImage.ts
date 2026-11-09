// Images pasted into the Claude Board's prompt box: saved as files, mentioned with `@` so Claude reads them.

/** The image types Claude reads, by MIME type: the file extension each is saved with. */
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A pasted image larger than this (decoded) is refused. */
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

/** Pasted images older than this are deleted when another one is pasted. */
export const PASTED_IMAGE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** The file name for an image of `mime` pasted at `now` (`id`: makes two pastes in one second differ); undefined for a type Claude does not read. */
export function pastedImageName(mime: string, now: Date, id: string): string | undefined {
  const ext = EXTENSIONS[mime.toLowerCase()];
  if (!ext) return undefined;
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `pasted-${stamp}-${id.replace(/[^\w]/g, '').slice(0, 12)}.${ext}`;
}

/** A file this module saved (`pastedImageName`), so cleaning up never deletes anything else in the folder. */
export function isPastedImageName(name: string): boolean {
  return /^pasted-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\w*\.(png|jpg|gif|webp)$/.test(name);
}

/** The bytes of a pasted image from its base64 (a `data:` URL's prefix is dropped); undefined when empty, not base64, or too large. */
export function decodePastedImage(data: string): Buffer | undefined {
  const b64 = data.replace(/^data:[^,]*,/, '');
  if (!b64 || b64.length > Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined;
  const bytes = Buffer.from(b64, 'base64');
  return bytes.length > 0 ? bytes : undefined;
}
