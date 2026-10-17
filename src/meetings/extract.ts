import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

// The notes of a meeting (#62), as text: uploaded as a file (a PDF, a Word
// .docx, plain text or Markdown) or pasted. What the file is comes from its
// first bytes, never from its name or what the browser says.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
// More than any meeting's notes: past it, it's not notes.
export const MAX_TEXT_CHARS = 200_000;
// Less than this isn't notes either: a scanned PDF has no text to read.
export const MIN_TEXT_CHARS = 40;

export type SourceKind = 'pdf' | 'docx' | 'text';

export interface Extracted {
  kind: SourceKind;
  text: string;
  // A PDF's.
  pages?: number;
}

export class ExtractError extends Error {}

const PDF = Buffer.from('%PDF-');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function kindOf(data: Buffer): SourceKind | null {
  if (data.subarray(0, 5).equals(PDF)) return 'pdf';
  // A .docx is a zip; mammoth says whether it's a Word one.
  if (data.subarray(0, 4).equals(ZIP)) return 'docx';
  return isText(data) ? 'text' : null;
}

// UTF-8 with no NUL: a text file, a .md, what a notes app exports.
function isText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

// Line endings and spacing tidied, the way every source comes out the same.
export function tidy(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function checked(extracted: Extracted): Extracted {
  const text = tidy(extracted.text);
  if (text.length < MIN_TEXT_CHARS) {
    throw new ExtractError(extracted.kind === 'pdf'
      ? 'El PDF no tiene texto que leer: ¿es una imagen escaneada? Bájalo de Google Docs como PDF o .docx, o pega el texto.'
      : 'Las notas están vacías o son demasiado cortas.');
  }
  if (text.length > MAX_TEXT_CHARS) throw new ExtractError(`Las notas tienen más de ${MAX_TEXT_CHARS.toLocaleString('es')} caracteres: no parecen las notas de una reunión.`);
  return { ...extracted, text };
}

export async function extractFile(data: Buffer): Promise<Extracted> {
  if (data.length > MAX_FILE_BYTES) throw new ExtractError('El archivo puede pesar hasta 10 MB.');
  const kind = kindOf(data);
  if (kind === 'pdf') {
    let read: { totalPages: number; text: string };
    try {
      read = await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: true });
    } catch {
      throw new ExtractError('No se pudo leer el PDF: puede estar dañado o protegido con contraseña.');
    }
    return checked({ kind, text: read.text, pages: read.totalPages });
  }
  if (kind === 'docx') {
    let value: string;
    try {
      ({ value } = await mammoth.extractRawText({ buffer: data }));
    } catch {
      throw new ExtractError('El archivo no es un documento de Word (.docx) que se pueda leer.');
    }
    return checked({ kind, text: value });
  }
  if (kind === 'text') return checked({ kind, text: data.toString('utf8') });
  throw new ExtractError('Solo se aceptan PDF, Word (.docx), texto o Markdown.');
}

export const extractPasted = (text: string): Extracted => checked({ kind: 'text', text });

// The same notes give the same hash: spacing and case don't count, so the
// same text pasted twice, or exported again, is still the same notes.
export function notesHash(text: string): string {
  const normal = text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normal).digest('hex');
}
