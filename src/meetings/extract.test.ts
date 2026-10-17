import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { extractFile, extractPasted, kindOf, MAX_FILE_BYTES, notesHash, tidy } from './extract.js';

const NOTES = 'Devoluciones: los clientes mayoristas devuelven producto y hoy se anota en un Excel aparte.';

// A one-page PDF with `lines` in it, with a correct xref.
function pdfWith(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function docxWith(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('kindOf', () => {
  it('tells the file by its first bytes, never by its name', () => {
    expect(kindOf(Buffer.from('%PDF-1.7 ...'))).toBe('pdf');
    expect(kindOf(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe('docx');
    expect(kindOf(Buffer.from('# Reunión\n\n- algo'))).toBe('text');
    expect(kindOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBeNull();
    expect(kindOf(Buffer.from([0xc3, 0x28]))).toBeNull();
  });
});

describe('extractFile', () => {
  it('reads a PDF, with its pages', async () => {
    const out = await extractFile(pdfWith(['Seguimiento semanal', NOTES]));
    expect(out.kind).toBe('pdf');
    expect(out.pages).toBe(1);
    expect(out.text).toContain('Seguimiento semanal');
    expect(out.text).toContain('mayoristas devuelven producto');
  });

  it('reads a Word .docx', async () => {
    const out = await extractFile(await docxWith(['Detalles', NOTES]));
    expect(out).toEqual({ kind: 'docx', text: `Detalles\n\n${NOTES}` });
  });

  it('reads text and Markdown as they are, tidied', async () => {
    const out = await extractFile(Buffer.from(`﻿# Reunión\r\n\r\n\r\n\r\n- ${NOTES}   \r\n`));
    expect(out).toEqual({ kind: 'text', text: `# Reunión\n\n- ${NOTES}` });
  });

  it('says why when it can\'t', async () => {
    await expect(extractFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))).rejects.toThrow('Solo se aceptan PDF');
    await expect(extractFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).rejects.toThrow('no es un documento de Word');
    await expect(extractFile(Buffer.from('%PDF-1.4\nbasura'))).rejects.toThrow('No se pudo leer el PDF');
    // A scanned PDF: pages with no text.
    await expect(extractFile(pdfWith([]))).rejects.toThrow('no tiene texto');
    await expect(extractFile(Buffer.from('ok'))).rejects.toThrow('demasiado cortas');
    await expect(extractFile(Buffer.alloc(MAX_FILE_BYTES + 1, 'a'))).rejects.toThrow('hasta 10 MB');
  });
});

describe('extractPasted', () => {
  it('takes pasted text, tidied, and refuses an empty one', () => {
    expect(extractPasted(`  ${NOTES}\n\n\n\nOtra cosa  `)).toEqual({ kind: 'text', text: `${NOTES}\n\nOtra cosa` });
    expect(() => extractPasted('   ')).toThrow('demasiado cortas');
  });
});

describe('notesHash', () => {
  it('is the same for the same notes, whatever the spacing or case', () => {
    expect(notesHash(`${NOTES}\n\nFin`)).toBe(notesHash(`  ${NOTES.toUpperCase()} Fin`));
    expect(notesHash(NOTES)).not.toBe(notesHash(`${NOTES} Otra cosa.`));
  });

  it('tidy leaves single blank lines alone', () => {
    expect(tidy('a\n\nb')).toBe('a\n\nb');
  });
});
