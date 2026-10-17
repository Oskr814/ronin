import { describe, it, expect } from 'vitest';
import { parseImages } from './images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const url = (data: Buffer, type = 'image/png') => `data:${type};base64,${data.toString('base64')}`;

describe('parseImages', () => {
  it('knows the kind by its bytes, not by what the browser says', () => {
    expect(parseImages([url(PNG, 'image/jpeg')])).toEqual([{ ext: 'png', data: PNG }]);
    expect(parseImages([url(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))])[0].ext).toBe('jpg');
    expect(parseImages([url(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))])[0].ext).toBe('webp');
    expect(parseImages(undefined)).toEqual([]);
  });

  it('refuses anything else, too many and too heavy', () => {
    expect(() => parseImages([url(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')])).toThrow(/PNG, JPG/);
    expect(() => parseImages(['https://example.com/a.png'])).toThrow(/no llegó bien/);
    expect(() => parseImages(Array(5).fill(url(PNG)))).toThrow(/hasta 4/);
    expect(() => parseImages([url(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))])).toThrow(/5 MB/);
  });
});
