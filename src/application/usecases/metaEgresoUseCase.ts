import type { Curso } from '../../types/academic';
import { permiteVeranoDespuesDe } from '../../domain/rules/academicContextRules';
import { MAXIMO_CICLOS, normalizarCiclosExcluidos } from '../../domain/rules/cycleRules';
import { LIMITE_CREDITOS_PERIODO, LIMITE_CREDITOS_VERANO } from '../../domain/rules/planningRules';
import { cumpleMetaEgreso, generarPlanificacionAutomatica } from '../../domain/services/automaticPlanningService';
import { generateOptimalPlanUseCase, type GenerateOptimalPlanInput, type PropuestaPlan } from './generateOptimalPlanUseCase';

/** Hasta cuántas horas por periodo se busca la carga que logra la meta (el tope de créditos por ciclo también aplica). */
export const HORAS_MAXIMAS_META = 40;

/** La carga mínima que logra la meta, con o sin veranos, y la propuesta completa (con costos) con esa carga. */
export interface VarianteMeta {
  horasMaximasNecesarias: number;
  propuesta: PropuestaPlan;
}

export type MotivoMetaImposible =
  /** La cadena de prerrequisitos más larga necesita más periodos de los que hay hasta la meta. */
  | { tipo: 'CADENA_PRERREQUISITOS'; cadena: { codigo: string; nombre: string }[]; periodosNecesarios: number; periodosDisponibles: number }
  /** La cadena entra, pero los créditos pendientes no caben con los topes por periodo. */
  | { tipo: 'TOPE_CREDITOS'; creditosPendientes: number; periodosDisponibles: number; creditosMaximosPorCiclo: number; creditosMaximosVerano: number };

export interface ResultadoMetaEgreso {
  cicloMeta: number;
  sePuede: boolean;
  sinVeranos: VarianteMeta | null;
  conVeranos: VarianteMeta | null;
  /** Primero sin veranos; si no se puede, con veranos. */
  elegida: VarianteMeta | null;
  motivo: MotivoMetaImposible | null;
  /** El primer ciclo en el que sí se puede egresar (con la carga máxima y los veranos permitidos); null si ninguno. */
  cicloMasCercano: number | null;
}

type EntradaMeta = Omit<GenerateOptimalPlanInput, 'maxHorasPorPeriodo' | 'maxCreditosPorPeriodo' | 'maxCuotaMensual' |
  'horasEstricto' | 'creditosEstricto' | 'usarVeranos' | 'alcance' | 'conservarUbicados' | 'cicloMeta' | 'conAlternativas'>;

const ESTADOS_CUMPLIDOS = new Set(['APROBADO', 'CONVALIDADO', 'EN_CURSO']);

/** La cadena de prerrequisitos pendientes más larga (obligatorios): cuántos periodos seguidos necesita como mínimo. */
export const cadenaMasLarga = (cursos: Curso[]): Curso[] => {
  const porCodigo = new Map(cursos.map((curso) => [curso.codigo, curso]));
  const memo = new Map<string, Curso[]>();
  const cadena = (curso: Curso, camino: Set<string>): Curso[] => {
    const guardada = memo.get(curso.codigo);
    if (guardada) return guardada;
    let mejor: Curso[] = [];
    for (const codigo of curso.prerrequisitos) {
      const requisito = porCodigo.get(codigo);
      if (!requisito || ESTADOS_CUMPLIDOS.has(requisito.estado) || camino.has(codigo)) continue;
      const previa = cadena(requisito, new Set([...camino, codigo]));
      if (previa.length > mejor.length) mejor = previa;
    }
    const resultado = [...mejor, curso];
    memo.set(curso.codigo, resultado);
    return resultado;
  };
  return cursos.filter((curso) => curso.estado === 'PENDIENTE' && curso.tipo !== 'ELECTIVO')
    .map((curso) => cadena(curso, new Set([curso.codigo])))
    .reduce<Curso[]>((larga, actual) => actual.length > larga.length ? actual : larga, []);
};

/**
 * "¿Puedo terminar en el Ciclo N?" con el mismo motor de Autogenerar (D-001: la IA solo lo explica). Busca el menor
 * máximo de horas por periodo con el que se egresa a más tardar en el Ciclo N, primero sin veranos y después con
 * veranos. El planificador respeta los prerrequisitos, la ventana de los jalados, los 11 créditos de un verano y
 * creditosMaximos por ciclo (F-016). Reordena todo lo pendiente, como una propuesta del chat.
 */
export const metaEgresoUseCase = (entrada: EntradaMeta, cicloMeta: number, permitirVeranos = true): ResultadoMetaEgreso => {
  const cicloActual = entrada.cicloActual ?? 0;
  const base = {
    totalCiclos: entrada.totalCiclos, ciclosExcluidos: entrada.ciclosExcluidos, cicloActual: entrada.cicloActual,
    periodoIngreso: entrada.periodoIngreso, alcance: 'hastaEgresar' as const, conservarUbicados: false, cicloMeta,
  };
  const logra = (horas: number, usarVeranos: boolean) =>
    cumpleMetaEgreso(generarPlanificacionAutomatica(entrada.cursos, { ...base, maxHorasPorPeriodo: horas, usarVeranos }), cicloMeta);
  const propuestaCon = (horas: number, usarVeranos: boolean) => generateOptimalPlanUseCase({
    ...entrada, ...base, maxHorasPorPeriodo: horas, usarVeranos, maxCreditosPorPeriodo: null, maxCuotaMensual: null,
    horasEstricto: false, creditosEstricto: false, conAlternativas: false,
  });
  /** El menor máximo de horas que logra la meta (búsqueda binaria entre 1 y HORAS_MAXIMAS_META). */
  const variante = (usarVeranos: boolean): VarianteMeta | null => {
    if (cicloMeta <= cicloActual || !logra(HORAS_MAXIMAS_META, usarVeranos)) return null;
    let [desde, hasta] = [1, HORAS_MAXIMAS_META];
    while (desde < hasta) {
      const medio = Math.floor((desde + hasta) / 2);
      if (logra(medio, usarVeranos)) hasta = medio;
      else desde = medio + 1;
    }
    const propuesta = propuestaCon(desde, usarVeranos);
    return cumpleMetaEgreso(propuesta, cicloMeta) ? { horasMaximasNecesarias: desde, propuesta } : null;
  };

  const sinVeranos = variante(false);
  const conVeranosPosible = permitirVeranos && Boolean(entrada.periodoIngreso) ? variante(true) : null;
  // Con veranos solo cuenta si de verdad usa alguno y pide menos horas que sin veranos (si no, es la misma propuesta).
  const conVeranos = conVeranosPosible && conVeranosPosible.propuesta.veranosUsados.length &&
    (!sinVeranos || conVeranosPosible.horasMaximasNecesarias < sinVeranos.horasMaximasNecesarias) ? conVeranosPosible : null;
  const elegida = sinVeranos ?? conVeranos;
  if (elegida) return { cicloMeta, sePuede: true, sinVeranos, conVeranos, elegida, motivo: null, cicloMasCercano: cicloMeta };

  // No se puede: el motivo y el primer ciclo posible.
  const excluidos = new Set(normalizarCiclosExcluidos(entrada.ciclosExcluidos));
  const ingreso = entrada.periodoIngreso;
  const regulares = Array.from({ length: Math.max(0, cicloMeta - cicloActual) }, (_, indice) => cicloActual + 1 + indice)
    .filter((ciclo) => !excluidos.has(ciclo)).length;
  const veranos = permitirVeranos && ingreso
    ? Array.from({ length: Math.max(0, cicloMeta - cicloActual) }, (_, indice) => cicloActual + indice)
      .filter((ciclo) => permiteVeranoDespuesDe(ciclo, ingreso)).length
    : 0;
  const periodosDisponibles = regulares + veranos;
  const cadena = cadenaMasLarga(entrada.cursos);
  const motivo: MotivoMetaImposible = cadena.length > periodosDisponibles
    ? { tipo: 'CADENA_PRERREQUISITOS', cadena: cadena.map(({ codigo, nombre }) => ({ codigo, nombre })),
      periodosNecesarios: cadena.length, periodosDisponibles }
    : { tipo: 'TOPE_CREDITOS', periodosDisponibles, creditosMaximosPorCiclo: LIMITE_CREDITOS_PERIODO, creditosMaximosVerano: LIMITE_CREDITOS_VERANO,
      creditosPendientes: entrada.cursos.filter((curso) => curso.estado === 'PENDIENTE' && curso.tipo !== 'ELECTIVO')
        .reduce((suma, curso) => suma + curso.creditos, 0) };
  let cicloMasCercano: number | null = null;
  for (let ciclo = Math.max(cicloMeta, cicloActual) + 1; ciclo <= MAXIMO_CICLOS && cicloMasCercano === null; ciclo += 1) {
    const opciones = { ...base, cicloMeta: ciclo, maxHorasPorPeriodo: HORAS_MAXIMAS_META };
    if (cumpleMetaEgreso(generarPlanificacionAutomatica(entrada.cursos, { ...opciones, usarVeranos: false }), ciclo) ||
        (permitirVeranos && ingreso && cumpleMetaEgreso(generarPlanificacionAutomatica(entrada.cursos, { ...opciones, usarVeranos: true }), ciclo))) {
      cicloMasCercano = ciclo;
    }
  }
  return { cicloMeta, sePuede: false, sinVeranos: null, conVeranos: null, elegida: null, motivo, cicloMasCercano };
};
