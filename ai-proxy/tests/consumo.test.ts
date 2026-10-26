import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIContext, AIRequest } from '../src/contracts.js';
import { costoEstimadoUsd, esHorarioPico, leerUso, PRECIOS_DEEPSEEK_FLASH } from '../src/consumo.js';
import { crearHandlers, leerConfig, type ConfigProxy, type RegistroAsistente } from '../src/handler.js';
import { crearLimitadorMemoria } from '../src/limites.js';

const contexto: AIContext = JSON.parse(readFileSync(new URL('./fixtures/contexto.json', import.meta.url), 'utf8'));
const ORIGEN = 'https://mallau.vercel.app';
const CLAVE = 'sk-clave-que-no-debe-salir';
const peticion: AIRequest = { modo: 'chat', contexto, mensajes: [{ rol: 'user', texto: 'mi dato privado' }] };
const usage = { prompt_tokens: 10_000, prompt_cache_hit_tokens: 8_000, prompt_cache_miss_tokens: 2_000, completion_tokens: 300 };
const respuesta = (contenido: string, conUso = usage) =>
  new Response(JSON.stringify({ choices: [{ message: { content: contenido } }], usage: conUso }));
const VALIDO = JSON.stringify({ texto: 'Hola', cursos: [], preguntasSugeridas: [] });

const crear = (fetch: typeof globalThis.fetch, env: Record<string, string> = {}, cambios: Partial<ConfigProxy> = {}) => {
  const registros: RegistroAsistente[] = [];
  const config = leerConfig(
    { DEEPSEEK_API_KEY: CLAVE, ALLOWED_ORIGINS: ORIGEN, VERCEL_ENV: 'production', AI_SALT: 's', ...env },
    { fetch, esperaMockMs: 0, registrar: (entrada) => registros.push(entrada), limitador: crearLimitadorMemoria(), ...cambios },
  );
  return { POST: crearHandlers(config).POST, registros };
};

const post = () => new Request('https://proxy/api/asistente', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGEN, 'x-forwarded-for': '203.0.113.7' },
  body: JSON.stringify(peticion),
});

afterEach(() => vi.restoreAllMocks());

describe('consumo - precios', () => {
  it('constantes de deepseek-flash con su fecha de consulta', () => {
    expect(PRECIOS_DEEPSEEK_FLASH).toEqual({
      fechaConsulta: '2026-10-23', entradaSinCacheUsdPorM: 0.15, entradaConCacheUsdPorM: 0.003, salidaUsdPorM: 0.6, factorHorarioPico: 2,
    });
  });

  it('costo = sin caché × 0.15 + con caché × 0.003 + salida × 0.60 (por millón); el doble en pico', () => {
    // 2000 × 0.15 + 8000 × 0.003 + 300 × 0.60 = 300 + 24 + 180 = 504 → 0.000504
    expect(costoEstimadoUsd(leerUso(usage))).toBe(0.000504);
    expect(costoEstimadoUsd(leerUso(usage), true)).toBe(0.001008);
  });

  it('sin desglose de caché, todo el prompt cuenta como sin caché; valores inválidos valen 0', () => {
    expect(leerUso({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({
      prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 5, reasoning_tokens: 0,
    });
    expect(leerUso(undefined)).toEqual({ prompt_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 });
    expect(leerUso({ completion_tokens: 600, completion_tokens_details: { reasoning_tokens: 600 } }).reasoning_tokens).toBe(600);
    expect(leerUso({ prompt_tokens: -3, completion_tokens: 'x' }).completion_tokens).toBe(0);
  });

  it('horario pico solo si se configura DEEPSEEK_PICO_UTC (también cruzando la medianoche)', () => {
    const a = (hora: string) => new Date(`2026-10-23T${hora}:00.000Z`);
    expect(esHorarioPico(a('03:00'), undefined)).toBe(false);
    expect(esHorarioPico(a('03:00'), 'mal')).toBe(false);
    expect(esHorarioPico(a('03:00'), '01:00-09:00')).toBe(true);
    expect(esHorarioPico(a('09:00'), '01:00-09:00')).toBe(false);
    expect(esHorarioPico(a('23:30'), '22:00-02:00')).toBe(true);
    expect(esHorarioPico(a('01:59'), '22:00-02:00')).toBe(true);
    expect(esHorarioPico(a('12:00'), '22:00-02:00')).toBe(false);
  });
});

describe('consumo - registro de cada llamada real', () => {
  it('una línea JSON con modo, código, duración, modelo, tokens y costo; sin contexto, mensajes, IP ni clave', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = leerConfig({ DEEPSEEK_API_KEY: CLAVE, ALLOWED_ORIGINS: ORIGEN, VERCEL_ENV: 'production', AI_SALT: 's' }, {
      fetch: vi.fn(async () => respuesta(VALIDO)), limitador: crearLimitadorMemoria(),
    });
    await crearHandlers(config).POST(post());
    expect(log).toHaveBeenCalledTimes(1);
    const linea = String(log.mock.calls[0][0]);
    expect(linea.includes('\n')).toBe(false);
    const registro = JSON.parse(linea);
    expect(Object.keys(registro).sort()).toEqual([
      'chequeos_fallidos', 'codigo', 'completion_tokens', 'costo_usd', 'duracion_ms', 'evento', 'finish_reasons', 'intentos', 'mock', 'modelo', 'modo',
      'problemas_esquema', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'prompt_tokens', 'reasoning_tokens', 'tarifa', 'verificacion',
    ]);
    expect(registro).toMatchObject({
      evento: 'asistente', modo: 'chat', codigo: 'ok', modelo: 'deepseek-flash', mock: false, intentos: 1,
      prompt_tokens: 10_000, prompt_cache_hit_tokens: 8_000, prompt_cache_miss_tokens: 2_000, completion_tokens: 300,
      tarifa: 'normal', costo_usd: 0.000504, finish_reasons: [null], reasoning_tokens: 0, verificacion: 'primera', chequeos_fallidos: [],
      problemas_esquema: [],
    });
    for (const prohibido of ['mi dato privado', '100000', '203.0.113.7', CLAVE, 'CONTEXTO', 'catalogo']) {
      expect(linea).not.toContain(prohibido);
    }
  });

  it('un reintento suma los tokens de los dos intentos', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(respuesta('no es json'))
      .mockResolvedValueOnce(respuesta(VALIDO));
    const { POST, registros } = crear(fetch);
    await POST(post());
    expect(registros[0]).toMatchObject({ codigo: 'ok', intentos: 2, prompt_tokens: 20_000, completion_tokens: 600, costo_usd: 0.001008 });
  });

  it('si la salida no cumple el contrato, registra los problemas (path:code, vacío o JSON inválido) y nunca el texto', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(respuesta(' '.repeat(64)))
      .mockResolvedValueOnce(respuesta(JSON.stringify({ texto: 'mi dato privado', cursos: 'no', preguntasSugeridas: [] })));
    const { POST, registros } = crear(fetch);
    const res = await POST(post());
    expect(res.status).toBe(502);
    expect(registros[0]).toMatchObject({ codigo: 'RESPUESTA_INVALIDA', intentos: 2, problemas_esquema: ['(contenido):vacio', 'cursos:invalid_type'] });
    expect(JSON.stringify(registros[0])).not.toContain('mi dato privado');
    const otra = crear(vi.fn(async () => respuesta('no es json')));
    await otra.POST(post());
    expect(otra.registros[0]).toMatchObject({ problemas_esquema: ['(contenido):json_invalido'] });
  });

  it('un error de DeepSeek también se registra (sin tokens) con su código', async () => {
    const { POST, registros } = crear(vi.fn(async () => new Response('{}', { status: 402 })));
    await POST(post());
    expect(registros[0]).toMatchObject({ codigo: 'SIN_SALDO', intentos: 1, prompt_tokens: 0, costo_usd: 0 });
  });

  it('con DEEPSEEK_PICO_UTC y la llamada dentro de esa franja, la tarifa es pico', async () => {
    const { POST, registros } = crear(vi.fn(async () => respuesta(VALIDO)), { DEEPSEEK_PICO_UTC: '10:00-14:00' }, {
      ahora: () => Date.parse('2026-10-23T12:00:00.000Z'),
    });
    await POST(post());
    expect(registros[0]).toMatchObject({ tarifa: 'pico', costo_usd: 0.001008 });
  });

  it('las respuestas mock y los rechazos no llevan consumo', async () => {
    const { POST, registros } = crear(vi.fn(), { AI_MOCK: 'true' });
    await POST(post());
    expect(Object.keys(registros[0]).sort()).toEqual(['codigo', 'duracion_ms', 'evento', 'mock', 'modo']);
    expect(registros[0]).toMatchObject({ mock: true, codigo: 'ok' });
  });
});
