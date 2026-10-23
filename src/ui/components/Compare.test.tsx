import { describe, it, expect } from 'vitest';
import { pairsOf } from './Compare.js';

describe("a prototype's shots in pairs (#407)", () => {
  it('each before with the after of the same number, without the side in the caption', () => {
    expect(pairsOf({ images: ['p2-antes-1.png', 'p2-despues-1.png', 'p2-antes-2.png', 'p2-despues-2.png'], captions: ['Antes: hoy', 'Después: con el cambio', 'Antes: b', 'Después: c'] }, (f) => `/img/${f}`)).toEqual([
      { before: { src: '/img/p2-antes-1.png', caption: 'hoy' }, after: { src: '/img/p2-despues-1.png', caption: 'con el cambio' } },
      { before: { src: '/img/p2-antes-2.png', caption: 'b' }, after: { src: '/img/p2-despues-2.png', caption: 'c' } },
    ]);
    expect(pairsOf({ images: ['r1-error-1.png', 'r1-arreglo-1.png'], captions: ['El error', 'Con el arreglo de prueba'] })).toEqual([
      { before: { src: 'r1-error-1.png', caption: 'El error' }, after: { src: 'r1-arreglo-1.png', caption: 'Con el arreglo de prueba' } },
    ]);
  });

  it("none for the images the person sent", () => {
    expect(pairsOf({ images: ['1-1.png', '1-2.png'] })).toBeNull();
    expect(pairsOf({ images: [] })).toBeNull();
  });
});
