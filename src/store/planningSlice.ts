import type { AcademicRepositories } from '../application/ports/AcademicRepositories';
import { generateOptimalPlanUseCase } from '../application/usecases/generateOptimalPlanUseCase';
import { CICLOS_INICIALES, determinarTotalCiclos } from '../domain/rules/cycleRules';
import { ordenarCursos } from '../domain/rules/courseRules';
import { validarCargaPlanificacionAutomatica } from '../domain/services/automaticPlanningService';
import { notificacionErrorPersistencia, notificacionPlanAplicado } from '../presentation/messages/movementMessages';
import type { AcademicSlice, AcademicStore } from './types';

type PlanningSlice = Pick<AcademicStore,
  'cursosSeleccionadosParaMatricula' | 'previsualizarPlanificacionOptima' |
  'aplicarPlanificacionOptima' | 'generarPlanificacionOptima' | 'toggleSeleccionMatricula' |
  'planAnterior' | 'deshacerPlanificacion'>;

export const createPlanningSlice = (repos: AcademicRepositories): AcademicSlice<PlanningSlice> => (set, get) => ({
  cursosSeleccionadosParaMatricula: [],

  planAnterior: null,

  previsualizarPlanificacionOptima: (opciones = {}) => {
    const { cursos, totalCiclos, ciclosExcluidos, cicloActual, periodoIngreso, tarifario, disciplinaActiva, metodoPago } = get();
    return generateOptimalPlanUseCase({
      cursos, totalCiclos, ciclosExcluidos, cicloActual, periodoIngreso,
      tarifario, disciplina: disciplinaActiva, metodoPago, ...opciones,
    });
  },

  aplicarPlanificacionOptima: async (resultado) => {
    const state = get();
    const actuales = state.cursos;
    if (resultado.cursos.length !== actuales.length ||
        resultado.cursos.some((curso) => !actuales.some((actual) => actual.codigo === curso.codigo))) {
      throw new Error('La malla cambió desde que se generó la propuesta. Genera una propuesta nueva.');
    }
    validarCargaPlanificacionAutomatica(resultado);
    if (resultado.cursos.some((curso) => curso.ubicacion === 'periodo' && curso.tipoPeriodo === 'REGULAR' &&
        state.ciclosExcluidos.includes(curso.ciclo))) {
      throw new Error('La propuesta utiliza un ciclo retirado. Genera una propuesta nueva.');
    }
    const cursos = ordenarCursos(resultado.cursos);
    // La malla llega hasta el último periodo con cursos: un ciclo extra (11, 12…) que queda vacío se quita.
    const totalCiclos = determinarTotalCiclos(cursos, Math.max(CICLOS_INICIALES, state.cicloActual ?? 1));
    const ciclosExcluidos = state.ciclosExcluidos.filter((ciclo) => ciclo <= totalCiclos);
    await repos.transaction(async () => {
      await repos.courses.saveMany(cursos);
      await repos.profile.save({ totalCiclos, ciclosExcluidos });
    });
    set({ cursos, totalCiclos, ciclosExcluidos, cursosSeleccionadosParaMatricula: [], cursoAMover: null,
      planAnterior: { cursos: actuales, totalCiclos: state.totalCiclos, ciclosExcluidos: state.ciclosExcluidos },
      notificacionMovimiento: notificacionPlanAplicado(resultado.advertenciasHoras, resultado.totalPlanificados) });
  },

  deshacerPlanificacion: async () => {
    const { planAnterior } = get();
    if (!planAnterior) return false;
    try {
      await repos.transaction(async () => {
        await repos.courses.saveMany(planAnterior.cursos);
        await repos.profile.save({ totalCiclos: planAnterior.totalCiclos, ciclosExcluidos: planAnterior.ciclosExcluidos });
      });
    } catch {
      set({ notificacionMovimiento: notificacionErrorPersistencia('Planificación automática') });
      return false;
    }
    set({ cursos: planAnterior.cursos, totalCiclos: planAnterior.totalCiclos, ciclosExcluidos: planAnterior.ciclosExcluidos, planAnterior: null,
      cursoAMover: null, notificacionMovimiento: null });
    return true;
  },

  generarPlanificacionOptima: async () => {
    const resultado = get().previsualizarPlanificacionOptima();
    await get().aplicarPlanificacionOptima(resultado);
    return { ...resultado, cursos: get().cursos };
  },

  toggleSeleccionMatricula: (codigo) => {
    const actual = get().cursosSeleccionadosParaMatricula;
    const existe = actual.includes(codigo);
    set({ cursosSeleccionadosParaMatricula: existe
      ? actual.filter((item) => item !== codigo) : [...actual, codigo] });
  },
});
