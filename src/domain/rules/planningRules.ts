import type { Curso, PeriodoAcademico, TipoPeriodoAcademico } from '../../types/academic';
import type { Tarifario } from '../../types/financial';
import { crearPeriodoRegular, determinarPeriodoActual, determinarPeriodoEnCurso, esPeriodoAnterior } from './academicPeriodRules';
import { periodoBloqueadoPorCicloActual } from './academicContextRules';
import { ACADEMIC_LIMITS, type AcademicLimits } from '../../config/academicLimits';

export const LIMITE_HORAS_PERIODO = ACADEMIC_LIMITS.horasRecomendadasPeriodo;
export const LIMITE_HORAS_PLANIFICACION = ACADEMIC_LIMITS.horasMaximasPlanificacion;
export const FACTOR_HORAS_VERANO = ACADEMIC_LIMITS.factorHorasVerano;
export const LIMITE_CREDITOS_VERANO = ACADEMIC_LIMITS.creditosMaximosVerano;
/** creditosMaximos de academic.json: ningún ciclo regular del planificador pasa de este total (F-016). */
export const LIMITE_CREDITOS_PERIODO = ACADEMIC_LIMITS.creditosMaximos;
export const MINIMO_CREDITOS_ELECTIVOS = ACADEMIC_LIMITS.creditosMinimosElectivos;

export interface ResultadoLimite {
  valido: boolean;
  total: number;
  limite: number;
}

export const calcularHorasEfectivas = (
  cursos: Curso[],
  tipoPeriodo: TipoPeriodoAcademico,
  limites: AcademicLimits = ACADEMIC_LIMITS
): number => {
  const horas = cursos.reduce((total, curso) => total + curso.horasSemanales, 0);
  return tipoPeriodo === 'VERANO' ? horas * limites.factorHorasVerano : horas;
};

/** Recomendación manual de 24 horas efectivas; el exceso genera una advertencia. */
export const validarLimiteHorasPeriodo = (
  cursos: Curso[],
  tipoPeriodo: TipoPeriodoAcademico,
  limites: AcademicLimits = ACADEMIC_LIMITS
): ResultadoLimite => {
  const total = calcularHorasEfectivas(cursos, tipoPeriodo, limites);
  return {
    valido: total <= limites.horasRecomendadasPeriodo,
    total,
    limite: limites.horasRecomendadasPeriodo,
  };
};

/**
 * Horas cubiertas por la pensión sin recargo: el maxHoras del último rango de
 * pensión del tarifario activo. Devuelve null si el tarifario no usa escala.
 */
export const obtenerHorasSinRecargo = (
  tarifario: Tarifario | null | undefined,
  disciplina: string
): number | null => {
  if (!tarifario || tarifario.modalidadPrincipal !== 'ESCALA_FIJA') return null;
  const tarifas = tarifario.disciplinas[disciplina] ?? Object.values(tarifario.disciplinas)[0];
  const rangos = tarifas?.rangosPension ?? [];
  return rangos.length ? Math.max(...rangos.map((rango) => rango.maxHoras)) : null;
};

/** Aviso de recargo: las horas efectivas superan las cubiertas por el último rango de pensión. */
export const validarRecargoHorasPeriodo = (
  cursos: Curso[],
  tipoPeriodo: TipoPeriodoAcademico,
  horasSinRecargo: number | null,
  limites: AcademicLimits = ACADEMIC_LIMITS
): ResultadoLimite | null => {
  if (horasSinRecargo === null) return null;
  const total = calcularHorasEfectivas(cursos, tipoPeriodo, limites);
  return { valido: total <= horasSinRecargo, total, limite: horasSinRecargo };
};

export const mensajeRecargoHoras = (horasSinRecargo: number): string =>
  `Desde ${horasSinRecargo + 1} h pagas recargo por hora adicional`;

/** R3 — mínimo global de créditos electivos para completar la carrera. */
export const validarMinimoCreditosElectivos = (cursos: Curso[], limites: AcademicLimits = ACADEMIC_LIMITS): ResultadoLimite => {
  const total = cursos
    .filter((curso) => curso.tipo === 'ELECTIVO')
    .reduce((suma, curso) => suma + curso.creditos, 0);

  return {
    valido: total >= limites.creditosMinimosElectivos,
    total,
    limite: limites.creditosMinimosElectivos,
  };
};

/** R4 — máximo 11 créditos por verano. */
export const validarLimiteCreditosVerano = (cursos: Curso[], limites: AcademicLimits = ACADEMIC_LIMITS): ResultadoLimite => {
  const total = cursos.reduce((suma, curso) => suma + curso.creditos, 0);
  return {
    valido: total <= limites.creditosMaximosVerano,
    total,
    limite: limites.creditosMaximosVerano,
  };
};

/**
 * Regla de destino temporal.
 * - Si existe un periodo EN_CURSO, no se permiten cursos nuevos ni en periodos
 *   anteriores ni en el propio periodo que el estudiante ya está cursando.
 * - El verano inmediatamente posterior sí está disponible.
 * - Si no existen cursos EN_CURSO, el primer periodo calculado sigue siendo
 *   planificable.
 */
export const validarDestinoNoAnterior = (
  cursos: Curso[],
  destino: PeriodoAcademico,
  cicloActualExplicito?: number | null
): {
  valido: boolean;
  periodoActual: PeriodoAcademico;
  esPeriodoActualBloqueado: boolean;
} => {
  const periodoActual = cicloActualExplicito
    ? crearPeriodoRegular(cicloActualExplicito)
    : determinarPeriodoActual(cursos);
  const periodoEnCurso = determinarPeriodoEnCurso(cursos);
  const esPeriodoActualBloqueado = Boolean(
    (cicloActualExplicito || periodoEnCurso) && destino.orden === periodoActual.orden
  );

  return {
    valido:
      (cicloActualExplicito
        ? !periodoBloqueadoPorCicloActual(destino, cicloActualExplicito)
        : !esPeriodoAnterior(destino, periodoActual) && !esPeriodoActualBloqueado),
    periodoActual,
    esPeriodoActualBloqueado,
  };
};
