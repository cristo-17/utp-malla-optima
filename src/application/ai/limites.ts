import type { AIPropuestaConLimites } from './contracts';
import { montoDelMensaje } from './presupuesto';

/**
 * Límites que el alumno pide en el chat para armar o reordenar su plan (D-001: el asistente no arma el plan;
 * con estos límites lo arma el planificador y el contexto lleva la propuesta). Función pura: solo lee el texto.
 */
export interface LimitesDelMensaje {
  maxHorasPorPeriodo: number | null;
  maxCreditosPorPeriodo: number | null;
  /** Monto mensual (el mismo parser que aplicarMontoDelAlumno), solo si el mensaje pide armar o reordenar el plan. */
  maxCuotaMensual: number | null;
  /** "agregar / añadir otro ciclo". */
  agregarCiclo: boolean;
  /** true si pide usar veranos, false si pide no usarlos, null si no los menciona. */
  usarVeranos: boolean | null;
  /** Ciclos nombrados: "del ciclo 8 al 10" → [8, 9, 10]; "el ciclo 8" → [8]. */
  ciclos: number[];
  /** Nombra un solo ciclo ("el ciclo 8", "el próximo ciclo"): la propuesta se limita a ese periodo. */
  unSoloCiclo: boolean;
}

const sinTildes = (texto: string) => texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** "menos de", "máximo", "no más de", "hasta", "tope de"…: el número que sigue es un tope (se toma como máximo). */
const TOPE = String.raw`(?:menos\s+de|no\s+(?:tenga|tengan|pase|pasen|supere|superen|sea|sean)?\s*mas\s+de|no\s+mas\s+de|maximo(?:\s+de)?|como\s+maximo|como\s+mucho|hasta|tope\s+de|limite\s+de|max\.?)`;
const NUMERO = String.raw`(\d{1,2}(?:[.,]\d)?)`;
const HORAS = new RegExp(String.raw`${TOPE}\s+${NUMERO}\s*(?:h\b|hrs?\b|horas?\b)|${NUMERO}\s*(?:h\b|hrs?\b|horas?\b)(?:\s+semanales)?\s+(?:como\s+maximo|como\s+mucho|maximo|max\b)`);
const CREDITOS = new RegExp(String.raw`${TOPE}\s+${NUMERO}\s*(?:creditos?\b|cr\b|crs\b)|${NUMERO}\s*(?:creditos?\b|cr\b)\s+(?:como\s+maximo|como\s+mucho|maximo|max\b)`);
const AGREGAR_CICLO = /\b(agrego|agregar|agregue|agregas|agrega|anado|anadir|anada|anades|anade|sumo|sumar|uso|usar|llevo|llevar)\s+(otro|un|1|un\s+ciclo\s+mas|mas)\s*(ciclo|semestre)?\b|\b(otro|un)\s+ciclo\s+mas\b|\bciclo\s+(adicional|extra)\b/;
const VERANO = /\bveranos?\b/;
const SIN_VERANO = /\b(sin|no\s+(?:quiero|usar|uses|llevar|lleves|tomar)?\s*(?:el|los|un)?)\s*veranos?\b/;
/** Pide armar, ordenar o reorganizar el plan (para que un monto cuente como límite y no solo como presupuesto). */
const PIDE_PLAN = /\b(arma|armar|armame|armes|arme|ordena|ordenar|ordenes|reordena|reordenar|reordenes|organiza|organizar|organices|distribuye|distribuir|planifica|planificar|propuesta|plan)\b/;
const RANGO_CICLOS = /\bciclos?\s+(\d{1,2})\s*(?:al|a|hasta(?:\s+el)?|-)\s*(?:ciclo\s+)?(\d{1,2})\b/;
const CICLO_SUELTO = /\bciclo\s+(\d{1,2})\b/g;
const PROXIMO_CICLO = /\b(proximo|siguiente)\s+(ciclo|semestre|periodo)\b/;

const aNumero = (texto: string) => Number(texto.replace(',', '.'));

/** Los límites del mensaje, o null si no pide ninguno. Un mensaje con JSON o con la palabra CONTEXTO no cuenta. */
export const detectarLimites = (mensaje: string): LimitesDelMensaje | null => {
  if (/[{}]|contexto/i.test(mensaje)) return null;
  const t = sinTildes(mensaje);
  const horas = t.match(HORAS);
  const creditos = t.match(CREDITOS);
  const pidePlan = PIDE_PLAN.test(t);
  const maxCuotaMensual = pidePlan ? montoDelMensaje(mensaje) : null;
  const agregarCiclo = AGREGAR_CICLO.test(t);
  const usarVeranos = SIN_VERANO.test(t) ? false : VERANO.test(t) ? true : null;

  const rango = t.match(RANGO_CICLOS);
  const ciclos = rango
    ? Array.from({ length: Math.max(0, Number(rango[2]) - Number(rango[1]) + 1) }, (_, indice) => Number(rango[1]) + indice)
    : [...new Set([...t.matchAll(CICLO_SUELTO)].map((m) => Number(m[1])))];
  const unSoloCiclo = !agregarCiclo && (ciclos.length === 1 || (!ciclos.length && PROXIMO_CICLO.test(t)));

  const limites: LimitesDelMensaje = {
    maxHorasPorPeriodo: horas ? aNumero(horas[1] ?? horas[2]) : null,
    maxCreditosPorPeriodo: creditos ? aNumero(creditos[1] ?? creditos[2]) : null,
    maxCuotaMensual,
    agregarCiclo,
    usarVeranos,
    ciclos,
    unSoloCiclo,
  };
  const pideAlgo = limites.maxHorasPorPeriodo !== null || limites.maxCreditosPorPeriodo !== null ||
    limites.maxCuotaMensual !== null || agregarCiclo || (usarVeranos !== null && pidePlan);
  return pideAlgo ? limites : null;
};

/**
 * Opciones de Autogenerar con las que se armó la propuesta del contexto: el botón "Aplicar a mi malla" del chat abre
 * la vista previa ya cargada con ellas (el alumno la aplica; la IA nunca cambia la malla).
 */
export const opcionesDePropuesta = ({ limites }: AIPropuestaConLimites) => ({
  alcance: limites.alcance,
  maxHorasPorPeriodo: limites.agregarCiclo ? limites.horasAplicadas : limites.maxHorasPorPeriodo,
  maxCreditosPorPeriodo: limites.maxCreditosPorPeriodo,
  maxCuotaMensual: limites.maxCuotaMensual,
  usarVeranos: limites.usarVeranos,
  conservarUbicados: false,
});
export type OpcionesPropuesta = ReturnType<typeof opcionesDePropuesta>;
