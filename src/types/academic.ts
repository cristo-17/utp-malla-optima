export type EstadoCurso = 'APROBADO' | 'CONVALIDADO' | 'EN_CURSO' | 'PENDIENTE';
export type PeriodoIngreso = 'marzo' | 'agosto';
export type TipoCurso = 'OBLIGATORIO' | 'ELECTIVO';
export type ModalidadCalculo = 'POR_CREDITO' | 'POR_HORA' | 'POR_CURSO' | 'ESCALA_FIJA';

export type TipoPeriodoAcademico = 'REGULAR' | 'VERANO';
export type UbicacionCurso = 'banco' | 'periodo';

export interface PeriodoAcademico {
  id: `ciclo-${number}` | `verano-${number}`;
  tipo: TipoPeriodoAcademico;
  cicloReferencia: number;
  orden: number;
  etiqueta: string;
}

export interface Curso {
  codigo: string;
  nombre: string;
  disciplina?: string;
  ciclo: number;
  cicloOrigen: number;
  tipoPeriodo: TipoPeriodoAcademico;
  ubicacion: UbicacionCurso;
  horasSemanales: number;
  creditos: number;
  tipo: TipoCurso;
  prerrequisitos: string[];
  esLaboratorio?: boolean;
  estado: EstadoCurso;
  /**
   * Curso desaprobado. Su estado es PENDIENTE: mientras siga en el ciclo donde
   * se jaló (un periodo bloqueado) no cumple prerrequisitos ni se cotiza; al
   * replanificarlo en un periodo futuro se comporta como cualquier pendiente.
   */
  jalado?: boolean;
  /** Ciclo donde se jaló. Si es mayor que el ciclo actual (adelantado), su lugar original es el banco. */
  cicloJalado?: number;
}

export interface CursoReferencia {
  codigo: string;
  nombre: string;
}

export type TipoNotificacionMovimiento =
  | 'PRERREQUISITOS'
  | 'INMOVIBLE'
  | 'PERIODO_ANTERIOR'
  | 'PERIODO_ACTUAL'
  | 'LIMITE_CREDITOS_VERANO'
  | 'LIMITE_HORAS'
  | 'IMPACTO_DESCENDIENTE'
  | 'JALADO'
  | 'JALADO_OBLIGATORIO'
  | 'DATOS_DESACTUALIZADOS'
  | 'PLAN_APLICADO'
  | 'ERROR_PERSISTENCIA';

export interface NotificacionMovimiento {
  tipo: TipoNotificacionMovimiento;
  cursoNombre: string;
  faltantes?: CursoReferencia[];
  mensaje?: string;
  periodoDestino?: string;
  limite?: number;
  valorActual?: number;
  /** Código del curso recién marcado como jalado; habilita la acción Deshacer. */
  deshacerJalado?: string;
  /** El plan recién aplicado se puede deshacer (deshacerPlanificacion). */
  deshacerPlan?: boolean;
}
