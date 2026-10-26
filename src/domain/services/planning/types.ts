import type { Curso, PeriodoAcademico, PeriodoIngreso } from '../../../types/academic';

export interface CursoPlanificadoResumen {
  codigo: string;
  nombre: string;
  creditos: number;
  impacto: number;
}

export interface CicloPlanificadoResumen {
  ciclo: number;
  periodo: PeriodoAcademico;
  creditos: number;
  horasEfectivas: number;
  impacto: number;
  cursos: CursoPlanificadoResumen[];
}

export type MotivoNoPlanificado =
  | { tipo: 'HORAS_INVALIDAS' }
  | { tipo: 'SIN_CICLOS_FUTUROS' }
  | { tipo: 'DEPENDENCIA_CIRCULAR' }
  | { tipo: 'REQUISITO_SIN_ESPACIO'; requisito: { codigo: string; nombre: string }; periodo: PeriodoAcademico }
  | { tipo: 'REQUISITO_NO_PROGRAMADO'; requisito: { codigo: string; nombre: string } }
  | { tipo: 'SIN_ESPACIO'; cicloFinal: number; limiteHoras: number; limiteCreditos?: number | null }
  /** Alcance "proximoPeriodo": se podía llevar en el periodo, pero pasaba el límite de horas o de créditos. */
  | { tipo: 'NO_CABE_EN_PERIODO'; periodo: PeriodoAcademico; limiteHoras: number; limiteCreditos: number | null }
  | { tipo: 'ELECTIVO_ESPERA_OBLIGATORIOS' };

export interface CursoNoPlanificado {
  codigo: string;
  nombre: string;
  motivos: MotivoNoPlanificado[];
}

export type ExplicacionPlan =
  | { tipo: 'RESUMEN'; total: number; cicloInicio: number; cicloFinal: number; jaladosEnVerano?: number; conVeranos?: boolean }
  | { tipo: 'LIMITE'; horas: number; creditos?: number | null; estricto?: boolean }
  | { tipo: 'CICLOS_AGREGADOS'; ciclos: number[] }
  | { tipo: 'VERANOS_USADOS'; periodos: string[] }
  | { tipo: 'PRIORIDAD_OBLIGATORIOS' }
  | { tipo: 'APROBADOS_SIN_CARGA' }
  | { tipo: 'REQUISITOS_EXTERNOS' }
  | { tipo: 'CICLOS_EXCLUIDOS'; ciclos: number[] }
  | { tipo: 'ELECTIVO_ELEGIDO'; curso: { nombre: string; horasSemanales: number; creditos: number } }
  | { tipo: 'ELECTIVO_CUBIERTO' }
  | { tipo: 'CONSERVADOS'; total: number }
  | { tipo: 'JALADOS_PRIMERO'; total: number; periodos: string[] }
  | { tipo: 'PENDIENTES'; total: number }
  | { tipo: 'COMPLETADOS' }
  | { tipo: 'ADVERTENCIAS_HORAS'; horas: number };

export type AlcancePlanificacion = 'proximoPeriodo' | 'hastaEgresar';

/** Límites con los que se armó la propuesta (horas efectivas: en verano, horas × factor de verano). */
export interface LimitesPlanificacion {
  horas: number;
  horasVerano: number;
  creditos: number | null;
  creditosVerano: number;
  /** "Menos de N": ningún periodo llega a N horas (o créditos); si no, N está permitido. */
  horasEstricto: boolean;
  creditosEstricto: boolean;
}

export interface CursoPropuesto {
  codigo: string;
  nombre: string;
  creditos: number;
  horas: number;
  jalado: boolean;
  /** Ya estaba en ese periodo (conservado o bloque cerrado); false si lo ubicó el planificador. */
  conservado: boolean;
}

/** Costos de un periodo de la propuesta; los agrega el caso de uso con el tarifario (null sin tarifario). */
export interface CostosPeriodoPropuesto {
  matricula: number;
  numeroCuotas: number;
  /** Cuota mensual por método de pago (en verano solo "sin_descuento": no hay pronto pago). */
  cuotas: { metodo: string; nombre: string; cuotaMensual: number }[];
  /** Pago único: la pensión del ciclo con descuento, toda al inicio. null en verano. */
  pagoUnico: { descuentoPorcentaje: number; pensionAlInicio: number; totalCiclo: number } | null;
}

/** Cada periodo futuro con carga después de aplicar la propuesta, en orden. */
export interface PeriodoPropuesto {
  periodo: PeriodoAcademico;
  cursos: CursoPropuesto[];
  horas: number;
  creditos: number;
  costos?: CostosPeriodoPropuesto | null;
}

export interface ResultadoPlanificacionAutomatica {
  cursos: Curso[];
  cicloInicio: number;
  cicloFinal: number;
  periodoInicio: PeriodoAcademico;
  limiteHoras: number;
  totalPlanificados: number;
  totalConservados: number;
  ciclos: CicloPlanificadoResumen[];
  noPlanificados: CursoNoPlanificado[];
  explicacion: ExplicacionPlan[];
  advertenciasHoras: { periodo: PeriodoAcademico; total: number; limite: number }[];
  alcance: AlcancePlanificacion;
  limites: LimitesPlanificacion;
  periodos: PeriodoPropuesto[];
  /** Ciclos regulares después del último ciclo de la malla que hacen falta (11, 12…). */
  ciclosAgregados: number[];
  /** Veranos donde el planificador ubicó cursos (sin contar los jalados). */
  veranosUsados: PeriodoAcademico['id'][];
  /** Último periodo con carga pendiente o en curso; null si no queda nada por llevar. */
  periodoEgreso: PeriodoAcademico | null;
  cicloEgreso: number | null;
  /** La misma malla con los límites por defecto (22 h, sin veranos); null en alcance "proximoPeriodo". */
  comparacionSinLimites: { cicloEgreso: number | null; periodoEgreso: PeriodoAcademico | null; ciclosExtra: number } | null;
}

export interface OpcionesPlanificacion {
  totalCiclos?: number;
  ciclosExcluidos?: number[];
  cicloActual?: number | null;
  periodoIngreso?: PeriodoIngreso | null;
  jaladoPermiteVerano?: boolean;
  /** Horas efectivas por periodo regular; por defecto horasMaximasPlanificacion (22). */
  maxHorasPorPeriodo?: number | null;
  /** Horas efectivas por verano (horas × factor); por defecto, las mismas que maxHorasPorPeriodo. */
  maxHorasVerano?: number | null;
  maxCreditosPorPeriodo?: number | null;
  /** "Menos de N" (D-053): el límite de horas o de créditos no se alcanza. */
  horasEstricto?: boolean;
  creditosEstricto?: boolean;
  /** Permite ubicar cursos en los veranos del calendario, solo si hacen falta para egresar antes. */
  usarVeranos?: boolean;
  /** "hastaEgresar" (por defecto) o solo el próximo ciclo regular. */
  alcance?: AlcancePlanificacion;
  /** Conserva los pendientes que el alumno ya ubicó en periodos futuros (por defecto true). */
  conservarUbicados?: boolean;
  /** Meta de egreso (egresar a más tardar en ese ciclo): con usarVeranos, se habilitan veranos también para lograrla. */
  cicloMeta?: number | null;
}
