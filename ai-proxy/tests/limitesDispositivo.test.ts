import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CABECERA_DISPOSITIVO, MENSAJE_LIMITE, MENSAJE_LIMITE_DIARIO, type AIContext, type AIRequest } from '../src/contracts.js';
import { crearHandlers, leerConfig } from '../src/handler.js';
import { comprobarLimites, crearLimitadorMemoria, hashDispositivo, type RateLimiter } from '../src/limites.js';

const contexto: AIContext = JSON.parse(readFileSync(new URL('./fixtures/contexto.json', import.meta.url), 'utf8'));
const ORIGEN = 'https://mallau.vercel.app';
const AHORA = Date.parse('2026-10-23T21:30:00.000Z');
const peticion: AIRequest = { modo: 'chat', contexto, mensajes: [{ rol: 'user', texto: 'Hola' }] };
const respuestaDeepSeek = () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ texto: 'Hola', cursos: [], preguntasSugeridas: [] }) } }],
}));
/** UUID v4 de prueba, distinto para cada número. */
const uuid = (numero: number) => `00000000-0000-4000-8000-${numero.toString(16).padStart(12, '0')}`;

const crear = (env: Record<string, string> = {}) => {
  const fetch = vi.fn(async () => respuestaDeepSeek());
  const registros: unknown[] = [];
  const config = leerConfig(
    { DEEPSEEK_API_KEY: 'sk-prueba', ALLOWED_ORIGINS: ORIGEN, VERCEL_ENV: 'production', AI_SALT: 'sal-de-prueba', ...env },
    { fetch, esperaMockMs: 0, registrar: (entrada) => registros.push(entrada), ahora: () => AHORA, limitador: crearLimitadorMemoria(() => AHORA) },
  );
  return { ...crearHandlers(config), fetch, registros };
};
const post = (cabeceras: Record<string, string> = {}) => new Request('https://proxy/api/asistente', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGEN, 'x-forwarded-for': '203.0.113.7', ...cabeceras },
  body: JSON.stringify(peticion),
});

describe('límites para redes compartidas: dispositivo, IP y global', () => {
  it('40 dispositivos desde una misma IP pueden consultar (la universidad)', async () => {
    const { POST, fetch } = crear();
    for (let numero = 1; numero <= 40; numero += 1) {
      expect((await POST(post({ [CABECERA_DISPOSITIVO]: uuid(numero) }))).status, `dispositivo ${numero}`).toBe(200);
    }
    expect(fetch).toHaveBeenCalledTimes(40);
  });

  it('un dispositivo se corta a las 30 consultas en la hora; otro de la misma IP sigue', async () => {
    const { POST, fetch } = crear();
    const yo = { [CABECERA_DISPOSITIVO]: uuid(7) };
    for (let i = 0; i < 30; i += 1) expect((await POST(post(yo))).status).toBe(200);
    const respuesta = await POST(post(yo));
    expect(respuesta.status).toBe(429);
    expect(await respuesta.json()).toEqual({ error: 'LIMITE', mensaje: MENSAJE_LIMITE, reintentarEn: '2026-10-23T22:00:00.000Z' });
    expect(fetch).toHaveBeenCalledTimes(30);
    expect((await POST(post({ [CABECERA_DISPOSITIVO]: uuid(8) }))).status).toBe(200);
  });

  it('el global se corta a las 1500 del día con su propio mensaje', async () => {
    const limitador = crearLimitadorMemoria(() => AHORA);
    const config = { porDispositivoHora: 30, porIpHora: 300, diario: 1500, sal: 's' };
    // 1500 consultas de 1500 dispositivos, repartidos en 50 IP (30 por IP).
    for (let numero = 0; numero < 1500; numero += 1) {
      const resultado = await comprobarLimites(limitador, config, `198.51.${Math.floor(numero / 30)}.1`, AHORA, uuid(numero));
      expect(resultado.ok, `consulta ${numero + 1}`).toBe(true);
    }
    expect(await comprobarLimites(limitador, config, '192.0.2.1', AHORA, uuid(9999)))
      .toEqual({ ok: false, alcance: 'diario', reintentarEn: '2026-10-24T05:00:00.000Z' });
  });

  it('en el handler, el límite global responde "El asistente llegó a su límite de hoy"', async () => {
    const { POST } = crear({ AI_LIMITE_DIARIO: '2' });
    expect((await POST(post({ [CABECERA_DISPOSITIVO]: uuid(1) }))).status).toBe(200);
    expect((await POST(post({ [CABECERA_DISPOSITIVO]: uuid(2), 'x-forwarded-for': '198.51.100.1' }))).status).toBe(200);
    const respuesta = await POST(post({ [CABECERA_DISPOSITIVO]: uuid(3), 'x-forwarded-for': '198.51.100.2' }));
    expect(respuesta.status).toBe(429);
    expect(await respuesta.json()).toMatchObject({ error: 'LIMITE', mensaje: MENSAJE_LIMITE_DIARIO });
    expect(MENSAJE_LIMITE_DIARIO.startsWith('El asistente llegó a su límite de hoy')).toBe(true);
  });

  it('orden dispositivo → IP → global: un tope alcanzado no cuenta los siguientes', async () => {
    const claves: string[] = [];
    const limitador: RateLimiter = { tipo: 'memoria', incrementar: async (clave) => { claves.push(clave); return claves.length === 1 ? 31 : 1; } };
    expect(await comprobarLimites(limitador, { porDispositivoHora: 30, porIpHora: 300, diario: 1500, sal: 's' }, '203.0.113.7', AHORA, uuid(1)))
      .toMatchObject({ ok: false, alcance: 'dispositivo' });
    expect(claves).toHaveLength(1);
    expect(claves[0]).toMatch(/^mallau:disp:/);
  });

  it('sin cabecera cuentan solo la IP y el global', async () => {
    const claves: string[] = [];
    const limitador: RateLimiter = { tipo: 'memoria', incrementar: async (clave) => { claves.push(clave); return 1; } };
    await comprobarLimites(limitador, { porDispositivoHora: 30, porIpHora: 300, diario: 1500, sal: 's' }, '203.0.113.7', AHORA);
    expect(claves.map((clave) => clave.split(':')[1])).toEqual(['ip', 'dia']);
  });

  it('el ID nunca se guarda en claro: sha256 con AI_SALT', async () => {
    const claves: string[] = [];
    const limitador: RateLimiter = { tipo: 'memoria', incrementar: async (clave) => { claves.push(clave); return 1; } };
    await comprobarLimites(limitador, { porDispositivoHora: 30, porIpHora: 300, diario: 1500, sal: 'sal' }, '203.0.113.7', AHORA, uuid(5));
    expect(claves.join(' ')).not.toContain(uuid(5));
    expect(claves[0]).toContain(hashDispositivo(uuid(5), 'sal'));
    expect(hashDispositivo(uuid(5), 'sal')).not.toBe(hashDispositivo(uuid(5), 'otra'));
  });

  it('un ID que no tiene formato UUID se rechaza (400) sin llamar a DeepSeek ni registrarlo', async () => {
    const { POST, fetch, registros } = crear();
    for (const valor of ['mi-celular', '12345', `${uuid(1)}x`, "'; DROP TABLE"]) {
      const respuesta = await POST(post({ [CABECERA_DISPOSITIVO]: valor }));
      expect(respuesta.status, valor).toBe(400);
      expect(await respuesta.json()).toEqual({ error: 'ENTRADA_INVALIDA' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(registros)).not.toContain('mi-celular');
  });

  it('el registro de consumo no lleva el ID del dispositivo y CORS permite la cabecera', async () => {
    const { POST, OPTIONS, registros } = crear();
    await POST(post({ [CABECERA_DISPOSITIVO]: uuid(42) }));
    expect(JSON.stringify(registros)).not.toContain(uuid(42));
    const preflight = await OPTIONS(new Request('https://proxy/api/asistente', { method: 'OPTIONS', headers: { Origin: ORIGEN } }));
    expect(preflight.headers.get('access-control-allow-headers')).toContain(CABECERA_DISPOSITIVO);
  });
});
