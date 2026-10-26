import type { Curso, PeriodoAcademico, PeriodoIngreso } from '../../types/academic';
import { crearPeriodoRegular, obtenerPeriodoCurso } from '../rules/academicPeriodRules';
import { permiteVeranoDespuesDe, periodoBloqueadoPorCicloActual } from '../rules/academicContextRules';
import { esJaladoSinReplanificar } from '../rules/courseRules';

export interface OpcionesConservacion {
  /** También conserva los pendientes ubicados en ciclos regulares futuros (y su secuencia). */
  regulares?: boolean;
  /** Conserva los pendientes ubicados en veranos (por defecto true). */
  veranos?: boolean;
  /** Periodo cuyos cursos no se conservan (se vuelven a planificar). */
  excepto?: PeriodoAcademico['id'];
}

/** Conserva veranos manuales válidos y la secuencia que los hace posibles; con `regulares`, también los ciclos futuros. */
export const obtenerAsignacionesConservadas = (
  cursos: Curso[], cicloActual: number, ingreso?: PeriodoIngreso | null, opciones: OpcionesConservacion = {}
) => {
  const porCodigo = new Map(cursos.map((curso) => [curso.codigo, curso]));
  const conservados = new Set<string>();
  const asignaciones = new Map<string, PeriodoAcademico>();

  const validoAntesDe = (codigo: string, destino: PeriodoAcademico, camino = new Set<string>()): boolean => {
    const curso = porCodigo.get(codigo);
    // La validación manual admite referencias externas que no aparecen como cursos.
    if (!curso) return true;
    if (camino.has(codigo)) return false;
    if (curso.estado === 'APROBADO' || curso.estado === 'CONVALIDADO') return true;
    if (curso.ubicacion !== 'periodo' || esJaladoSinReplanificar(curso, cicloActual)) return false;
    const periodo = obtenerPeriodoCurso(curso);
    if (periodo.orden >= destino.orden) return false;
    if (curso.estado === 'EN_CURSO') return true;
    if (curso.estado !== 'PENDIENTE') return false;
    if (periodo.tipo === 'VERANO' && ingreso && !permiteVeranoDespuesDe(curso.ciclo, ingreso)) return false;
    return curso.prerrequisitos.every((requisito) =>
      validoAntesDe(requisito, periodo, new Set([...camino, codigo])));
  };

  const conservarSecuencia = (curso: Curso) => {
    if (curso.estado !== 'PENDIENTE' || conservados.has(curso.codigo)) return;
    conservados.add(curso.codigo);
    for (const codigo of curso.prerrequisitos) {
      const requisito = porCodigo.get(codigo);
      if (requisito) conservarSecuencia(requisito);
    }
  };

  // Primero se conserva la secuencia completa de cada verano válido.
  for (const curso of (opciones.veranos ?? true) ? cursos : []) {
    if (curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' && curso.tipoPeriodo === 'VERANO' &&
        validoAntesDe(curso.codigo, crearPeriodoRegular(curso.ciclo + 1))) conservarSecuencia(curso);
  }
  for (const curso of opciones.regulares ? cursos : []) {
    if (curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' && curso.tipoPeriodo === 'REGULAR' &&
        obtenerPeriodoCurso(curso).id !== opciones.excepto &&
        validoAntesDe(curso.codigo, crearPeriodoRegular(curso.ciclo + 1))) conservarSecuencia(curso);
  }
  for (const curso of cursos) {
    // Un jalado en su ciclo original no es un bloque cerrado: se vuelve a planificar.
    if (curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' && cicloActual > 0 &&
        !esJaladoSinReplanificar(curso, cicloActual) &&
        periodoBloqueadoPorCicloActual(obtenerPeriodoCurso(curso), cicloActual)) conservados.add(curso.codigo);
  }
  for (const curso of cursos) {
    if (conservados.has(curso.codigo) && validoAntesDe(curso.codigo, crearPeriodoRegular(curso.ciclo + 1))) {
      asignaciones.set(curso.codigo, obtenerPeriodoCurso(curso));
    }
  }
  return { conservados, asignaciones };
};
