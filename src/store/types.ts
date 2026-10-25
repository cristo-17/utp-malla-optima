import type { Curso, CursoReferencia, NotificacionMovimiento, PeriodoAcademico, PeriodoIngreso } from '../types/academic';
import type { Tarifario } from '../types/financial';
import type { ResultadoPlanificacionAutomatica } from '../domain/services/automaticPlanningService';
import type { GenerateOptimalPlanInput, PropuestaPlan } from '../application/usecases/generateOptimalPlanUseCase';
import type { StateCreator } from 'zustand';

/** Límites que el alumno elige en Autogenerar (o que detecta el asistente); todos opcionales. */
export type OpcionesAutogenerar = Pick<GenerateOptimalPlanInput,
  'alcance' | 'maxHorasPorPeriodo' | 'maxCreditosPorPeriodo' | 'maxCuotaMensual' | 'usarVeranos' | 'conservarUbicados'>;

/** Modal Autogenerar abierto, con los valores con los que se abre. */
export interface EstadoAutogenerar {
  inicial: OpcionesAutogenerar;
}

export interface AcademicStore {
  cursos: Curso[];
  tarifario: Tarifario | null;
  /** Método de pago de la simulación de cuotas (clave de tarifario.metodosPago). */
  metodoPago: string;
  /** Periodos regulares con pago único activo en la simulación. */
  pagoUnicoPorPeriodo: Record<string, boolean>;
  disciplinaActiva: string;
  cursosSeleccionadosParaMatricula: string[];
  panelPlanificadorAbierto: boolean;
  cursoAMover: string | null;
  notificacionMovimiento: NotificacionMovimiento | null;
  nombreArchivoCargado: string | null;
  periodoIngreso: PeriodoIngreso | null;
  cicloActual: number | null;
  totalCiclos: number;
  ciclosExcluidos: number[];
  perfilCargado: boolean;
  setTotalCiclos: (total: number) => Promise<void>;
  agregarCiclo: () => Promise<void>;
  eliminarCiclo: (ciclo: number) => Promise<boolean>;
  setContextoAcademico: (ingreso: PeriodoIngreso, ciclo: number) => Promise<void>;
  setCursos: (cursos: Curso[], nombreArchivo?: string) => Promise<void>;
  /** Marca un curso EN_CURSO como jalado y devuelve los planificados que quedaron inválidos. */
  marcarComoJalado: (codigo: string) => Promise<CursoReferencia[] | null>;
  /** Deshace marcarComoJalado: el curso vuelve a EN_CURSO, bloqueado en el ciclo actual. */
  desmarcarJalado: (codigo: string) => Promise<boolean>;
  moverCursoAPeriodo: (codigo: string, periodo: PeriodoAcademico) => Promise<boolean>;
  moverCursoACiclo: (codigo: string, nuevoCiclo: number) => Promise<boolean>;
  moverCursoAVerano: (codigo: string, despuesDelCiclo: number) => Promise<boolean>;
  moverCursoABanco: (codigo: string) => Promise<boolean>;
  /** Mueve a `destino` (o al ciclo regular de su ventana) los jalados que aún no están en su ventana. */
  agregarJaladosARecuperacion: (destino?: PeriodoAcademico) => Promise<boolean>;
  reiniciarPlanificacion: () => Promise<void>;
  generarPlanificacionOptima: () => Promise<ResultadoPlanificacionAutomatica>;
  /** La propuesta del planificador con el estado actual y los límites dados (nada cambia en la malla). */
  previsualizarPlanificacionOptima: (opciones?: OpcionesAutogenerar) => PropuestaPlan;
  /** Aplica la propuesta y guarda el estado anterior para deshacerPlanificacion. */
  aplicarPlanificacionOptima: (resultado: ResultadoPlanificacionAutomatica) => Promise<void>;
  /** Malla y total de ciclos antes del último "Aplicar a mi malla"; null si no hay nada que deshacer. */
  planAnterior: { cursos: Curso[]; totalCiclos: number } | null;
  /** Restaura exactamente el estado anterior al último plan aplicado. */
  deshacerPlanificacion: () => Promise<boolean>;
  autogenerar: EstadoAutogenerar | null;
  abrirAutogenerar: (inicial?: OpcionesAutogenerar) => void;
  cerrarAutogenerar: () => void;
  toggleSeleccionMatricula: (codigo: string) => void;
  setTarifario: (tarifario: Tarifario) => Promise<void>;
  setMetodoPago: (metodoPago: string) => void;
  setPagoUnico: (periodoId: string, activo: boolean) => void;
  setDisciplinaActiva: (disciplina: string) => Promise<void>;
  setPanelPlanificadorAbierto: (abierto: boolean) => void;
  setCursoAMover: (codigo: string | null) => void;
  limpiarNotificacionMovimiento: () => void;
  cargarDesdeDB: () => Promise<void>;
  importarRespaldo: (cursos: Curso[], tarifario: Tarifario | null) => Promise<void>;
}

export type AcademicSlice<T> = StateCreator<AcademicStore, [], [], T>;
