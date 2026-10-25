import type { Curso, PeriodoAcademico } from '../../types/academic';
import type { Tarifario } from '../../types/financial';
import type { AcademicStore } from '../../store/types';
import electivosAreas from '../../data/universidades/pe-utp/electivosAreas.json';
import { ACADEMIC_LIMITS } from '../../config/academicLimits';
import { obtenerPeriodoCurso } from '../../domain/rules/academicPeriodRules';
import { periodoBloqueadoPorCicloActual } from '../../domain/rules/academicContextRules';
import {
  esCursoJalado, estaEnVentana, jaladosFaltantes, nombrePeriodoCorto, planificadosSinJalado, ventanaDesdeCiclo, ventanaJalado,
} from '../../domain/rules/jaladoRules';
import { calcularHorasEfectivas, MINIMO_CREDITOS_ELECTIVOS, obtenerHorasSinRecargo } from '../../domain/rules/planningRules';
import { calcularPrioridadesPendientes } from '../../domain/services/recommendationService';
import { simularJalado } from '../../domain/services/whatIfService';
import { FinancialPlanningService } from '../../financial/services/FinancialPlanningService';
import { UniversityFinancialRulesProvider } from '../../financial/rules/UniversityFinancialRulesProvider';
import type { MotivoNoPlanificado } from '../../domain/services/automaticPlanningService';
import { generateOptimalPlanUseCase, type GenerateOptimalPlanInput, type PropuestaPlan } from '../usecases/generateOptimalPlanUseCase';
import type {
  AICarga, AIContext, AICursoPlanificado, AIDerivados, AIEscenarioPeriodo, AIFoco, AIFocoContexto, AIPropuestaConLimites, AIWhatIf,
} from './contracts';
import type { LimitesDelMensaje } from './limites';
import { pagoUnicoDe, positivo, presupuestoPorEscenario, r2 } from './presupuesto';

/**
 * Contexto del asistente IA. Función PURA: lee el estado del store y devuelve
 * todo ya calculado (créditos, costos, carga, what-if, ruta), para que la IA
 * solo redacte. Copia campos explícitos: nunca nombreArchivoCargado ni otro
 * dato identificable.
 */
export type EstadoContextoIA = Pick<AcademicStore,
  'cursos' | 'tarifario' | 'metodoPago' | 'pagoUnicoPorPeriodo' | 'disciplinaActiva' |
  'periodoIngreso' | 'cicloActual' | 'totalCiclos' | 'ciclosExcluidos'>;

export interface OpcionesContextoIA {
  foco?: AIFoco;
  presupuestoMensual?: number | null;
  servicioFinanciero?: FinancialPlanningService;
  /** Límites que pidió el alumno en su mensaje (detectarLimites): agregan propuestaConLimites. */
  limites?: LimitesDelMensaje | null;
}

/** Cursos con longitudCadena desde este valor cuentan como cadena larga en la carga. */
export const LONGITUD_CADENA_LARGA = 3;

const AREAS: Record<string, { area: string; confirmado: boolean }> = electivosAreas;
const COMPLETADOS = new Set(['APROBADO', 'CONVALIDADO']);
const ESCENARIOS = ['sin_descuento', 'interbank_scotiabank', 'bcp_bbva', 'pago_unico'] as const;

const sumar = (cursos: Curso[], campo: 'creditos' | 'horasSemanales') => r2(cursos.reduce((suma, curso) => suma + curso[campo], 0));
const ubicacionDe = (curso: Curso) => curso.ubicacion === 'banco' ? 'banco' : obtenerPeriodoCurso(curso).id;

/** Periodo futuro (no bloqueado por el ciclo actual) donde está planificado el curso, o null. */
const periodoPlanificado = (curso: Curso, cicloActual: number | null): PeriodoAcademico | null => {
  if (curso.estado !== 'PENDIENTE' || curso.ubicacion !== 'periodo') return null;
  const periodo = obtenerPeriodoCurso(curso);
  return cicloActual && periodoBloqueadoPorCicloActual(periodo, cicloActual) ? null : periodo;
};

const agruparPorPeriodo = (cursos: Curso[], cicloActual: number | null) => {
  const grupos = new Map<string, { periodo: PeriodoAcademico; cursos: Curso[] }>();
  for (const curso of cursos) {
    const periodo = periodoPlanificado(curso, cicloActual);
    if (!periodo) continue;
    grupos.set(periodo.id, { periodo, cursos: [...(grupos.get(periodo.id)?.cursos ?? []), curso] });
  }
  return [...grupos.values()].sort((a, b) => a.periodo.orden - b.periodo.orden);
};

const resumenPeriodo = (periodo: PeriodoAcademico, cursos: Curso[]) => ({
  id: periodo.id,
  etiqueta: nombrePeriodoCorto(periodo),
  cursos: cursos.map((curso) => curso.codigo),
  horas: r2(calcularHorasEfectivas(cursos, periodo.tipo)),
  creditos: sumar(cursos, 'creditos'),
});

/**
 * Nivel de carga determinista de un periodo (lo explica la IA, no lo decide):
 *   horas efectivas > límite recomendado (24 h)        → +3
 *   horas > tope de la escala de pensión (22 h)       → +2
 *   horas >= tope de la escala - 2 (desde 20 h)       → +1
 *   cursos de 4 h o más: 5 o más → +2; 3 o 4 → +1
 *   laboratorios: 2 o más                              → +1
 *   cursos con longitudCadena >= 3: 3 o más            → +1
 * nivel = "riesgo" si puntos >= 4 o se superan las 24 h; "atencion" si puntos >= 2; si no, "ok".
 * Sin escala de pensión, el tope es el límite de horas de planificación.
 */
export const calcularCarga = (
  cursos: Curso[], tipo: PeriodoAcademico['tipo'], topeEscala: number | null,
  prioridades: Map<string, { longitudCadena: number }>,
): AICarga => {
  const horas = r2(calcularHorasEfectivas(cursos, tipo));
  const limiteRecomendado = ACADEMIC_LIMITS.horasRecomendadasPeriodo;
  const tope = topeEscala ?? ACADEMIC_LIMITS.horasMaximasPlanificacion;
  const cursos4HorasOMas = cursos.filter((curso) => curso.horasSemanales >= 4).length;
  const laboratorios = cursos.filter((curso) => curso.esLaboratorio).length;
  const cadenasLargas = cursos.filter((curso) =>
    (prioridades.get(curso.codigo)?.longitudCadena ?? 0) >= LONGITUD_CADENA_LARGA).length;

  let puntos = 0;
  const motivos: string[] = [];
  if (horas > limiteRecomendado) {
    puntos += 3;
    motivos.push(`Supera las ${limiteRecomendado} h recomendadas (${horas} h).`);
  } else if (horas > tope) {
    puntos += 2;
    motivos.push(`Supera las ${tope} h de la escala de pensión (${horas} h).`);
  } else if (horas >= tope - 2 && horas > 0) {
    puntos += 1;
    motivos.push(`Está cerca del tope de ${tope} h (${horas} h).`);
  }
  if (cursos4HorasOMas >= 3) {
    puntos += cursos4HorasOMas >= 5 ? 2 : 1;
    motivos.push(`${cursos4HorasOMas} cursos de 4 h o más.`);
  }
  if (laboratorios >= 2) {
    puntos += 1;
    motivos.push(`${laboratorios} cursos con laboratorio.`);
  }
  if (cadenasLargas >= 3) {
    puntos += 1;
    motivos.push(`${cadenasLargas} cursos abren cadenas largas de prerrequisitos.`);
  }
  const nivel = puntos >= 4 || horas > limiteRecomendado ? 'riesgo' : puntos >= 2 ? 'atencion' : 'ok';
  return { nivel, puntos, horas, topeEscala, limiteRecomendado, cursos4HorasOMas, laboratorios, cadenasLargas, motivos };
};

const detalleCursos = (cursos: Curso[], prioridades: Map<string, { impacto: number; longitudCadena: number }>): AICursoPlanificado[] =>
  cursos.map((curso) => ({
    codigo: curso.codigo,
    nombre: curso.nombre,
    creditos: curso.creditos,
    horas: curso.horasSemanales,
    tipo: curso.tipo,
    impacto: prioridades.get(curso.codigo)?.impacto ?? 0,
    longitudCadena: prioridades.get(curso.codigo)?.longitudCadena ?? 0,
    esLaboratorio: Boolean(curso.esLaboratorio),
    jalado: Boolean(curso.jalado),
  }));

type PeriodoId = AIWhatIf['ventanaSiJala'][number];

/**
 * Ventana hipotética si se jalara el curso, con la regla de dominio
 * (ventanaDesdeCiclo: mes de ingreso y jaladoPermiteVerano) según el periodo
 * donde está o estará: jalado en el Ciclo N → [Verano N si existe, Ciclo N+1];
 * jalado en el Verano N → [Ciclo N+1]. En el banco no hay periodo: vacía.
 */
export const ventanaSiJala = (curso: Curso, estado: Pick<EstadoContextoIA, 'periodoIngreso'>): PeriodoId[] => {
  if (curso.ubicacion !== 'periodo') return [];
  const periodo = obtenerPeriodoCurso(curso);
  const contexto = { periodoIngreso: estado.periodoIngreso, ...(periodo.tipo === 'VERANO' ? { jaladoPermiteVerano: false } : {}) };
  return ventanaDesdeCiclo(periodo.cicloReferencia, contexto).map((item) => item.id);
};

const whatIfDe = (curso: Curso, estado: EstadoContextoIA): Omit<AIWhatIf, 'origen'> => {
  const { codigo } = curso;
  const simulacion = simularJalado(codigo, estado.cursos);
  return {
    codigo,
    cursosBloqueados: simulacion.cursosBloqueados.map((curso) => curso.codigo),
    planificadosInvalidos: simulacion.planificadosInvalidos.map(({ codigo: afectado, periodoId }) =>
      ({ codigo: afectado, periodoId: periodoId as PeriodoId })),
    ventanaSiJala: ventanaSiJala(curso, estado),
  };
};

interface EntornoFinanciero {
  servicio: FinancialPlanningService;
  tarifario: Tarifario;
  estado: EstadoContextoIA;
  presupuesto: number | null;
}

const nombreEscenario = (id: typeof ESCENARIOS[number], tarifario: Tarifario) =>
  id === 'pago_unico'
    ? `Pago único (${tarifario.descuentoPagoUnicoRegular ?? 7.5} % de descuento)`
    : tarifario.metodosPago?.[id]?.nombre ?? id;

const calcularEscenario = (id: typeof ESCENARIOS[number], { servicio, tarifario, estado }: EntornoFinanciero) => {
  const { cursos, disciplinaActiva, cicloActual } = estado;
  const pagoUnico = id === 'pago_unico';
  const periodosRegulares = Object.fromEntries(cursos.filter((curso) => curso.tipoPeriodo === 'REGULAR')
    .map((curso) => [`ciclo-${curso.ciclo}`, true]));
  return servicio.calcular(cursos, tarifario, disciplinaActiva, {
    metodoPago: pagoUnico ? 'sin_descuento' : id,
    pagoUnicoPorPeriodo: pagoUnico ? periodosRegulares : {},
    cicloActual,
  });
};

const escenariosPeriodo = (periodoId: string, entorno: EntornoFinanciero): AIEscenarioPeriodo[] =>
  ESCENARIOS.flatMap((id) => {
    const periodo = calcularEscenario(id, entorno).periodos.find((item) => item.id === periodoId);
    if (!periodo) return [];
    const { resumen } = periodo;
    // El pago único no es mensual: todas las pensiones se pagan juntas al inicio (derivados.pagoUnico).
    const cuotaMensual = resumen.pagoUnico ? null : resumen.montoPorCuota;
    return [{
      id,
      nombre: nombreEscenario(id, entorno.tarifario),
      matricula: resumen.costoMatricula,
      numeroCuotas: resumen.numeroCuotas,
      cuotaMensual,
      total: resumen.costoTotalCiclo,
      diferenciaPresupuesto: entorno.presupuesto === null || cuotaMensual === null ? null : r2(entorno.presupuesto - cuotaMensual),
    }];
  });

/** Pensión del ciclo con pago único (la que ya calcula FinancialPlanningService), para derivados.pagoUnico. */
const pensionPagoUnico = (periodoId: string, entorno: EntornoFinanciero) =>
  calcularEscenario('pago_unico', entorno).periodos.find((item) => item.id === periodoId)?.resumen.costoEnsenanzaTotal ?? null;

const construirFoco = (
  foco: AIFoco | undefined, estado: EstadoContextoIA, prioridades: Map<string, { impacto: number; longitudCadena: number }>,
  topeEscala: number | null, entorno: EntornoFinanciero | null,
): AIFocoContexto | null => {
  if (!foco) return null;
  if (foco.tipo === 'plan') return { tipo: 'plan' };
  const { cursos, cicloActual } = estado;
  const contextoJalados = { cicloActual, periodoIngreso: estado.periodoIngreso };

  if (foco.tipo === 'ciclo') {
    const grupo = agruparPorPeriodo(cursos, cicloActual).find((item) => item.periodo.id === foco.id);
    if (!grupo) return null;
    return {
      tipo: 'ciclo',
      periodo: resumenPeriodo(grupo.periodo, grupo.cursos),
      cursos: detalleCursos(grupo.cursos, prioridades),
      carga: calcularCarga(grupo.cursos, grupo.periodo.tipo, topeEscala, prioridades),
      escenarios: entorno ? escenariosPeriodo(grupo.periodo.id, entorno) : [],
      jaladosEnVentana: cursos.filter((curso) => esCursoJalado(curso) &&
        ventanaJalado(curso, cursos, contextoJalados).some((periodo) => periodo.id === grupo.periodo.id))
        .map((curso) => curso.codigo),
    };
  }

  const curso = cursos.find((item) => item.codigo === foco.id);
  if (!curso) return null;
  const porCodigo = new Map(cursos.map((item) => [item.codigo, item]));
  return {
    tipo: 'curso',
    codigo: curso.codigo,
    nombre: curso.nombre,
    estado: curso.estado,
    tipoCurso: curso.tipo,
    creditos: curso.creditos,
    horas: curso.horasSemanales,
    ubicacion: ubicacionDe(curso),
    esLaboratorio: Boolean(curso.esLaboratorio),
    jalado: esCursoJalado(curso),
    impacto: prioridades.get(curso.codigo)?.impacto ?? 0,
    longitudCadena: prioridades.get(curso.codigo)?.longitudCadena ?? 0,
    prerrequisitos: curso.prerrequisitos.flatMap((codigo) => {
      const requisito = porCodigo.get(codigo);
      return requisito ? [{ codigo, nombre: requisito.nombre, estado: requisito.estado }] : [];
    }),
    habilitaA: cursos.filter((item) => item.prerrequisitos.includes(curso.codigo)).map((item) => item.codigo),
    whatIf: whatIfDe(curso, estado),
    ventanaRecuperacion: esCursoJalado(curso) ? ventanaJalado(curso, cursos, contextoJalados).map((periodo) => periodo.id) : [],
    area: AREAS[curso.codigo]?.area ?? null,
  };
};


/**
 * CONTEXTO.derivados: las restas y totales que la IA no debe hacer (D-001).
 * Créditos para egresar = obligatorios + el mínimo de electivos de academic.json (creditosMinimosElectivos);
 * los electivos aprobados cuentan solo hasta ese mínimo.
 */
export const calcularDerivados = (
  cursos: Curso[], carga: AICarga, escenarios: AIEscenarioPeriodo[], presupuesto: number | null,
  cursosProximos: Curso[], whatIfProximos: Omit<AIWhatIf, 'origen'>[], ciclosRestantes: number,
  pensionAlInicio: number | null = null, tipoProximo: PeriodoAcademico['tipo'] = 'REGULAR',
): Omit<AIDerivados, 'proximoPeriodoConJalados' | 'planificadosBloqueadosPorJalado'> => {
  const tope = carga.topeEscala;
  const obligatorios = cursos.filter((curso) => curso.tipo === 'OBLIGATORIO');
  const electivosAprobados = sumar(cursos.filter((curso) => curso.tipo === 'ELECTIVO' && COMPLETADOS.has(curso.estado)), 'creditos');
  const paraEgresar = r2(sumar(obligatorios, 'creditos') + MINIMO_CREDITOS_ELECTIVOS);
  const aprobadosQueCuentan = r2(sumar(obligatorios.filter((curso) => COMPLETADOS.has(curso.estado)), 'creditos')
    + Math.min(electivosAprobados, MINIMO_CREDITOS_ELECTIVOS));
  const faltanParaEgresar = positivo(paraEgresar - aprobadosQueCuentan);
  const obligatoriosEnCurso = sumar(obligatorios.filter((curso) => curso.estado === 'EN_CURSO'), 'creditos');
  const bloqueos = new Map(whatIfProximos.map((item) => [item.codigo, item.planificadosInvalidos.map((afectado) => afectado.codigo)]));
  return {
    horas: {
      proximoPeriodo: carga.horas,
      topeEscala: tope,
      sobreTopeEscala: tope === null ? 0 : positivo(carga.horas - tope),
      margenTopeEscala: tope === null ? 0 : positivo(tope - carga.horas),
      recomendadas: carga.limiteRecomendado,
      sobreRecomendadas: positivo(carga.horas - carga.limiteRecomendado),
      margenRecomendadas: positivo(carga.limiteRecomendado - carga.horas),
    },
    presupuesto: presupuestoPorEscenario(escenarios, presupuesto),
    pagoUnico: pagoUnicoDe(escenarios, presupuesto, pensionAlInicio),
    // "Si sacas X bajas a N h": la resta la hace el código, con las horas efectivas del periodo.
    horasSinCadaCurso: cursosProximos.map((curso) => {
      const horasSinElCurso = r2(calcularHorasEfectivas(cursosProximos.filter((otro) => otro.codigo !== curso.codigo), tipoProximo));
      return { codigo: curso.codigo, nombre: curso.nombre, horasSinElCurso, quedaBajoTopeEscala: tope === null ? null : horasSinElCurso <= tope };
    }),
    creditosElectivosFaltantes: positivo(MINIMO_CREDITOS_ELECTIVOS - electivosAprobados),
    creditos: {
      totalMalla: sumar(cursos, 'creditos'),
      obligatorios: sumar(obligatorios, 'creditos'),
      electivosMinimos: MINIMO_CREDITOS_ELECTIVOS,
      paraEgresar,
      aprobadosQueCuentan,
      enCurso: sumar(cursos.filter((curso) => curso.estado === 'EN_CURSO'), 'creditos'),
      faltanParaEgresar,
      faltanSiApruebaEnCurso: positivo(faltanParaEgresar - obligatoriosEnCurso),
      ciclosRestantes,
    },
    cursosProximoPeriodo: cursosProximos.map((curso) => {
      const bloquearia = bloqueos.get(curso.codigo) ?? [];
      return {
        codigo: curso.codigo,
        nombre: curso.nombre,
        creditos: curso.creditos,
        horas: curso.horasSemanales,
        estado: curso.estado,
        jalado: esCursoJalado(curso),
        sePuedeMover: bloquearia.length === 0,
        bloquearia,
      };
    }),
  };
};

/**
 * derivados.proximoPeriodoConJalados: los jalados fuera de su ventana cuya ventana incluye el próximo periodo, puestos
 * en él; horas, créditos, topes y costos con el mismo motor (calcularHorasEfectivas, FinancialPlanningService).
 */
const proximoPeriodoConJalados = (
  estado: EstadoContextoIA, siguiente: { periodo: PeriodoAcademico; cursos: Curso[] } | undefined,
  topeEscala: number | null, entorno: EntornoFinanciero | null,
): AIDerivados['proximoPeriodoConJalados'] => {
  if (!siguiente) return null;
  const contexto = { cicloActual: estado.cicloActual, periodoIngreso: estado.periodoIngreso };
  const agregar = jaladosFaltantes(estado.cursos, contexto)
    .filter((jalado) => ventanaJalado(jalado, estado.cursos, contexto).some((periodo) => periodo.id === siguiente.periodo.id));
  if (!agregar.length) return null;
  const codigos = new Set(agregar.map((jalado) => jalado.codigo));
  const { periodo } = siguiente;
  const cursos = estado.cursos.map((curso) => codigos.has(curso.codigo)
    ? { ...curso, ciclo: periodo.cicloReferencia, tipoPeriodo: periodo.tipo, ubicacion: 'periodo' as const } : curso);
  const enPeriodo = [...siguiente.cursos, ...cursos.filter((curso) => codigos.has(curso.codigo))];
  const horas = r2(calcularHorasEfectivas(enPeriodo, periodo.tipo));
  const recomendadas = ACADEMIC_LIMITS.horasRecomendadasPeriodo;
  const conJalados = entorno ? { ...entorno, estado: { ...estado, cursos } } : null;
  const escenarios = conJalados ? escenariosPeriodo(periodo.id, conJalados) : [];
  return {
    periodoId: periodo.id,
    jalados: agregar.map((jalado) => jalado.codigo),
    horas,
    creditos: sumar(enPeriodo, 'creditos'),
    superaTopeEscala: topeEscala === null ? null : horas > topeEscala,
    horasSobreTopeEscala: topeEscala === null ? 0 : positivo(horas - topeEscala),
    superaRecomendadas: horas > recomendadas,
    horasSobreRecomendadas: positivo(horas - recomendadas),
    escenarios: escenarios.flatMap((escenario) => escenario.cuotaMensual === null || escenario.id === 'pago_unico' ? [] : [{
      id: escenario.id, nombre: escenario.nombre, cuotaMensual: escenario.cuotaMensual, total: escenario.total,
      diferenciaMes: conJalados?.presupuesto === null || !conJalados ? null : r2(conJalados.presupuesto - escenario.cuotaMensual),
    }]),
    pagoUnico: conJalados ? pagoUnicoDe(escenarios, conJalados.presupuesto, pensionPagoUnico(periodo.id, conJalados)) : null,
  };
};

const MOTIVO_NO_ENTRA: Record<MotivoNoPlanificado['tipo'], string> = {
  HORAS_INVALIDAS: 'no tiene horas válidas en el Excel',
  SIN_CICLOS_FUTUROS: 'no quedan ciclos para ubicarlo',
  DEPENDENCIA_CIRCULAR: 'sus prerrequisitos forman un ciclo',
  REQUISITO_SIN_ESPACIO: 'su prerrequisito queda en el último ciclo disponible',
  REQUISITO_NO_PROGRAMADO: 'su prerrequisito no está programado antes',
  SIN_ESPACIO: 'no entra con esos límites',
  NO_CABE_EN_PERIODO: 'pasaría el límite del periodo',
  ELECTIVO_ESPERA_OBLIGATORIOS: 'el electivo va después de los obligatorios',
};

/** Con "un ciclo más": las horas mínimas por ciclo con las que se egresa a lo más un ciclo después (búsqueda binaria). */
const repartirEnUnCicloMas = (entrada: GenerateOptimalPlanInput, base: PropuestaPlan): PropuestaPlan => {
  if (base.cicloEgreso === null || base.alcance !== 'hastaEgresar') return base;
  const objetivo = base.cicloEgreso + 1;
  let [desde, hasta, mejor] = [1, base.limites.horas, base];
  while (desde < hasta) {
    const medio = Math.floor((desde + hasta) / 2);
    const intento = generateOptimalPlanUseCase({ ...entrada, maxHorasPorPeriodo: medio });
    if (!intento.noPlanificados.length && intento.cicloEgreso !== null && intento.cicloEgreso <= objetivo) {
      [hasta, mejor] = [medio, intento];
    } else desde = medio + 1;
  }
  return mejor;
};

/**
 * CONTEXTO.propuestaConLimites: el planificador (el mismo de Autogenerar) con los límites del mensaje. Un solo ciclo
 * nombrado, si es el próximo, arma solo ese periodo; si no, hasta egresar. Reordena lo ubicado: el alumno pidió
 * armar el plan con sus límites. Nunca se aplica sola (aplicadaEnMalla: false).
 */
const propuestaConLimitesDe = (
  estado: EstadoContextoIA, limites: LimitesDelMensaje | null | undefined, servicio?: FinancialPlanningService,
): AIPropuestaConLimites | null => {
  if (!limites) return null;
  const proximo = (estado.cicloActual ?? 0) + 1;
  const alcance = limites.unSoloCiclo && (!limites.ciclos.length || limites.ciclos[0] === proximo) ? 'proximoPeriodo' : 'hastaEgresar';
  const entrada: GenerateOptimalPlanInput = {
    cursos: estado.cursos, totalCiclos: estado.totalCiclos, ciclosExcluidos: estado.ciclosExcluidos,
    cicloActual: estado.cicloActual, periodoIngreso: estado.periodoIngreso,
    tarifario: estado.tarifario, disciplina: estado.disciplinaActiva, metodoPago: estado.metodoPago, servicioFinanciero: servicio,
    maxHorasPorPeriodo: limites.maxHorasPorPeriodo, maxCreditosPorPeriodo: limites.maxCreditosPorPeriodo,
    maxCuotaMensual: limites.maxCuotaMensual, usarVeranos: limites.usarVeranos ?? false, alcance, conservarUbicados: false,
  };
  const base = generateOptimalPlanUseCase(entrada);
  const propuesta = limites.agregarCiclo ? repartirEnUnCicloMas(entrada, base) : base;
  const periodos = alcance === 'proximoPeriodo'
    ? propuesta.periodos.filter((item) => item.periodo.id === propuesta.periodoInicio.id) : propuesta.periodos;
  return {
    limites: {
      maxHorasPorPeriodo: limites.maxHorasPorPeriodo,
      maxCreditosPorPeriodo: limites.maxCreditosPorPeriodo,
      maxCuotaMensual: propuesta.limitesPedidos.maxCuotaMensual,
      metodoPago: propuesta.limitesPedidos.metodoPago,
      horasPorCuota: propuesta.limitesPedidos.horasPorCuota,
      horasAplicadas: propuesta.limites.horas,
      creditosAplicados: propuesta.limites.creditos,
      usarVeranos: limites.usarVeranos ?? false,
      agregarCiclo: limites.agregarCiclo,
      alcance,
    },
    periodos: periodos.map(({ periodo, cursos, horas, creditos, costos }) => {
      const cuotas = costos?.cuotas ?? [];
      return {
        periodoId: periodo.id,
        etiqueta: nombrePeriodoCorto(periodo),
        cursos: cursos.map((curso) => curso.codigo),
        numeroCursos: cursos.length,
        horas: r2(horas),
        creditos: r2(creditos),
        cuotaMensual: (cuotas.find((cuota) => cuota.metodo === estado.metodoPago) ?? cuotas[0])?.cuotaMensual ?? null,
        pagoUnicoAlInicio: costos?.pagoUnico?.pensionAlInicio ?? null,
      };
    }),
    ciclosAgregados: propuesta.ciclosAgregados,
    veranosUsados: propuesta.veranosUsados,
    cicloEgreso: propuesta.cicloEgreso,
    ciclosExtraVsSinLimites: propuesta.comparacionSinLimites?.ciclosExtra ?? null,
    noEntraron: propuesta.noPlanificados.map((curso) => ({ codigo: curso.codigo, motivo: MOTIVO_NO_ENTRA[curso.motivos[0]?.tipo ?? 'SIN_ESPACIO'] })),
    aplicadaEnMalla: false,
  };
};

export const buildAIContext = (estado: EstadoContextoIA, opciones: OpcionesContextoIA = {}): AIContext => {
  const { cursos, tarifario, disciplinaActiva, cicloActual, periodoIngreso } = estado;
  const contextoJalados = { cicloActual, periodoIngreso };
  const prioridades = calcularPrioridadesPendientes(cursos);
  const topeEscala = obtenerHorasSinRecargo(tarifario, disciplinaActiva);
  const presupuesto = opciones.presupuestoMensual && opciones.presupuestoMensual > 0 ? r2(opciones.presupuestoMensual) : null;
  const entorno: EntornoFinanciero | null = tarifario ? {
    servicio: opciones.servicioFinanciero ?? new FinancialPlanningService(new UniversityFinancialRulesProvider()),
    tarifario, estado, presupuesto,
  } : null;

  const conEstado = (...estados: string[]) => cursos.filter((curso) => estados.includes(curso.estado));
  const electivosCubiertos = sumar(cursos.filter((curso) => curso.tipo === 'ELECTIVO' &&
    (COMPLETADOS.has(curso.estado) || curso.ubicacion === 'periodo')), 'creditos');

  const grupos = agruparPorPeriodo(cursos, cicloActual);
  const siguiente = grupos[0];
  const cursosProximos = siguiente?.cursos ?? [];
  const financieroProximo = siguiente && entorno
    ? calcularEscenario('sin_descuento', entorno).periodos.find((item) => item.id === siguiente.periodo.id) : undefined;

  const ruta = (() => {
    const propuesta = generateOptimalPlanUseCase({
      cursos, totalCiclos: estado.totalCiclos, ciclosExcluidos: estado.ciclosExcluidos, cicloActual, periodoIngreso,
    });
    const periodos = agruparPorPeriodo(propuesta.cursos, cicloActual);
    const cicloFinal = periodos.length ? Math.max(...periodos.map((item) => item.periodo.cicloReferencia)) : null;
    return {
      propuesta: periodos.map((item) => ({ periodoId: item.periodo.id, cursos: item.cursos.map((curso) => curso.codigo) })),
      ciclosRestantes: cicloFinal && cicloActual ? Math.max(0, cicloFinal - cicloActual) : periodos.length,
      cicloFinal,
      noPlanificados: propuesta.noPlanificados.map((curso) => curso.codigo),
    };
  })();

  const carga = calcularCarga(cursosProximos, siguiente?.periodo.tipo ?? 'REGULAR', topeEscala, prioridades);
  const escenariosProximos = siguiente && entorno ? escenariosPeriodo(siguiente.periodo.id, entorno) : [];
  const whatIfProximos = cursosProximos.map((curso) => whatIfDe(curso, estado));
  const metodo = tarifario?.metodosPago?.[estado.metodoPago];
  const tarifas = tarifario ? tarifario.disciplinas[disciplinaActiva] ?? Object.values(tarifario.disciplinas)[0] : undefined;

  return {
    version: 1,
    perfil: {
      periodoIngreso,
      cicloActual,
      totalCiclos: estado.totalCiclos,
      disciplina: disciplinaActiva,
      creditos: {
        aprobados: sumar(conEstado('APROBADO', 'CONVALIDADO'), 'creditos'),
        enCurso: sumar(conEstado('EN_CURSO'), 'creditos'),
        pendientesEnMalla: sumar(conEstado('PENDIENTE'), 'creditos'),
      },
      electivos: {
        cubiertos: electivosCubiertos,
        minimo: MINIMO_CREDITOS_ELECTIVOS,
        faltantes: r2(Math.max(0, MINIMO_CREDITOS_ELECTIVOS - electivosCubiertos)),
      },
    },
    catalogo: cursos.map((curso) => ({
      codigo: curso.codigo, nombre: curso.nombre, estado: curso.estado, tipo: curso.tipo,
      creditos: curso.creditos, ubicacion: ubicacionDe(curso),
    })),
    periodosPlanificados: grupos.map((grupo) => resumenPeriodo(grupo.periodo, grupo.cursos)),
    proximoPeriodo: siguiente ? {
      id: siguiente.periodo.id,
      etiqueta: nombrePeriodoCorto(siguiente.periodo),
      cursos: detalleCursos(cursosProximos, prioridades),
      totalHoras: r2(calcularHorasEfectivas(cursosProximos, siguiente.periodo.tipo)),
      totalCreditos: sumar(cursosProximos, 'creditos'),
      horasExceso: financieroProximo?.resumen.horasExceso ?? 0,
    } : null,
    jalados: cursos.filter(esCursoJalado).map((curso) => ({
      codigo: curso.codigo,
      nombre: curso.nombre,
      ventana: ventanaJalado(curso, cursos, contextoJalados).map((periodo) => periodo.id),
      ubicacionActual: ubicacionDe(curso),
      enVentana: estaEnVentana(curso, cursos, contextoJalados),
    })),
    financiero: entorno && tarifario ? {
      moneda: tarifario.moneda,
      referencia: `Tarifario ${tarifario.tarifarioVersion ?? ''} ${tarifario.sede ?? ''}`.replace(/\s+/g, ' ').trim() + ' (referencial)',
      metodoPagoElegido: { id: estado.metodoPago, nombre: metodo?.nombre ?? estado.metodoPago },
      costoHoraAdicional: tarifas?.costoHoraAdicional ?? null,
      presupuestoMensual: presupuesto,
      presupuestoFuente: presupuesto === null ? null : 'plan',
      proximoPeriodo: escenariosProximos,
      planCompleto: ESCENARIOS.map((id) => ({
        id, nombre: nombreEscenario(id, tarifario), total: r2(calcularEscenario(id, entorno).totalGeneral),
      })),
    } : null,
    carga,
    whatIf: [
      ...conEstado('EN_CURSO').map((curso) => ({ ...whatIfDe(curso, estado), origen: 'EN_CURSO' as const })),
      ...whatIfProximos.map((item) => ({ ...item, origen: 'PROXIMO_PERIODO' as const })),
    ],
    ruta,
    electivos: cursos.filter((curso) => curso.tipo === 'ELECTIVO' && curso.estado === 'PENDIENTE').map((curso) => ({
      codigo: curso.codigo,
      nombre: curso.nombre,
      creditos: curso.creditos,
      horas: curso.horasSemanales,
      area: AREAS[curso.codigo]?.area ?? null,
      areaConfirmada: AREAS[curso.codigo]?.confirmado ?? false,
      ubicacion: ubicacionDe(curso),
    })),
    limites: { ...ACADEMIC_LIMITS, topeEscalaPension: topeEscala },
    foco: construirFoco(opciones.foco, estado, prioridades, topeEscala, entorno),
    derivados: {
      ...calcularDerivados(
        cursos, carga, escenariosProximos, entorno ? presupuesto : null, cursosProximos, whatIfProximos, ruta.ciclosRestantes,
        siguiente && entorno ? pensionPagoUnico(siguiente.periodo.id, entorno) : null, siguiente?.periodo.tipo,
      ),
      proximoPeriodoConJalados: proximoPeriodoConJalados(estado, siguiente, topeEscala, entorno),
      // La misma regla que la app: planificados que un jalado fuera de su ventana deja inválidos.
      planificadosBloqueadosPorJalado: siguiente
        ? planificadosSinJalado(cursos, contextoJalados).filter((curso) => siguiente.cursos.some((item) => item.codigo === curso.codigo))
        : [],
    },
    propuestaConLimites: propuestaConLimitesDe(estado, opciones.limites, entorno?.servicio),
  };
};
