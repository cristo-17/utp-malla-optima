import { createHash } from 'node:crypto';
import { CABECERA_DISPOSITIVO, FORMATO_ID_DISPOSITIVO } from './contracts.js';

/**
 * Redes compartidas (la universidad): muchos alumnos salen por la misma IP, así que el tope fino es por dispositivo
 * y el de la IP es amplio (D-050).
 */
export const LIMITE_DISPOSITIVO_HORA_POR_DEFECTO = 30;
export const LIMITE_IP_HORA_POR_DEFECTO = 300;
export const LIMITE_DIARIO_POR_DEFECTO = 1500;
/** Perú no tiene horario de verano: Lima es siempre UTC-5. */
const DESFASE_LIMA_MS = -5 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/** Contador con expiración. Devuelve el valor después de incrementar. */
export interface RateLimiter {
  readonly tipo: 'memoria' | 'upstash';
  incrementar(clave: string, ttlSegundos: number): Promise<number>;
}

/** Best effort: cada instancia de la función tiene su propio contador. */
export const crearLimitadorMemoria = (ahora: () => number = Date.now): RateLimiter => {
  const contadores = new Map<string, { valor: number; expira: number }>();
  return {
    tipo: 'memoria',
    async incrementar(clave, ttlSegundos) {
      const momento = ahora();
      for (const [otra, contador] of contadores) if (contador.expira <= momento) contadores.delete(otra);
      const actual = contadores.get(clave);
      const valor = (actual?.valor ?? 0) + 1;
      contadores.set(clave, { valor, expira: actual?.expira ?? momento + ttlSegundos * 1000 });
      return valor;
    },
  };
};

/** Upstash Redis por su API REST (pipeline INCR + EXPIRE), sin dependencias. */
export const crearLimitadorUpstash = (url: string, token: string, fetchFn: typeof fetch): RateLimiter => ({
  tipo: 'upstash',
  async incrementar(clave, ttlSegundos) {
    const respuesta = await fetchFn(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', clave], ['EXPIRE', clave, String(ttlSegundos)]]),
    });
    if (!respuesta.ok) throw new Error(`upstash ${respuesta.status}`);
    const [incr] = await respuesta.json() as { result?: unknown; error?: string }[];
    if (typeof incr?.result !== 'number') throw new Error('upstash sin resultado');
    return incr.result;
  },
});

/** Si Upstash falla, sigue contando en memoria en lugar de dejar pasar todo. */
const conRespaldo = (principal: RateLimiter, respaldo: RateLimiter): RateLimiter => ({
  tipo: principal.tipo,
  async incrementar(clave, ttlSegundos) {
    try {
      return await principal.incrementar(clave, ttlSegundos);
    } catch {
      return respaldo.incrementar(clave, ttlSegundos);
    }
  },
});

type Entorno = Record<string, string | undefined>;

/** Upstash si hay URL y token (UPSTASH_REDIS_REST_* o los KV_REST_API_* del Marketplace de Vercel); si no, memoria. */
export const crearLimitador = (env: Entorno, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): RateLimiter => {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();
  const memoria = crearLimitadorMemoria();
  return url && token ? conRespaldo(crearLimitadorUpstash(url, token, fetchFn), memoria) : memoria;
};

/** Primer valor de x-forwarded-for o, si no hay, x-real-ip. */
export const ipDe = (request: Request): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  || request.headers.get('x-real-ip')?.trim()
  || 'desconocida';

/** La IP nunca se guarda en claro: solo sha256(sal + ip). */
export const hashIp = (ip: string, sal: string): string => createHash('sha256').update(`${sal}:${ip}`).digest('hex');
/** El ID del dispositivo tampoco: sha256 con la misma sal y otro prefijo. */
export const hashDispositivo = (id: string, sal: string): string => createHash('sha256').update(`${sal}:dispositivo:${id.toLowerCase()}`).digest('hex');

/**
 * Cabecera X-MallaU-Dispositivo: null si no viene (cuentan solo la IP y el total); 'invalido' si no tiene formato
 * UUID (se rechaza la consulta).
 */
export const dispositivoDe = (request: Request): string | null | 'invalido' => {
  const valor = request.headers.get(CABECERA_DISPOSITIVO)?.trim();
  if (!valor) return null;
  return FORMATO_ID_DISPOSITIVO.test(valor) ? valor : 'invalido';
};

export interface LimitesConfig {
  porDispositivoHora: number;
  porIpHora: number;
  diario: number;
  sal: string;
}

export type ResultadoLimite = { ok: true } | { ok: false; alcance: 'dispositivo' | 'ip' | 'diario'; reintentarEn: string };

/**
 * Ventanas fijas, en orden: la hora UTC en curso para el dispositivo (si vino su ID) y para la IP, y el día
 * calendario de Lima para el total. Un tope alcanzado corta antes de contar los siguientes.
 * `reintentarEn` es el inicio de la ventana siguiente (ISO).
 */
export const comprobarLimites = async (
  limitador: RateLimiter, config: LimitesConfig, ip: string, ahora: number = Date.now(), dispositivo: string | null = null,
): Promise<ResultadoLimite> => {
  const hora = Math.floor(ahora / HORA_MS);
  const finDeHora = new Date((hora + 1) * HORA_MS).toISOString();
  if (dispositivo) {
    const porDispositivo = await limitador.incrementar(`mallau:disp:${hashDispositivo(dispositivo, config.sal)}:${hora}`, 3600);
    if (porDispositivo > config.porDispositivoHora) return { ok: false, alcance: 'dispositivo', reintentarEn: finDeHora };
  }
  const porIp = await limitador.incrementar(`mallau:ip:${hashIp(ip, config.sal)}:${hora}`, 3600);
  if (porIp > config.porIpHora) return { ok: false, alcance: 'ip', reintentarEn: finDeHora };

  const diaLima = Math.floor((ahora + DESFASE_LIMA_MS) / DIA_MS);
  const fecha = new Date(diaLima * DIA_MS).toISOString().slice(0, 10);
  const total = await limitador.incrementar(`mallau:dia:${fecha}`, 2 * 24 * 3600);
  if (total > config.diario) {
    return { ok: false, alcance: 'diario', reintentarEn: new Date((diaLima + 1) * DIA_MS - DESFASE_LIMA_MS).toISOString() };
  }
  return { ok: true };
};

const entero = (valor: string | undefined, porDefecto: number) => {
  const numero = Number.parseInt(valor ?? '', 10);
  return Number.isFinite(numero) && numero > 0 ? numero : porDefecto;
};

export const leerLimites = (env: Entorno, salAleatoria: string): LimitesConfig => ({
  porDispositivoHora: entero(env.AI_LIMITE_DISPOSITIVO_HORA, LIMITE_DISPOSITIVO_HORA_POR_DEFECTO),
  porIpHora: entero(env.AI_LIMITE_IP_HORA, LIMITE_IP_HORA_POR_DEFECTO),
  diario: entero(env.AI_LIMITE_DIARIO, LIMITE_DIARIO_POR_DEFECTO),
  // Sin AI_SALT, una sal aleatoria por instancia: el hash sigue sin revelar la IP, pero con Upstash
  // cada instancia contaría aparte. Por eso AI_SALT es obligatoria en producción (README).
  sal: env.AI_SALT?.trim() || salAleatoria,
});
