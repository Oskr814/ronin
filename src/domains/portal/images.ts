import { DomainError } from '../../platform/errors.js';

// The images a person attaches to a message (#114): sent as data URLs inside
// the JSON (the portal only takes JSON, which a plain form can't send). What
// the file is comes from its first bytes, never from what the browser says,
// and only these four kinds get in.

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ImageUpload {
  ext: 'png' | 'jpg' | 'webp' | 'gif';
  data: Buffer;
}

export const IMAGE_TYPES: Record<ImageUpload['ext'], string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function kindOf(data: Buffer): ImageUpload['ext'] | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'gif';
  return null;
}

export class ImageError extends DomainError {}

export function parseImages(raw: unknown): ImageUpload[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ImageError('Las imágenes no llegaron bien.');
  if (raw.length > MAX_IMAGES) throw new ImageError(`Puedes adjuntar hasta ${MAX_IMAGES} imágenes por mensaje.`);
  return raw.map((item) => {
    const match = typeof item === 'string' ? /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(item) : null;
    if (!match) throw new ImageError('Una de las imágenes no llegó bien.');
    const data = Buffer.from(match[1], 'base64');
    if (data.length > MAX_IMAGE_BYTES) throw new ImageError('Cada imagen puede pesar hasta 5 MB.');
    const ext = kindOf(data);
    if (!ext) throw new ImageError('Solo se aceptan imágenes PNG, JPG, WebP o GIF.');
    return { ext, data };
  });
}
