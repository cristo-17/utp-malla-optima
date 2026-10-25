import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MENSAJE_LIMITE, type AIContext, type AIRequest } from '../src/contracts.js';
import { AVISO_CORTADA, construirCuerpo, MAX_TOKENS } from '../src/deepseek.js';
import { crearHandlers, leerConfig, type ConfigProxy } from '../src/handler.js';
import {
  comprobarLimites, crearLimitador, crearLimitadorMemoria, crearLimitadorUpstash, hashIp, ipDe, leerLimites,
  LIMITE_DIARIO_POR_DEFECTO, LIMITE_DISPOSITIVO_HORA_POR_DEFECTO, LIMITE_IP_HORA_POR_DEFECTO, type RateLimiter,
} from '../src/limites.js';

const contexto: AIContext = JSON.parse(readFileSync(new URL('./fixtures/contexto.json', import.meta.url), 'utf8'));
const ORIGEN = 'https://mallau.vercel.app';
const peticion = (cambios: Partial<AIRequest> = {}): AIRequest => ({ modo: 'chat', contexto, mensajes: [{ rol: 'user', texto: 'Hola' }], ...cambios });
const chatValido = { texto: 'Hola', cursos: [], preguntasSugeridas: [] };
const respuestaDeepSeek = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(chatValido) } }] }));
// 2026-10-23 16:30 en Lima (21:30 UTC).
const AHORA = Date.parse('2026-10-23T21:30:00.000Z');

const crear = (env: Record<string, string> = {}, cambios: Partial<ConfigProxy> = {}) => {
  const fetch = vi.fn(async () => respuestaDeepSeek());
  const registros: unknown[] = [];
  const config = leerConfig(
    { DEEPSEEK_API_KEY: 'sk-prueba', ALLOWED_ORIGINS: ORIGEN, VERCEL_ENV: 'production', AI_SALT: 'sal-de-prueba', ...env },
    {
      fetch, esperaMockMs: 0, registrar: (entrada) => registros.push(entrada),
      ahora: () => AHORA, limitador: crearLimitadorMemoria(() => AHORA), ...cambios,
    },
  );
  return { ...crearHandlers(config), fetch, registros };
};

const post = (cuerpo: unknown = peticion(), cabeceras: Record<string, string> = {}) => new Request('https://proxy/api/asistente', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGEN, 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...cabeceras },
  body: JSON.stringify(cuerpo),
});

const contadorEspia = (): RateLimiter & { incrementar: ReturnType<typeof vi.fn> } => ({
  tipo: 'memoria', incrementar: vi.fn(async () => 1),
});

describe('gasto - origen', () => {
  it('un Origin ajeno recibe 403 antes de leer el cuerpo, sin llamar a DeepSeek ni contar', async () => {
    const limitador = contadorEspia();
    const { POST, fetch } = crear({}, { limitador });
    const request = post(peticion(), { Origin: 'https://otro.vercel.app' });
    const respuesta = await POST(request);
    expect(respuesta.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(limitador.incrementar).not.toHaveBeenCalled();
  });
});

describe('gasto - interruptor AI_PAUSADO', () => {
  it('AI_PAUSADO=true responde PAUSADO (503) sin llamar a DeepSeek, también en mock', async () => {
    for (const env of [{ AI_PAUSADO: 'true' }, { AI_PAUSADO: 'true', AI_MOCK: 'true' }] as Record<string, string>[]) {
      const { POST, fetch, registros } = crear(env);
      const respuesta = await POST(post());
      expect(respuesta.status).toBe(503);
      expect(await respuesta.json()).toEqual({ error: 'PAUSADO' });
      expect(respuesta.headers.get('access-control-allow-origin')).toBe(ORIGEN);
      expect(fetch).not.toHaveBeenCalled();
      expect(registros).toMatchObject([{ codigo: 'PAUSADO' }]);
    }
  });

  it('cualquier otro valor no pausa', () => {
    expect(leerConfig({ AI_PAUSADO: 'false' }).pausado).toBe(false);
    expect(leerConfig({ AI_PAUSADO: '1' }).pausado).toBe(false);
    expect(leerConfig({}).pausado).toBe(false);
  });
});

describe('gasto - límites', () => {
  it('por defecto: 30 por dispositivo y 300 por IP por hora, y 1500 por día; se pueden cambiar por entorno', () => {
    expect([LIMITE_DISPOSITIVO_HORA_POR_DEFECTO, LIMITE_IP_HORA_POR_DEFECTO, LIMITE_DIARIO_POR_DEFECTO]).toEqual([30, 300, 1500]);
    expect(leerLimites({}, 'x')).toEqual({ porDispositivoHora: 30, porIpHora: 300, diario: 1500, sal: 'x' });
    expect(leerLimites({ AI_LIMITE_DISPOSITIVO_HORA: '5', AI_LIMITE_IP_HORA: '3', AI_LIMITE_DIARIO: '50', AI_SALT: 's' }, 'x'))
      .toEqual({ porDispositivoHora: 5, porIpHora: 3, diario: 50, sal: 's' });
    expect(leerLimites({ AI_LIMITE_DISPOSITIVO_HORA: '0', AI_LIMITE_IP_HORA: 'abc', AI_LIMITE_DIARIO: '-1' }, 'x'))
      .toMatchObject({ porDispositivoHora: 30, porIpHora: 300, diario: 1500 });
  });

  it('la IP sale del primer valor de x-forwarded-for o de x-real-ip', () => {
    const conCabeceras = (cabeceras: Record<string, string>) => new Request('https://x', { headers: cabeceras });
    expect(ipDe(conCabeceras({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-real-ip': '1.1.1.1' }))).toBe('203.0.113.7');
    expect(ipDe(conCabeceras({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(ipDe(conCabeceras({}))).toBe('desconocida');
  });

  it('la IP se guarda solo como sha256 con sal', async () => {
    const claves: string[] = [];
    const limitador: RateLimiter = { tipo: 'memoria', incrementar: async (clave) => { claves.push(clave); return 1; } };
    await comprobarLimites(limitador, { porDispositivoHora: 30, porIpHora: 15, diario: 200, sal: 'sal' }, '203.0.113.7', AHORA);
    expect(claves.join(' ')).not.toContain('203.0.113.7');
    expect(claves[0]).toContain(hashIp('203.0.113.7', 'sal'));
    expect(hashIp('203.0.113.7', 'sal')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp('203.0.113.7', 'sal')).not.toBe(hashIp('203.0.113.7', 'otra'));
  });

  it('con AI_LIMITE_IP_HORA=15, la consulta 16 de la misma IP en la hora → LIMITE (429) con el mensaje y la hora en que se libera', async () => {
    const { POST, fetch } = crear({ AI_LIMITE_IP_HORA: '15' });
    for (let i = 0; i < 15; i += 1) expect((await POST(post())).status).toBe(200);
    const respuesta = await POST(post());
    expect(respuesta.status).toBe(429);
    expect(await respuesta.json()).toEqual({ error: 'LIMITE', mensaje: MENSAJE_LIMITE, reintentarEn: '2026-10-23T22:00:00.000Z' });
    expect(MENSAJE_LIMITE).toBe('Llegaste al límite de consultas por ahora. Intenta de nuevo en un rato.');
    expect(fetch).toHaveBeenCalledTimes(15);
    // Otra IP sigue pudiendo consultar.
    expect((await POST(post(peticion(), { 'x-forwarded-for': '198.51.100.9' }))).status).toBe(200);
  });

  it('el límite diario es global y se reinicia a la medianoche de Lima', async () => {
    const limitador = crearLimitadorMemoria(() => AHORA);
    const config = { porDispositivoHora: 100, porIpHora: 100, diario: 2, sal: 's' };
    expect(await comprobarLimites(limitador, config, 'a', AHORA)).toEqual({ ok: true });
    expect(await comprobarLimites(limitador, config, 'b', AHORA)).toEqual({ ok: true });
    // Medianoche del 24 en Lima = 05:00 UTC.
    expect(await comprobarLimites(limitador, config, 'c', AHORA))
      .toEqual({ ok: false, alcance: 'diario', reintentarEn: '2026-10-24T05:00:00.000Z' });
    // 23:59 del 23 en Lima sigue siendo el mismo día; 00:01 del 24 ya es otro.
    expect(await comprobarLimites(limitador, config, 'd', Date.parse('2026-10-24T04:59:00.000Z'))).toMatchObject({ ok: false });
    expect(await comprobarLimites(limitador, config, 'e', Date.parse('2026-10-24T05:01:00.000Z'))).toEqual({ ok: true });
  });

  it('no cuentan las respuestas mock ni las peticiones inválidas', async () => {
    const limitador = contadorEspia();
    await crear({ AI_MOCK: 'true' }, { limitador }).POST(post());
    await crear({}, { limitador }).POST(post({ modo: 'otro' }));
    expect(limitador.incrementar).not.toHaveBeenCalled();
  });

  it('el contador en memoria expira con su TTL', async () => {
    let ahora = AHORA;
    const limitador = crearLimitadorMemoria(() => ahora);
    expect(await limitador.incrementar('k', 60)).toBe(1);
    expect(await limitador.incrementar('k', 60)).toBe(2);
    ahora += 61_000;
    expect(await limitador.incrementar('k', 60)).toBe(1);
  });
});

describe('gasto - Upstash Redis (REST)', () => {
  it('usa UPSTASH_REDIS_REST_* o KV_REST_API_* y, si faltan, memoria', () => {
    expect(crearLimitador({}).tipo).toBe('memoria');
    expect(crearLimitador({ UPSTASH_REDIS_REST_URL: 'https://u.upstash.io' }).tipo).toBe('memoria');
    expect(crearLimitador({ UPSTASH_REDIS_REST_URL: 'https://u.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }).tipo).toBe('upstash');
    expect(crearLimitador({ KV_REST_API_URL: 'https://u.upstash.io', KV_REST_API_TOKEN: 't' }).tipo).toBe('upstash');
  });

  it('manda INCR + EXPIRE en un pipeline con el token como Bearer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ result: 4 }, { result: 1 }])));
    const valor = await crearLimitadorUpstash('https://u.upstash.io/', 'token-prueba', fetch).incrementar('mallau:dia:2026-10-23', 3600);
    expect(valor).toBe(4);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://u.upstash.io/pipeline');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-prueba');
    expect(JSON.parse(String(init.body))).toEqual([['INCR', 'mallau:dia:2026-10-23'], ['EXPIRE', 'mallau:dia:2026-10-23', '3600']]);
  });

  it('si Upstash falla, sigue contando en memoria', async () => {
    const fetch = vi.fn(async () => new Response('caído', { status: 500 }));
    const limitador = crearLimitador({ KV_REST_API_URL: 'https://u.upstash.io', KV_REST_API_TOKEN: 't' }, fetch);
    expect(await limitador.incrementar('k', 60)).toBe(1);
    expect(await limitador.incrementar('k', 60)).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('gasto - tokens', () => {
  it('max_tokens: 1800 en análisis y 900 en chat; razonamiento desactivado', () => {
    expect(MAX_TOKENS).toEqual({ analisis: 1800, chat: 900 });
    expect(construirCuerpo(peticion({ modo: 'analisis', mensajes: [] }), 'deepseek-flash').max_tokens).toBe(1800);
    expect(construirCuerpo(peticion(), 'deepseek-flash').max_tokens).toBe(900);
    expect(construirCuerpo(peticion(), 'deepseek-flash').thinking).toEqual({ type: 'disabled' });
  });

  const cortada = () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: '{"texto":"Con S/ 800 no te' } }],
    usage: { prompt_tokens: 100, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 0 } },
  }));

  it('finish_reason "length": UN reintento con el aviso al final, como mensaje del sistema', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(cortada()).mockResolvedValueOnce(respuestaDeepSeek());
    const { POST, registros } = crear({}, { fetch });
    const respuesta = await POST(post());
    expect(respuesta.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const primero = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const segundo = JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(segundo.messages.slice(0, -1)).toEqual(primero.messages);
    expect(segundo.messages.at(-1)).toEqual({ role: 'system', content: AVISO_CORTADA });
    expect(AVISO_CORTADA).toBe('Tu respuesta anterior fue demasiado larga y se cortó. Responde de nuevo con máximo 60 palabras en chat o 2 frases por sección en análisis.');
    expect(registros[0]).toMatchObject({ codigo: 'ok', intentos: 2, finish_reasons: ['length', null] });
  });

  it('si vuelve a cortarse: RESPUESTA_LARGA; el log lleva finish_reason y reasoning_tokens, sin contenido', async () => {
    const fetch = vi.fn(async () => cortada());
    const { POST, registros } = crear({}, { fetch });
    const respuesta = await POST(post());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(respuesta.status).toBe(502);
    expect(await respuesta.json()).toEqual({ error: 'RESPUESTA_LARGA' });
    expect(registros[0]).toMatchObject({ codigo: 'RESPUESTA_LARGA', finish_reasons: ['length', 'length'], reasoning_tokens: 0, completion_tokens: 1800 });
    expect(JSON.stringify(registros)).not.toContain('S/ 800');
  });
});
