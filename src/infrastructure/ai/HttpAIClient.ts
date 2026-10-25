import {
  AIErrorResponseSchema, CABECERA_DISPOSITIVO, MENSAJE_LIMITE, MENSAJE_LIMITE_DIARIO, MENSAJE_NO_VERIFICADA, parsearRespuesta,
  type AIErrorCodigo, type AIRequest, type AIRespuesta,
} from '../../application/ai/contracts';
import { generarRespuestaMock } from '../../application/ai/mockRespuestas';
import { idDispositivo } from './dispositivo';

export type ResultadoIA =
  | { ok: true; respuesta: AIRespuesta }
  | { ok: false; error: AIErrorCodigo; mensaje: string };

export interface AIClient {
  readonly esMock: boolean;
  enviar(peticion: AIRequest): Promise<ResultadoIA>;
}

export const TIMEOUT_CLIENTE_MS = 35_000;

/** SIN_SALDO usa el mismo aviso que la pausa: al alumno nunca se le dice que se acabó el saldo. */
export const MENSAJE_PAUSA = 'El asistente está en pausa por mantenimiento. Vuelve a intentarlo más tarde.';

export const MENSAJES_ERROR: Record<AIErrorCodigo, string> = {
  SIN_CONEXION: 'Sin conexión: el asistente necesita internet.',
  SIN_SALDO: MENSAJE_PAUSA,
  PAUSADO: MENSAJE_PAUSA,
  LIMITE: MENSAJE_LIMITE,
  PROVEEDOR_CAIDO: 'El asistente no está disponible en este momento. Inténtalo en unos minutos.',
  ENTRADA_INVALIDA: 'No pude enviar tu consulta. Revisa el mensaje e inténtalo otra vez.',
  RESPUESTA_INVALIDA: 'La respuesta de la IA llegó incompleta. Toca Reintentar.',
  RESPUESTA_LARGA: 'No pude terminar la respuesta, intenta preguntarlo más corto.',
  RESPUESTA_NO_VERIFICADA: MENSAJE_NO_VERIFICADA,
};

const fallo = (error: AIErrorCodigo, mensaje = MENSAJES_ERROR[error]): ResultadoIA => ({ ok: false, error, mensaje });

/** "17:00" en la hora del dispositivo (o en `zonaHoraria`, para los tests). */
export const horaAproximada = (iso: string, zonaHoraria?: string): string =>
  new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zonaHoraria }).format(new Date(iso));

/** LIMITE del proxy trae `reintentarEn`: se agrega la hora aproximada en que se libera. */
export const mensajeLimite = (reintentarEn: string | undefined, zonaHoraria?: string): string =>
  reintentarEn ? `${MENSAJE_LIMITE} Se libera hacia las ${horaAproximada(reintentarEn, zonaHoraria)}.` : MENSAJE_LIMITE;

const codigoPorStatus = (status: number): AIErrorCodigo =>
  status === 402 ? 'SIN_SALDO' : status === 429 ? 'LIMITE'
    : status === 400 || status === 413 ? 'ENTRADA_INVALIDA' : 'PROVEEDOR_CAIDO';

const estaEnLinea = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Escucha online/offline para el indicador de estado. Devuelve la función para dejar de escuchar. */
export const escucharConexion = (alCambiar: (enLinea: boolean) => void): (() => void) => {
  const enLinea = () => alCambiar(true);
  const sinConexion = () => alCambiar(false);
  window.addEventListener('online', enLinea);
  window.addEventListener('offline', sinConexion);
  return () => {
    window.removeEventListener('online', enLinea);
    window.removeEventListener('offline', sinConexion);
  };
};

export const conexionActual = estaEnLinea;

interface OpcionesHttp {
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  enLinea?: () => boolean;
  zonaHoraria?: string;
  /** ID anónimo del dispositivo para los límites del proxy (por defecto, el de localStorage). */
  dispositivo?: () => string;
}

/** Cliente del proxy ai-proxy. Nunca envía el prompt del sistema: solo modo, contexto, foco y mensajes. */
export class HttpAIClient implements AIClient {
  readonly esMock = false;
  private readonly opciones: Required<Omit<OpcionesHttp, 'zonaHoraria'>> & Pick<OpcionesHttp, 'zonaHoraria'>;

  constructor(opciones: OpcionesHttp) {
    this.opciones = {
      fetch: globalThis.fetch.bind(globalThis), timeoutMs: TIMEOUT_CLIENTE_MS, enLinea: estaEnLinea, dispositivo: () => idDispositivo(),
      ...opciones,
    };
  }

  async enviar(peticion: AIRequest): Promise<ResultadoIA> {
    const { endpoint, fetch, timeoutMs, enLinea, zonaHoraria, dispositivo } = this.opciones;
    if (!enLinea()) return fallo('SIN_CONEXION');
    if (!endpoint) return fallo('PROVEEDOR_CAIDO');

    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
    try {
      const respuesta = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CABECERA_DISPOSITIVO]: dispositivo() },
        body: JSON.stringify(peticion),
        signal: controlador.signal,
      });
      const datos: unknown = await respuesta.json().catch(() => null);
      if (!respuesta.ok) {
        const error = AIErrorResponseSchema.safeParse(datos);
        if (!error.success) return fallo(codigoPorStatus(respuesta.status));
        if (error.data.error !== 'LIMITE') return fallo(error.data.error);
        // El límite global del día tiene su propio mensaje; el del dispositivo o la red, la hora en que se libera.
        return fallo('LIMITE', error.data.mensaje === MENSAJE_LIMITE_DIARIO
          ? MENSAJE_LIMITE_DIARIO : mensajeLimite(error.data.reintentarEn, zonaHoraria));
      }
      try {
        return { ok: true, respuesta: parsearRespuesta(peticion.modo, datos, peticion.contexto) };
      } catch {
        return fallo('RESPUESTA_INVALIDA');
      }
    } catch {
      return fallo(enLinea() ? 'PROVEEDOR_CAIDO' : 'SIN_CONEXION');
    } finally {
      clearTimeout(temporizador);
    }
  }
}

/** Mock local para desarrollo sin proxy: la misma lógica que el modo mock del proxy. */
export class MockAIClient implements AIClient {
  readonly esMock = true;
  private readonly esperaMs: number;
  private readonly enLinea: () => boolean;

  constructor({ esperaMs = 800, enLinea = estaEnLinea }: { esperaMs?: number; enLinea?: () => boolean } = {}) {
    this.esperaMs = esperaMs;
    this.enLinea = enLinea;
  }

  async enviar(peticion: AIRequest): Promise<ResultadoIA> {
    if (!this.enLinea()) return fallo('SIN_CONEXION');
    await new Promise((resolver) => setTimeout(resolver, this.esperaMs));
    return { ok: true, respuesta: parsearRespuesta(peticion.modo, generarRespuestaMock(peticion), peticion.contexto) };
  }
}

/**
 * VITE_AI_MOCK=true (previews de Vercel) o VITE_AI_ENDPOINT vacío en desarrollo → MockAIClient;
 * si no → HttpAIClient (sin endpoint falla con aviso).
 */
export const crearAIClient = (env: { VITE_AI_ENDPOINT?: string; VITE_AI_MOCK?: string; DEV?: boolean } = import.meta.env): AIClient => {
  const endpoint = env.VITE_AI_ENDPOINT?.trim() ?? '';
  if (env.VITE_AI_MOCK === 'true') return new MockAIClient();
  return !endpoint && env.DEV ? new MockAIClient() : new HttpAIClient({ endpoint });
};
