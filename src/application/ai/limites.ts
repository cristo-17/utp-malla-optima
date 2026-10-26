import type { AIMetaEgreso, AIPropuestaConLimites } from './contracts';
import { montoDelMensaje } from './presupuesto';

/**
 * Límites que el alumno pide en el chat para armar o reordenar su plan (D-001: el asistente no arma el plan;
 * con estos límites lo arma el planificador y el contexto lleva la propuesta). Función pura: solo lee el texto.
 */
export interface LimitesDelMensaje {
  maxHorasPorPeriodo: number | null;
  maxCreditosPorPeriodo: number | null;
  /** "Menos de N": ningún periodo llega a N (D-053). "Máximo / hasta / no más de N" permite N. */
  horasEstricto: boolean;
  creditosEstricto: boolean;
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
  /**
   * Meta de egreso: "terminar / egresar / acabar en el ciclo N" o "para el ciclo N" (ciclo N), "en N ciclos" (N ciclos
   * después del actual). El ciclo de la meta no cuenta en `ciclos`.
   */
  metaEgreso: { ciclo: number } | { enCiclos: number } | null;
  /** Pide un plan con límites (horas, créditos, cuota, un ciclo más o veranos): el contexto trae propuestaConLimites. */
  pidePropuesta: boolean;
}

const sinTildes = (texto: string) => texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** "menos de", "máximo", "no más de", "hasta", "tope de"…: el número que sigue es un tope ("menos de" es estricto). */
const TOPE = String.raw`(?:menos\s+de|no\s+(?:tenga|tengan|pase|pasen|supere|superen|sea|sean)?\s*mas\s+de|no\s+mas\s+de|maximo(?:\s+de)?|como\s+maximo|como\s+mucho|hasta|tope\s+de|limite\s+de|max\.?)`;
const NUMERO = String.raw`(\d{1,2}(?:[.,]\d)?)`;
const HORAS = new RegExp(String.raw`${TOPE}\s+${NUMERO}\s*(?:h\b|hrs?\b|horas?\b)|${NUMERO}\s*(?:h\b|hrs?\b|horas?\b)(?:\s+semanales)?\s+(?:como\s+maximo|como\s+mucho|maximo|max\b)`);
const CREDITOS = new RegExp(String.raw`${TOPE}\s+${NUMERO}\s*(?:creditos?\b|cr\b|crs\b)|${NUMERO}\s*(?:creditos?\b|cr\b)\s+(?:como\s+maximo|como\s+mucho|maximo|max\b)`);
const AGREGAR_CICLO = /\b(agrego|agregar|agregue|agregas|agrega|anado|anadir|anada|anades|anade|sumo|sumar|uso|usar|llevo|llevar)\s+(otro|un|1|un\s+ciclo\s+mas|mas)\s*(ciclo|semestre)?\b|\b(otro|un)\s+ciclo\s+mas\b|\bciclo\s+(adicional|extra)\b/;
const VERANO = /\bveranos?\b/;
/** "¿y si llevo verano?", "usando el verano": también es un pedido de plan (regla 17). */
const LLEVA_VERANO = /\b(llevo|llevar|lleve|llevas|uso|usar|usando|meto|meter|tomo|tomar|agrego|agregar|aprovecho|aprovechar)\s+(el\s+|un\s+|los\s+)?veranos?\b/;
const SIN_VERANO = /\b(sin|no\s+(?:quiero|usar|uses|llevar|lleves|tomar)?\s*(?:el|los|un)?)\s*veranos?\b/;
/** Pide armar, ordenar o reorganizar el plan (para que un monto cuente como límite y no solo como presupuesto). */
const PIDE_PLAN = /\b(arma|armar|armame|armes|arme|ordena|ordenar|ordenes|reordena|reordenar|reordenes|organiza|organizar|organices|distribuye|distribuir|planifica|planificar|propuesta|plan)\b/;
const RANGO_CICLOS = /\bciclos?\s+(\d{1,2})\s*(?:al|a|hasta(?:\s+el)?|-)\s*(?:ciclo\s+)?(\d{1,2})\b/;
const CICLO_SUELTO = /\bciclo\s+(\d{1,2})\b/g;
const PROXIMO_CICLO = /\b(proximo|siguiente)\s+(ciclo|semestre|periodo)\b/;
/** Terminar, egresar, acabar o graduarse, y lo que sigue hasta la meta ("terminar mi carrera en el ciclo 9"). */
const VERBO_META = String.raw`\b(?:terminar|termino|termine|terminaria|terminare|egresar|egreso|egrese|egresaria|egresare|acabar|acabo|acabe|acabaria|acabare|graduarme|graduarte|graduo|graduaria)\b[^.?!\d]{0,40}?`;
const META_CICLO = new RegExp(String.raw`${VERBO_META}\b(?:en|para|hasta)\s+el\s+(?:ciclo|semestre)\s+(\d{1,2})\b`);
const NUMEROS_EN_LETRAS: Record<string, number> = { un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8 };
const META_EN_CICLOS = new RegExp(String.raw`${VERBO_META}\ben\s+(\d{1,2}|${Object.keys(NUMEROS_EN_LETRAS).join('|')})\s+(?:ciclos?|semestres?)\b`);

const aNumero = (texto: string) => Number(texto.replace(',', '.'));

/** La meta de egreso del mensaje (sin tildes) y el texto de la meta, para no contarlo como ciclo nombrado. */
const metaDelMensaje = (t: string): { meta: LimitesDelMensaje['metaEgreso']; texto: string } => {
  const ciclo = t.match(META_CICLO);
  if (ciclo) return { meta: { ciclo: Number(ciclo[1]) }, texto: ciclo[0] };
  const enCiclos = t.match(META_EN_CICLOS);
  if (enCiclos) return { meta: { enCiclos: NUMEROS_EN_LETRAS[enCiclos[1]] ?? Number(enCiclos[1]) }, texto: enCiclos[0] };
  return { meta: null, texto: '' };
};

/**
 * Los límites del mensaje, o null si no pide ninguno ni una meta de egreso. Un mensaje con JSON o con la palabra
 * CONTEXTO no cuenta.
 */
export const detectarLimites = (mensaje: string): LimitesDelMensaje | null => {
  if (/[{}]|contexto/i.test(mensaje)) return null;
  const t = sinTildes(mensaje);
  const horas = t.match(HORAS);
  const creditos = t.match(CREDITOS);
  const pidePlan = PIDE_PLAN.test(t);
  const maxCuotaMensual = pidePlan ? montoDelMensaje(mensaje) : null;
  const agregarCiclo = AGREGAR_CICLO.test(t);
  const usarVeranos = SIN_VERANO.test(t) ? false : VERANO.test(t) ? true : null;
  const { meta: metaEgreso, texto: textoMeta } = metaDelMensaje(t);
  const sinMeta = textoMeta ? t.replace(textoMeta, ' ') : t;

  const rango = sinMeta.match(RANGO_CICLOS);
  const ciclos = rango
    ? Array.from({ length: Math.max(0, Number(rango[2]) - Number(rango[1]) + 1) }, (_, indice) => Number(rango[1]) + indice)
    : [...new Set([...sinMeta.matchAll(CICLO_SUELTO)].map((m) => Number(m[1])))];
  const unSoloCiclo = !agregarCiclo && (ciclos.length === 1 || (!ciclos.length && PROXIMO_CICLO.test(t)));

  const limites: LimitesDelMensaje = {
    maxHorasPorPeriodo: horas ? aNumero(horas[1] ?? horas[2]) : null,
    maxCreditosPorPeriodo: creditos ? aNumero(creditos[1] ?? creditos[2]) : null,
    horasEstricto: Boolean(horas && /^menos\s+de/.test(horas[0])),
    creditosEstricto: Boolean(creditos && /^menos\s+de/.test(creditos[0])),
    maxCuotaMensual,
    agregarCiclo,
    usarVeranos,
    ciclos,
    unSoloCiclo,
    metaEgreso,
    pidePropuesta: false,
  };
  // Con una meta de egreso, los veranos son parte de la meta ("terminar en el ciclo 9 con veranos"), no otro pedido.
  const pideVeranos = (usarVeranos !== null && pidePlan) || (usarVeranos === true && LLEVA_VERANO.test(t));
  limites.pidePropuesta = limites.maxHorasPorPeriodo !== null || limites.maxCreditosPorPeriodo !== null ||
    limites.maxCuotaMensual !== null || agregarCiclo || (pideVeranos && !metaEgreso);
  return limites.pidePropuesta || metaEgreso ? limites : null;
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
  horasEstricto: limites.horasEstricto,
  creditosEstricto: limites.creditosEstricto,
});
/**
 * Opciones de Autogenerar para la meta de egreso: las horas mínimas que la logran, con o sin veranos, sin presupuesto
 * (null: el modal no usa el del alumno) y con la meta, que decide qué veranos se habilitan. null si no se puede.
 */
export const opcionesDeMeta = (meta: AIMetaEgreso): OpcionesPropuesta | null => meta.sePuede && meta.horasMaximasNecesarias !== null ? {
  alcance: 'hastaEgresar',
  maxHorasPorPeriodo: meta.horasMaximasNecesarias,
  maxCreditosPorPeriodo: null,
  maxCuotaMensual: null,
  usarVeranos: meta.usaVeranos,
  conservarUbicados: false,
  horasEstricto: false,
  creditosEstricto: false,
  cicloMeta: meta.cicloMeta,
} : null;

export type OpcionesPropuesta = Omit<ReturnType<typeof opcionesDePropuesta>, 'alcance'> & {
  alcance: 'proximoPeriodo' | 'hastaEgresar';
  cicloMeta?: number | null;
};
