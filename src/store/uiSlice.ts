import type { AcademicSlice, AcademicStore } from './types';

type UiSlice = Pick<AcademicStore,
  'panelPlanificadorAbierto' | 'cursoAMover' | 'notificacionMovimiento' |
  'setPanelPlanificadorAbierto' | 'setCursoAMover' | 'limpiarNotificacionMovimiento' |
  'autogenerar' | 'abrirAutogenerar' | 'cerrarAutogenerar' | 'avisoPlanDesdeChat' | 'setAvisoPlanDesdeChat' |
  'analisisPedido' | 'pedirAnalisisIA' | 'atenderAnalisisIA'>;

export const createUiSlice: AcademicSlice<UiSlice> = (set) => ({
  panelPlanificadorAbierto: false,
  cursoAMover: null,
  notificacionMovimiento: null,
  setPanelPlanificadorAbierto: (panelPlanificadorAbierto) => set({ panelPlanificadorAbierto }),
  setCursoAMover: (cursoAMover) => set({ cursoAMover }),
  limpiarNotificacionMovimiento: () => set({ notificacionMovimiento: null }),
  autogenerar: null,
  abrirAutogenerar: (inicial = {}, origen) => set({ autogenerar: { inicial, ...(origen ? { origen } : {}) } }),
  cerrarAutogenerar: () => set({ autogenerar: null }),
  avisoPlanDesdeChat: null,
  setAvisoPlanDesdeChat: (avisoPlanDesdeChat) => set({ avisoPlanDesdeChat }),
  analisisPedido: false,
  pedirAnalisisIA: () => set({ analisisPedido: true, notificacionMovimiento: null }),
  atenderAnalisisIA: () => set({ analisisPedido: false }),
});
