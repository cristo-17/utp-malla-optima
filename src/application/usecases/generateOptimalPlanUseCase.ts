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
import { obtenerHorasSinRecargo as obtenerTopeEscala } from '../../domain/rules/planningRules';
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
  /** "Menos de N" (estricto): ningún periodo llega a N horas o créditos. */
  horasEstricto?: boolean;
  creditosEstricto?: boolean;
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
  /** Calcula `alternativas` (por defecto, sí). La ruta sugerida y cada alternativa no las necesitan. */
  conAlternativas?: boolean;
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

/**
 * Otra forma de armar el plan que egresa antes o cuesta menos en total que la propuesta principal, calculada con el
 * mismo motor y el mismo motor financiero.
 * - metodoPago: el mismo presupuesto con otro método de pago (con pronto pago caben más horas en la misma cuota);
 * - veranos: usar los veranos del calendario;
 * - metodoPagoYVeranos: las dos cosas;
 * - topeSinCicloExtra: si la propuesta agrega ciclos para pocos créditos, las horas mínimas para no agregarlos
 *   (puede tener recargo por horas adicionales).
 */
export interface AlternativaPlan {
  tipo: 'metodoPago' | 'veranos' | 'metodoPagoYVeranos' | 'topeSinCicloExtra';
  /** Lo que cambia respecto de la propuesta: "Usar esta" lo aplica en Autogenerar. */
  opciones: { metodoPago?: string; usarVeranos?: boolean; maxHorasPorPeriodo?: number };
  nombreMetodo: string | null;
  cicloEgreso: number | null;
  periodoEgreso: PeriodoPropuesto['periodo'] | null;
  horasPorPeriodo: { periodoId: PeriodoPropuesto['periodo']['id']; horas: number }[];
  ciclosAgregados: number[];
  veranosUsados: PeriodoPropuesto['periodo']['id'][];
  costoTotalHastaEgresar: number | null;
  /** Total de la propuesta − total de la alternativa (positivo = ahorra); null sin costos. */
  ahorroVsPropuesta: number | null;
  /** Algún periodo pasa las horas sin recargo de la escala de pensión. */
  conRecargo: boolean;
}

export interface PropuestaPlan extends ResultadoPlanificacionAutomatica {
  limitesPedidos: LimitesPedidos;
  /** Total de todos los periodos de la propuesta con su método de pago (FinancialPlanningService); null sin tarifario. */
  costoTotalHastaEgresar: number | null;
  metodoPago: string;
  alternativas: AlternativaPlan[];
}

/** Créditos en los ciclos agregados que se consideran "pocos" para buscar un tope que no los necesite (≈ 2 cursos). */
export const CREDITOS_CICLO_EXTRA_POCOS = 6;
/** Hasta cuántas horas por ciclo se busca el tope sin ciclo extra. */
const HORAS_MAXIMAS_ALTERNATIVA = 30;

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
    horasEstricto: input.horasEstricto && maxHoras !== null,
    creditosEstricto: input.creditosEstricto,
    usarVeranos: input.usarVeranos,
    alcance: input.alcance,
    conservarUbicados: input.conservarUbicados,
  });
  const servicio = input.servicioFinanciero ?? new FinancialPlanningService(new UniversityFinancialRulesProvider());
  const principal = {
    ...resultado,
    periodos: resultado.periodos.map((periodo) => ({ ...periodo, costos: costosDe(periodo, resultado.cursos, input, servicio) })),
    costoTotalHastaEgresar: costoTotal(resultado.cursos, input, metodoPago, servicio),
    metodoPago,
    limitesPedidos: {
      maxHorasPorPeriodo: maxHoras,
      maxCreditosPorPeriodo: numero(input.maxCreditosPorPeriodo),
      maxCuotaMensual,
      metodoPago: maxCuotaMensual !== null ? metodoPago : null,
      horasPorCuota,
      horasPorCuotaVerano,
    },
  };
  return { ...principal, alternativas: input.conAlternativas === false ? [] : alternativasDe(principal, input, servicio) };
};

/** Total hasta egresar con el método de pago: la suma que ya hace FinancialPlanningService (sin sumas nuevas, F-018). */
const costoTotal = (cursos: Curso[], input: GenerateOptimalPlanInput, metodoPago: string, servicio: FinancialPlanningService) =>
  input.tarifario
    ? redondear(servicio.calcular(cursos, input.tarifario, input.disciplina ?? '', { metodoPago, cicloActual: input.cicloActual }).totalGeneral)
    : null;
const redondear = (monto: number) => Math.round((monto + Number.EPSILON) * 100) / 100;

const ordenEgreso = (propuesta: { periodoEgreso: { orden: number } | null }) => propuesta.periodoEgreso?.orden ?? -1;

/**
 * Alternativas que egresan antes o cuestan menos en total que la principal. Entre las que usan (o no) veranos, se
 * quita la que otra supera o iguala en egreso y en costo, para no repetir opciones peores.
 */
const alternativasDe = (principal: Omit<PropuestaPlan, 'alternativas'>, input: GenerateOptimalPlanInput, servicio: FinancialPlanningService): AlternativaPlan[] => {
  if (principal.alcance !== 'hastaEgresar' || !principal.periodoEgreso) return [];
  const { tarifario } = input;
  const metodos = Object.keys(tarifario?.metodosPago ?? {});
  const candidatas: { tipo: AlternativaPlan['tipo']; opciones: AlternativaPlan['opciones'] }[] = [];
  const conCuota = principal.limitesPedidos.maxCuotaMensual !== null;
  const otrosMetodos = conCuota ? metodos.filter((metodo) => metodo !== principal.metodoPago) : [];
  for (const metodo of otrosMetodos) candidatas.push({ tipo: 'metodoPago', opciones: { metodoPago: metodo } });
  if (!input.usarVeranos) {
    candidatas.push({ tipo: 'veranos', opciones: { usarVeranos: true } });
    for (const metodo of otrosMetodos) candidatas.push({ tipo: 'metodoPagoYVeranos', opciones: { metodoPago: metodo, usarVeranos: true } });
  }
  const resultados = candidatas.map((candidata) => ({
    ...candidata,
    propuesta: generateOptimalPlanUseCase({ ...input, ...candidata.opciones, conAlternativas: false, servicioFinanciero: servicio }),
  }));
  // Ciclos agregados con pocos créditos: el tope mínimo de horas que egresa sin ellos.
  const creditosExtra = principal.periodos.filter(({ periodo }) => periodo.tipo === 'REGULAR' && principal.ciclosAgregados.includes(periodo.cicloReferencia))
    .reduce((suma, periodo) => suma + periodo.creditos, 0);
  if (principal.ciclosAgregados.length && creditosExtra <= CREDITOS_CICLO_EXTRA_POCOS && !conCuota) {
    const desde = principal.limites.horasEstricto ? Math.ceil(principal.limites.horas) : Math.floor(principal.limites.horas) + 1;
    for (let horas = desde; horas <= HORAS_MAXIMAS_ALTERNATIVA; horas += 1) {
      const propuesta = generateOptimalPlanUseCase({
        ...input, maxHorasPorPeriodo: horas, horasEstricto: false, conAlternativas: false, servicioFinanciero: servicio,
      });
      if (!propuesta.ciclosAgregados.length && !propuesta.noPlanificados.length) {
        resultados.push({ tipo: 'topeSinCicloExtra', opciones: { maxHorasPorPeriodo: horas }, propuesta });
        break;
      }
    }
  }
  const tope = tarifario ? obtenerTopeEscala(tarifario, input.disciplina ?? '') : null;
  // Con veranos habilitados pero sin usar ninguno, es la misma propuesta que sin veranos: no se repite.
  const mejoran = resultados.filter(({ opciones, propuesta }) => !(opciones.usarVeranos && !propuesta.veranosUsados.length) &&
    !propuesta.noPlanificados.length && propuesta.periodoEgreso && (
    ordenEgreso(propuesta) < ordenEgreso(principal) ||
    (propuesta.costoTotalHastaEgresar !== null && principal.costoTotalHastaEgresar !== null &&
      propuesta.costoTotalHastaEgresar < principal.costoTotalHastaEgresar - 0.005)));
  // b supera a a si, con o sin veranos igual que a, no egresa después ni cuesta más (en empate gana la primera).
  const superada = (a: typeof mejoran[number], b: typeof mejoran[number]) => {
    if (a === b || Boolean(a.opciones.usarVeranos) !== Boolean(b.opciones.usarVeranos)) return false;
    const [egresoA, egresoB] = [ordenEgreso(a.propuesta), ordenEgreso(b.propuesta)];
    const [costoA, costoB] = [a.propuesta.costoTotalHastaEgresar ?? Infinity, b.propuesta.costoTotalHastaEgresar ?? Infinity];
    if (egresoB > egresoA || costoB > costoA) return false;
    return egresoB < egresoA || costoB < costoA || mejoran.indexOf(b) < mejoran.indexOf(a);
  };
  return mejoran.filter((alternativa) => !mejoran.some((otra) => superada(alternativa, otra)))
    .sort((a, b) => ordenEgreso(a.propuesta) - ordenEgreso(b.propuesta) ||
      (a.propuesta.costoTotalHastaEgresar ?? 0) - (b.propuesta.costoTotalHastaEgresar ?? 0))
    .map(({ tipo, opciones, propuesta }) => ({
      tipo, opciones,
      nombreMetodo: opciones.metodoPago ? tarifario?.metodosPago?.[opciones.metodoPago]?.nombre ?? opciones.metodoPago : null,
      cicloEgreso: propuesta.cicloEgreso,
      periodoEgreso: propuesta.periodoEgreso,
      horasPorPeriodo: propuesta.periodos.map(({ periodo, horas }) => ({ periodoId: periodo.id, horas })),
      ciclosAgregados: propuesta.ciclosAgregados,
      veranosUsados: propuesta.veranosUsados,
      costoTotalHastaEgresar: propuesta.costoTotalHastaEgresar,
      ahorroVsPropuesta: propuesta.costoTotalHastaEgresar !== null && principal.costoTotalHastaEgresar !== null
        ? redondear(principal.costoTotalHastaEgresar - propuesta.costoTotalHastaEgresar) : null,
      conRecargo: tope !== null && propuesta.periodos.some(({ periodo, horas }) => periodo.tipo === 'REGULAR' && horas > tope),
    }));
};
