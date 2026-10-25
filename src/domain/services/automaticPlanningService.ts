import { obtenerPeriodoCurso } from '../rules/academicPeriodRules';
import { calcularHorasEfectivas } from '../rules/planningRules';
import { horasValidas } from './planning/unplannedReasons';
import type { ResultadoPlanificacionAutomatica } from './planning/types';

export { generarPlanificacionAutomatica } from './planning/planBuilder';
export type {
  AlcancePlanificacion, CicloPlanificadoResumen, CostosPeriodoPropuesto, CursoNoPlanificado, CursoPlanificadoResumen,
  CursoPropuesto, ExplicacionPlan, LimitesPlanificacion, MotivoNoPlanificado, OpcionesPlanificacion, PeriodoPropuesto,
  ResultadoPlanificacionAutomatica,
} from './planning/types';

/** Verifica la carga real de los ciclos modificados antes de guardar la propuesta. */
export const validarCargaPlanificacionAutomatica = (resultado: ResultadoPlanificacionAutomatica): void => {
  for (const ciclo of resultado.ciclos) {
    const carga = resultado.cursos.filter((curso) => curso.ubicacion === 'periodo' &&
      (curso.estado === 'PENDIENTE' || curso.estado === 'EN_CURSO') && obtenerPeriodoCurso(curso).id === ciclo.periodo.id);
    const { limites } = resultado;
    const verano = ciclo.periodo.tipo === 'VERANO';
    const creditos = carga.reduce((suma, curso) => suma + curso.creditos, 0);
    const horas = verano ? limites.horasVerano : limites.horas;
    const excede = calcularHorasEfectivas(carga, ciclo.periodo.tipo) > horas ||
      creditos > (verano ? limites.creditosVerano : limites.creditos ?? Infinity);
    if (carga.some((curso) => !horasValidas(curso)) || excede) {
      throw new Error(`La propuesta supera los límites (${horas} horas${limites.creditos !== null || verano ? ` o ${verano ? limites.creditosVerano : limites.creditos} créditos` : ''}) o contiene una carga inválida en ${ciclo.periodo.etiqueta}. Genera una propuesta nueva.`);
    }
  }
};
