import { describe, it, expect } from 'vitest';
import { blockCategory, listBlockEvents, recordBlockEvent } from './blocks.js';

describe('the block record', () => {
  it('keeps every block, in order', async () => {
    await recordBlockEvent({ repo: 'acme/tienda', item: 4, reason: 'a', at: '2026-10-01T00:00:00Z' });
    await recordBlockEvent({ repo: 'acme/tienda', item: 4, reason: 'b', at: '2026-10-02T00:00:00Z' });
    expect((await listBlockEvents()).map((e) => e.reason)).toEqual(['a', 'b']);
  });
});

describe('blockCategory', () => {
  it("groups notifyBlocker's reasons as docs/BLOCKING.md does", () => {
    expect(blockCategory('ronin necesita información para seguir con este issue')).toBe('Falta información');
    expect(blockCategory('La misma falla de CI se repite: fix-e2e no la está cambiando')).toBe('E2E que no converge');
    expect(blockCategory('E2E sin converger: cada intento falla distinto, pero se agotó el tope de intentos')).toBe('E2E que no converge');
    expect(blockCategory('Feedback de review sin converger tras el límite de intentos')).toBe('Review que no converge');
    expect(blockCategory('CI nunca reportó resultados tras el límite de reintentos')).toBe('CI que nunca termina');
    expect(blockCategory('Base del PR del fondo del stack es "x", no "y" — el retarget automático nunca corrió')).toBe('Stack sin retarget');
    expect(blockCategory('El checklist de slices está vacío — el seed/plan inicial nunca llegó a escribirse')).toBe('Plan vacío o slices huérfanas');
    expect(blockCategory('Excepción no manejada procesando el issue: boom')).toBe('Errores repetidos');
    expect(blockCategory('algo nuevo')).toBe('Otro');
  });
});
