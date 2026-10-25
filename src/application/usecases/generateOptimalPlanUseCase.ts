import type { Curso, PeriodoIngreso } from '../../types/academic';
import type { Tarifario } from '../../types/financial';
import {
  generarPlanificacionAutomatica,
  type AlcancePlanificacion,
  type CostosPeriodoPropuesto,
  type PeriodoPropuesto,
  type ResultadoPlanificacionAutomatica,
} from '../../domain/services/automaticPlanningService';
import { ACADEMIC_LIMITS } from '../../config/academicLimits';
import { horasMaximasParaCuota } from '../../financial/engine/budgetCalculator';
import { FinancialPlanningService } from '../../financial/services/FinancialPlanningService';
import { UniversityFinancialRulesProvider } from '../../financial/rules/UniversityFinancialRulesProvider';

export interface GenerateOptimalPlanInput {
  cursos: Curso[];
  totalCiclos?: number;
  ciclosExcluidos?: number[];
  cicloActual?: number | null;
  periodoIngreso?: PeriodoIngreso | null;
  /** Límites del alumno (todos opcionales). Sin ninguno: el tope fijo de 22 h, sin veranos. */
  maxHorasPorPeriodo?: number | null;
  maxCreditosPorPeriodo?: number | null;
  /** Cuota mensual máxima: se convierte en horas con el tarifario y el método de pago (horasMaximasParaCuota). */
  maxCuotaMensual?: number | null;
  usarVeranos?: boolean;
  alcance?: AlcancePlanificacion;
  conservarUbicados?: boolean;
  /** Para la cuota máxima y los costos de cada periodo; sin tarifario, la propuesta no trae costos. */
  tarifario?: Tarifario | null;
  disciplina?: string;
  metodoPago?: string;
  servicioFinanciero?: FinancialPlanningService;
}

/** Lo que pidió el alumno y en qué se tradujo (la cuota pasa a horas con la escala del tarifario). */
export interface LimitesPedidos {
  maxHorasPorPeriodo: number | null;
  maxCreditosPorPeriodo: number | null;
  maxCuotaMensual: number | null;
  metodoPago: string | null;
  /** Horas cuya cuota mensual no pasa la cuota máxima (null sin cuota o sin escala de pensión). */
  horasPorCuota: number | null;
  horasPorCuotaVerano: number | null;
}

export interface PropuestaPlan extends ResultadoPlanificacionAutomatica {
  limitesPedidos: LimitesPedidos;
}

const numero = (valor: number | null | undefined) =>
  typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? valor : null;
const minimo = (...valores: (number | null)[]) => {
  const definidos = valores.filter((valor): valor is number => valor !== null);
  return definidos.length ? Math.min(...definidos) : null;
};

/** Cuotas por método de pago y pago único de un periodo, con el mismo motor financiero que la Simulación de cuotas. */
const costosDe = (
  { periodo }: PeriodoPropuesto, cursos: Curso[], input: GenerateOptimalPlanInput, servicio: FinancialPlanningService
): CostosPeriodoPropuesto | null => {
  const { tarifario, disciplina = '', cicloActual } = input;
  if (!tarifario) return null;
  const delPeriodo = cursos.filter((curso) => curso.ubicacion === 'periodo' && curso.estado === 'PENDIENTE' &&
    curso.tipoPeriodo === periodo.tipo && curso.ciclo === periodo.cicloReferencia);
  const resumen = (metodoPago: string, pagoUnico = false) => servicio.calcular(delPeriodo, tarifario, disciplina, {
    metodoPago, pagoUnicoPorPeriodo: pagoUnico ? { [periodo.id]: true } : {}, cicloActual,
  }).periodos.find((item) => item.id === periodo.id)?.resumen;
  const base = resumen('sin_descuento');
  if (!base) return null;
  const metodos = periodo.tipo === 'VERANO'
    ? [['sin_descuento', tarifario.metodosPago?.sin_descuento?.nombre ?? 'Sin descuento'] as const]
    : Object.entries(tarifario.metodosPago ?? { sin_descuento: { nombre: 'Sin descuento' } }).map(([id, metodo]) => [id, metodo.nombre] as const);
  const unico = periodo.tipo === 'REGULAR' ? resumen('sin_descuento', true) : undefined;
  return {
    matricula: base.costoMatricula,
    numeroCuotas: base.numeroCuotas,
    cuotas: metodos.map(([metodo, nombre]) => ({ metodo, nombre, cuotaMensual: resumen(metodo)?.montoPorCuota ?? base.montoPorCuota })),
    pagoUnico: unico ? {
      descuentoPorcentaje: unico.descuentoPorcentaje,
      pensionAlInicio: unico.costoEnsenanzaTotal,
      totalCiclo: unico.costoTotalCiclo,
    } : null,
  };
};

/**
 * El único motor de planificación (Estrategia, Autogenerar y el asistente). Traduce los límites del alumno a horas y
 * créditos (la cuota con horasMaximasParaCuota) y agrega los costos de cada periodo de la propuesta.
 */
export const generateOptimalPlanUseCase = (input: GenerateOptimalPlanInput): PropuestaPlan => {
  const maxCuotaMensual = numero(input.maxCuotaMensual);
  const disciplina = input.disciplina ?? '';
  const metodoPago = input.metodoPago ?? 'sin_descuento';
  const conCuota = maxCuotaMensual !== null && input.tarifario ? input.tarifario : null;
  const horasPorCuota = conCuota ? horasMaximasParaCuota(maxCuotaMensual!, conCuota, disciplina, { metodoPago }) : null;
  const horasPorCuotaVerano = conCuota
    ? horasMaximasParaCuota(maxCuotaMensual!, conCuota, disciplina, { tipoPeriodo: 'VERANO' }) : null;
  const maxHoras = numero(input.maxHorasPorPeriodo);
  // Con solo la cuota, las horas que esta paga, sin pasar las 24 h recomendadas.
  const techo = maxHoras ?? (horasPorCuota !== null ? ACADEMIC_LIMITS.horasRecomendadasPeriodo : null);
  const resultado = generarPlanificacionAutomatica(input.cursos, {
    totalCiclos: input.totalCiclos,
    ciclosExcluidos: input.ciclosExcluidos,
    cicloActual: input.cicloActual,
    periodoIngreso: input.periodoIngreso,
    maxHorasPorPeriodo: minimo(techo, horasPorCuota),
    maxHorasVerano: horasPorCuotaVerano !== null ? minimo(techo, horasPorCuotaVerano) : null,
    maxCreditosPorPeriodo: numero(input.maxCreditosPorPeriodo),
    usarVeranos: input.usarVeranos,
    alcance: input.alcance,
    conservarUbicados: input.conservarUbicados,
  });
  const servicio = input.servicioFinanciero ?? new FinancialPlanningService(new UniversityFinancialRulesProvider());
  return {
    ...resultado,
    periodos: resultado.periodos.map((periodo) => ({ ...periodo, costos: costosDe(periodo, resultado.cursos, input, servicio) })),
    limitesPedidos: {
      maxHorasPorPeriodo: maxHoras,
      maxCreditosPorPeriodo: numero(input.maxCreditosPorPeriodo),
      maxCuotaMensual,
      metodoPago: maxCuotaMensual !== null ? metodoPago : null,
      horasPorCuota,
      horasPorCuotaVerano,
    },
  };
};
