import { describe, expect, it } from 'vitest';
import { decodePastedImage, isPastedImageName, MAX_PASTED_IMAGE_BYTES, pastedImageName } from '../src/core/pastedImage';

const NOW = new Date('2026-11-01T12:34:56.789Z');

describe('pastedImageName', () => {
  it('names an image by the time it was pasted, with its type’s extension', () => {
    expect(pastedImageName('image/png', NOW, 'ab12')).toBe('pasted-2026-11-01-12-34-56-ab12.png');
    expect(pastedImageName('IMAGE/JPEG', NOW, 'x')).toBe('pasted-2026-11-01-12-34-56-x.jpg');
  });
  it('keeps only word characters of the id', () => {
    expect(pastedImageName('image/gif', NOW, '../a/b')).toBe('pasted-2026-11-01-12-34-56-ab.gif');
  });
  it('refuses a type Claude does not read', () => {
    expect(pastedImageName('image/svg+xml', NOW, 'a')).toBeUndefined();
    expect(pastedImageName('text/plain', NOW, 'a')).toBeUndefined();
  });
  it('makes names isPastedImageName recognises, and nothing else', () => {
    expect(isPastedImageName(pastedImageName('image/webp', NOW, 'a1')!)).toBe(true);
    expect(isPastedImageName('notes.png')).toBe(false);
    expect(isPastedImageName('pasted-2026-11-01-12-34-56-a.txt')).toBe(false);
  });
});

describe('decodePastedImage', () => {
  it('decodes base64, with or without a data: prefix', () => {
    expect(decodePastedImage('aGk=')?.toString()).toBe('hi');
    expect(decodePastedImage('data:image/png;base64,aGk=')?.toString()).toBe('hi');
  });
  it('refuses empty, non-base64 and too large data', () => {
    expect(decodePastedImage('')).toBeUndefined();
    expect(decodePastedImage('data:image/png;base64,')).toBeUndefined();
    expect(decodePastedImage('not base64!')).toBeUndefined();
    expect(decodePastedImage('A'.repeat(Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4 + 4))).toBeUndefined();
  });
});
