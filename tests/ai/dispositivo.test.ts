import { describe, expect, it, vi } from 'vitest';
import { CABECERA_DISPOSITIVO, FORMATO_ID_DISPOSITIVO, MENSAJE_LIMITE_DIARIO, type AIRequest } from '../../src/application/ai/contracts';
import { CLAVE_DISPOSITIVO, idDispositivo, nuevoIdDispositivo } from '../../src/infrastructure/ai/dispositivo';
import { HttpAIClient } from '../../src/infrastructure/ai/HttpAIClient';
import { crearContextoMinimo } from '../helpers/aiContexto';

const almacenEnMemoria = () => {
  const datos = new Map<string, string>();
  return { getItem: (clave: string) => datos.get(clave) ?? null, setItem: (clave: string, valor: string) => { datos.set(clave, valor); }, datos };
};

describe('ID anónimo del dispositivo', () => {
  it('es un UUID y se guarda en localStorage: la segunda vez es el mismo', () => {
    const almacen = almacenEnMemoria();
    const primero = idDispositivo(almacen);
    expect(primero).toMatch(FORMATO_ID_DISPOSITIVO);
    expect(almacen.datos.get(CLAVE_DISPOSITIVO)).toBe(primero);
    expect(idDispositivo(almacen)).toBe(primero);
  });

  it('un valor guardado que no es UUID se reemplaza', () => {
    const almacen = almacenEnMemoria();
    almacen.setItem(CLAVE_DISPOSITIVO, 'mi-celular');
    expect(idDispositivo(almacen)).toMatch(FORMATO_ID_DISPOSITIVO);
    expect(almacen.datos.get(CLAVE_DISPOSITIVO)).not.toBe('mi-celular');
  });

  it('si localStorage falla (try/catch), usa uno en memoria, el mismo durante la sesión', () => {
    const roto = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } };
    const enMemoria = idDispositivo(roto);
    expect(enMemoria).toMatch(FORMATO_ID_DISPOSITIVO);
    expect(idDispositivo(roto)).toBe(enMemoria);
    expect(idDispositivo(undefined)).toBe(enMemoria);
  });

  it('sin crypto.randomUUID (contexto no seguro) arma un UUID v4 con getRandomValues', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(171) });
    try {
      const id = nuevoIdDispositivo();
      expect(id).toMatch(FORMATO_ID_DISPOSITIVO);
      expect(id[14]).toBe('4');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HttpAIClient con el ID del dispositivo', () => {
  const peticion: AIRequest = { modo: 'chat', contexto: crearContextoMinimo(), mensajes: [{ rol: 'user', texto: 'hola' }] };
  const ID = '0b6c5e2a-3f4d-4c1e-9a7b-2d8e6f1a9c3b';

  it(`envía la cabecera ${CABECERA_DISPOSITIVO} con el ID, fuera del cuerpo`, async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ texto: 'ok', cursos: [], preguntasSugeridas: [] })));
    await new HttpAIClient({ endpoint: 'https://proxy', fetch, enLinea: () => true, dispositivo: () => ID }).enviar(peticion);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[CABECERA_DISPOSITIVO]).toBe(ID);
    expect(String(init.body)).not.toContain(ID);
  });

  it('el límite global del día muestra su propio mensaje, sin hora', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'LIMITE', mensaje: MENSAJE_LIMITE_DIARIO, reintentarEn: '2026-10-26T05:00:00.000Z' }), { status: 429 }));
    expect(await new HttpAIClient({ endpoint: 'https://proxy', fetch, enLinea: () => true, dispositivo: () => ID }).enviar(peticion))
      .toEqual({ ok: false, error: 'LIMITE', mensaje: 'El asistente llegó a su límite de hoy. Vuelve a intentarlo mañana.' });
  });
});
