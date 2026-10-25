import { FORMATO_ID_DISPOSITIVO } from '../../application/ai/contracts';

/**
 * ID anónimo del dispositivo para los límites de uso del proxy (redes compartidas de la universidad). No es un
 * dato personal: un UUID al azar, guardado en localStorage. Si el almacenamiento falla (modo privado, datos
 * bloqueados), se usa uno en memoria mientras dure la pestaña.
 */
export const CLAVE_DISPOSITIVO = 'mallau.dispositivo';

/** UUID v4 con crypto.randomUUID o, si no está (contexto no seguro), con getRandomValues. */
export const nuevoIdDispositivo = (): string => {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Sin randomUUID se arma a mano.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

let enMemoria: string | null = null;

export const idDispositivo = (almacen: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): string => {
  try {
    const guardado = almacen?.getItem(CLAVE_DISPOSITIVO);
    if (guardado && FORMATO_ID_DISPOSITIVO.test(guardado)) return guardado;
    const nuevo = nuevoIdDispositivo();
    if (!almacen) throw new Error('sin almacenamiento');
    almacen.setItem(CLAVE_DISPOSITIVO, nuevo);
    return nuevo;
  } catch {
    enMemoria ??= nuevoIdDispositivo();
    return enMemoria;
  }
};
