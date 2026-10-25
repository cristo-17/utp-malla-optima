import { randomUUID } from 'node:crypto';
import { costoEstimadoUsd, esHorarioPico, sumarUso, USO_VACIO, type UsoTokens } from './consumo.js';
import {
  AIRequestSchema, CABECERA_DISPOSITIVO, MENSAJE_LIMITE, MENSAJE_LIMITE_DIARIO, MENSAJE_NO_VERIFICADA, parsearRespuesta,
  type AIErrorCodigo, type AIErrorResponse,
} from './contracts.js';
import { ErrorProveedor, llamarConVerificacion, MODELO_POR_DEFECTO, type Verificacion } from './deepseek.js';
import {
  comprobarLimites, crearLimitadorMemoria, dispositivoDe, ipDe, leerLimites, type LimitesConfig, type RateLimiter,
} from './limites.js';
import { generarRespuestaMock } from './mockRespuestas.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const TIMEOUT_MS = 30_000;
export const ESPERA_MOCK_MS = 800;

export interface ConfigProxy {
  apiKey: string | null;
  modelo: string;
  origenes: string[];
  /** Responder con mocks en lugar de llamar a DeepSeek. */
  mock: boolean;
  /** AI_PAUSADO=true: interruptor de gasto; responde PAUSADO sin llamar a nadie. */
  pausado: boolean;
  limites: LimitesConfig;
  /** Debe vivir fuera de la invocación (ver api/asistente.ts) para que el contador en memoria sirva. */
  limitador: RateLimiter;
  ahora: () => number;
  esperaMockMs: number;
  timeoutMs: number;
  /** DEEPSEEK_PICO_UTC="HH:MM-HH:MM": horario pico (precio doble) para el costo estimado. */
  horarioPicoUtc: string | undefined;
  fetch: typeof fetch;
  registrar: (entrada: RegistroAsistente) => void;
}

/** Una línea por petición. Nunca lleva el contexto, los mensajes, la IP ni la clave. */
export interface RegistroAsistente {
  evento: 'asistente';
  modo: string;
  codigo: 'ok' | AIErrorCodigo;
  duracion_ms: number;
  mock: boolean;
}

/** Llamadas reales a DeepSeek: además, el consumo y el costo estimado. */
export interface RegistroConsumo extends RegistroAsistente, UsoTokens {
  modelo: string;
  intentos: number;
  /** finish_reason de cada intento, en orden (sin contenido). */
  finish_reasons: (string | null)[];
  /** Resultado del filtro de salida; null si la llamada falló antes. */
  verificacion: Verificacion | null;
  /** Solo los nombres de los chequeos que fallaron, nunca el contenido. */
  chequeos_fallidos: string[];
  tarifa: 'normal' | 'pico';
  costo_usd: number;
}

type Entorno = Record<string, string | undefined>;

const SAL_DE_INSTANCIA = randomUUID();

/**
 * Mock: AI_MOCK=true lo fuerza, y fuera de producción (VERCEL_ENV distinto de "production", como en las
 * previews de los PRs) se usa siempre, aunque haya clave: así nunca gastan.
 */
export const leerConfig = (env: Entorno, base: Partial<ConfigProxy> = {}): ConfigProxy => {
  const apiKey = env.DEEPSEEK_API_KEY?.trim() || null;
  return {
    apiKey,
    modelo: env.DEEPSEEK_MODEL?.trim() || MODELO_POR_DEFECTO,
    origenes: (env.ALLOWED_ORIGINS ?? '').split(',').map((origen) => origen.trim().replace(/\/$/, '')).filter(Boolean),
    mock: env.AI_MOCK === 'true' || env.VERCEL_ENV !== 'production',
    pausado: env.AI_PAUSADO === 'true',
    limites: leerLimites(env, SAL_DE_INSTANCIA),
    limitador: crearLimitadorMemoria(),
    ahora: Date.now,
    horarioPicoUtc: env.DEEPSEEK_PICO_UTC,
    esperaMockMs: ESPERA_MOCK_MS,
    timeoutMs: TIMEOUT_MS,
    fetch: globalThis.fetch.bind(globalThis),
    registrar: (entrada) => console.log(JSON.stringify(entrada)),
    ...base,
  };
};

const cabecerasCors = (origen: string) => ({
  'Access-Control-Allow-Origin': origen,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': `Content-Type, ${CABECERA_DISPOSITIVO}`,
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const json = (cuerpo: unknown, status: number, origen: string | null) => new Response(JSON.stringify(cuerpo), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(origen ? cabecerasCors(origen) : {}) },
});

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

export const crearHandlers = (config: ConfigProxy) => {
  const origenPermitido = (request: Request) => {
    const origen = request.headers.get('origin')?.replace(/\/$/, '') ?? '';
    return config.origenes.includes(origen) ? origen : null;
  };

  const OPTIONS = async (request: Request): Promise<Response> => {
    const origen = origenPermitido(request);
    return origen ? new Response(null, { status: 204, headers: cabecerasCors(origen) }) : new Response(null, { status: 403 });
  };

  const POST = async (request: Request): Promise<Response> => {
    const inicio = Date.now();
    const origen = origenPermitido(request);
    let modo = 'desconocido';
    let consumo: {
      uso: UsoTokens; intentos: number; finishReasons: (string | null)[]; verificacion: Verificacion | null; chequeosFallidos: string[];
    } | null = null;
    const terminar = (codigo: 'ok' | AIErrorCodigo, cuerpo: unknown, status: number) => {
      const base: RegistroAsistente = { evento: 'asistente', modo, codigo, duracion_ms: Date.now() - inicio, mock: config.mock };
      if (!consumo) {
        config.registrar(base);
      } else {
        const pico = esHorarioPico(new Date(config.ahora()), config.horarioPicoUtc);
        const registro: RegistroConsumo = {
          ...base, modelo: config.modelo, intentos: consumo.intentos, finish_reasons: consumo.finishReasons,
          verificacion: consumo.verificacion, chequeos_fallidos: consumo.chequeosFallidos, ...consumo.uso,
          tarifa: pico ? 'pico' : 'normal', costo_usd: costoEstimadoUsd(consumo.uso, pico),
        };
        config.registrar(registro);
      }
      return json(cuerpo, status, origen);
    };
    const fallar = (codigo: AIErrorCodigo, status: number, extra: Omit<AIErrorResponse, 'error'> = {}) =>
      terminar(codigo, { error: codigo, ...extra }, status);

    // Sin un Origin de ALLOWED_ORIGINS no se lee el cuerpo ni se llama a DeepSeek (además de no dar CORS).
    if (!origen) return fallar('ENTRADA_INVALIDA', 403);
    if (config.pausado) return fallar('PAUSADO', 503);
    // Un ID de dispositivo que no es UUID se rechaza (no se cuenta ni se guarda).
    const dispositivo = dispositivoDe(request);
    if (dispositivo === 'invalido') return fallar('ENTRADA_INVALIDA', 400);
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fallar('ENTRADA_INVALIDA', 413);
    const texto = await request.text();
    if (new TextEncoder().encode(texto).length > MAX_BODY_BYTES) return fallar('ENTRADA_INVALIDA', 413);

    let datos: unknown;
    try {
      datos = JSON.parse(texto);
    } catch {
      return fallar('ENTRADA_INVALIDA', 400);
    }
    const peticion = AIRequestSchema.safeParse(datos);
    if (!peticion.success) return fallar('ENTRADA_INVALIDA', 400);
    modo = peticion.data.modo;

    if (config.mock) {
      await esperar(config.esperaMockMs);
      const respuesta = parsearRespuesta(peticion.data.modo, generarRespuestaMock(peticion.data), peticion.data.contexto);
      return terminar('ok', respuesta, 200);
    }
    if (!config.apiKey) return fallar('PROVEEDOR_CAIDO', 503);

    // Los límites solo cuentan llamadas reales: el mock no gasta.
    const limite = await comprobarLimites(config.limitador, config.limites, ipDe(request), config.ahora(), dispositivo);
    if (!limite.ok) {
      return fallar('LIMITE', 429, { mensaje: limite.alcance === 'diario' ? MENSAJE_LIMITE_DIARIO : MENSAJE_LIMITE, reintentarEn: limite.reintentarEn });
    }

    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), config.timeoutMs);
    const acumulado = {
      uso: USO_VACIO, intentos: 0, finishReasons: [] as (string | null)[], verificacion: null as Verificacion | null, chequeosFallidos: [] as string[],
    };
    consumo = acumulado;
    try {
      const resultado = await llamarConVerificacion(peticion.data, {
        apiKey: config.apiKey, modelo: config.modelo, fetch: config.fetch, signal: controlador.signal,
        alUsar: (uso, finishReason) => {
          acumulado.uso = sumarUso(acumulado.uso, uso);
          acumulado.finishReasons.push(finishReason);
        },
        alIntentar: () => { acumulado.intentos += 1; },
      });
      acumulado.verificacion = resultado.verificacion;
      acumulado.chequeosFallidos = resultado.chequeosFallidos;
      if (!resultado.respuesta) return fallar('RESPUESTA_NO_VERIFICADA', 422, { mensaje: MENSAJE_NO_VERIFICADA });
      return terminar('ok', resultado.respuesta, 200);
    } catch (error) {
      if (error instanceof ErrorProveedor) return fallar(error.codigo, error.status);
      return fallar('PROVEEDOR_CAIDO', 502);
    } finally {
      clearTimeout(temporizador);
    }
  };

  return { POST, OPTIONS };
};
