// Images the person pastes, drops or picks: as data URLs, the big ones
// scaled down here before they travel.

export const MAX_PENDING = 4;
const MAX_SIDE = 2400;
const MAX_RAW = 1.5 * 1024 * 1024;

const readAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function toDataUrl(file: File): Promise<string> {
  const url = await readAsDataUrl(file);
  if (file.type === 'image/gif') return url;
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && file.size <= MAX_RAW) return url;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// The images added to the ones already pending, and what went wrong, if
// something did.
export async function attach(pending: string[], files: File[]): Promise<{ pending: string[]; error: string | null }> {
  const out = [...pending];
  let error: string | null = null;
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      error = 'Solo se aceptan imágenes PNG, JPG, WebP o GIF.';
      continue;
    }
    if (out.length >= MAX_PENDING) {
      error = `Puedes adjuntar hasta ${MAX_PENDING} imágenes por mensaje.`;
      break;
    }
    try {
      out.push(await toDataUrl(file));
    } catch {
      error = 'No pude leer una de las imágenes.';
    }
  }
  return { pending: out, error };
}
