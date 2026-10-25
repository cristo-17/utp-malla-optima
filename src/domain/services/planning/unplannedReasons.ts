import type { Curso, PeriodoAcademico } from '../../../types/academic';
import { LIMITE_HORAS_PLANIFICACION } from '../../rules/planningRules';
import { tieneDependenciaCircular } from './circularDependency';
import { requisitoCumplidoAntesDe } from './prerequisiteChecks';
import type { MotivoNoPlanificado } from './types';

export const horasValidas = (curso: Curso) =>
  Number.isFinite(curso.horasSemanales) && curso.horasSemanales > 0;

export const motivosNoPlanificado = (
  curso: Curso, porCodigo: Map<string, Curso>, asignaciones: Map<string, PeriodoAcademico>,
  ultimoPeriodo: PeriodoAcademico | undefined, cicloFinal: number,
  limiteHoras = LIMITE_HORAS_PLANIFICACION, limiteCreditos: number | null = null
): MotivoNoPlanificado[] => {
  const motivos: MotivoNoPlanificado[] = [];
  if (!horasValidas(curso)) motivos.push({ tipo: 'HORAS_INVALIDAS' });
  if (!ultimoPeriodo) motivos.push({ tipo: 'SIN_CICLOS_FUTUROS' });
  if (tieneDependenciaCircular(curso.codigo, porCodigo)) motivos.push({ tipo: 'DEPENDENCIA_CIRCULAR' });
  for (const codigo of curso.prerrequisitos) {
    const requisito = porCodigo.get(codigo);
    if (requisito && ultimoPeriodo && !requisitoCumplidoAntesDe(requisito, ultimoPeriodo, asignaciones)) {
      const periodo = asignaciones.get(codigo);
      const referencia = { codigo, nombre: requisito.nombre };
      motivos.push(periodo
        ? { tipo: 'REQUISITO_SIN_ESPACIO', requisito: referencia, periodo }
        : { tipo: 'REQUISITO_NO_PROGRAMADO', requisito: referencia });
    }
  }
  if (!motivos.length) motivos.push({ tipo: 'SIN_ESPACIO', cicloFinal, limiteHoras, limiteCreditos });
  return motivos;
};
