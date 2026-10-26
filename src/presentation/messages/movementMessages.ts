import { formatCredits } from '../../utils/formatCredits';
import type { Curso, NotificacionMovimiento, PeriodoAcademico, CursoReferencia } from '../../types/academic';
import type { moveCourseUseCase } from '../../application/usecases/moveCourseUseCase';
import { mensajeRecargoHoras } from '../../domain/rules/planningRules';
import { pluralizar } from '../../utils/pluralizar';

export const notificacionDesdeResultado = (
  curso: Curso,
  periodo: PeriodoAcademico,
  resultado: ReturnType<typeof moveCourseUseCase>
): NotificacionMovimiento | null => {
  if (resultado.ok) {
    const { warning, surcharge } = resultado;
    if (!warning && !surcharge) return null;
    const recargo = surcharge ? `${mensajeRecargoHoras(surcharge.limite)}.` : '';
    return {
      tipo: 'LIMITE_HORAS', cursoNombre: curso.nombre, periodoDestino: periodo.etiqueta,
      limite: warning?.limite ?? surcharge?.limite, valorActual: warning?.total ?? surcharge?.total,
      mensaje: warning
        ? [`El curso se asignó a ${periodo.etiqueta}. La carga es de ${warning.total} horas efectivas y supera las ${warning.limite} horas recomendadas.`, recargo].filter(Boolean).join(' ')
        : `El curso se asignó a ${periodo.etiqueta} con ${surcharge!.total} horas efectivas. ${recargo}`,
    };
  }

  switch (resultado.reason) {
    case 'LOCKED':
      return { tipo: 'INMOVIBLE', cursoNombre: curso.nombre };
    case 'SOURCE_PERIOD_LOCKED':
      return { tipo: 'INMOVIBLE', cursoNombre: curso.nombre, mensaje: 'El ciclo actual y los anteriores no permiten quitar ni mover cursos.' };
    case 'SUMMER_NOT_AVAILABLE':
      return { tipo: 'PERIODO_ANTERIOR', cursoNombre: curso.nombre, mensaje: 'Ese verano no corresponde al mes de inicio de carrera seleccionado.' };
    case 'REMOVED_CYCLE':
      return { tipo: 'PERIODO_ANTERIOR', cursoNombre: curso.nombre, mensaje: 'Ese ciclo fue retirado. Vuelve a añadirlo para asignarle cursos.' };
    case 'PAST_PERIOD':
      return { tipo: 'PERIODO_ANTERIOR', cursoNombre: curso.nombre, periodoDestino: periodo.etiqueta,
        mensaje: `No se puede planificar en ${periodo.etiqueta} porque es anterior al periodo académico actual.` };
    case 'CURRENT_PERIOD':
      return { tipo: 'PERIODO_ACTUAL', cursoNombre: curso.nombre, periodoDestino: periodo.etiqueta,
        mensaje: `No se pueden agregar cursos a ${periodo.etiqueta} porque ese es el periodo que ya estás cursando. Puedes planificarlos desde el verano posterior.` };
    case 'JALADO_DESTINO':
    case 'JALADOS_PENDIENTES':
      return { tipo: 'JALADO_OBLIGATORIO', cursoNombre: curso.nombre, periodoDestino: periodo.etiqueta,
        faltantes: 'faltantes' in resultado ? resultado.faltantes : undefined,
        mensaje: 'mensaje' in resultado ? resultado.mensaje : undefined };
    case 'PREREQUISITES':
      return { tipo: 'PRERREQUISITOS', cursoNombre: curso.nombre, faltantes: resultado.faltantes, periodoDestino: periodo.etiqueta };
    case 'SUMMER_CREDIT_LIMIT':
      return { tipo: 'LIMITE_CREDITOS_VERANO', cursoNombre: curso.nombre, periodoDestino: periodo.etiqueta,
        limite: resultado.limite, valorActual: resultado.total,
        mensaje: resultado.limite !== undefined && resultado.total !== undefined
          ? `El verano admite como máximo ${formatCredits(resultado.limite)} créditos. Con este curso se alcanzarían ${formatCredits(resultado.total)}.`
          : 'El curso supera el límite de créditos de verano.' };
    default:
      return null;
  }
};

export const notificacionPorConflictos = (
  cursoNombre: string, faltantes: CursoReferencia[], contexto: 'mover' | 'retirar' | 'ciclo',
  avisoHoras?: NotificacionMovimiento | null
): NotificacionMovimiento | null => {
  if (!faltantes.length) return avisoHoras ?? null;
  const mensajes = {
    mover: 'Este cambio deja cursos posteriores con prerrequisitos fuera de secuencia.',
    retirar: 'Al retirar este curso, algunos cursos posteriores quedan sin su prerrequisito previo.',
    ciclo: 'Los cursos del ciclo retirado volvieron al banco. Algunos cursos posteriores necesitan que programes de nuevo sus prerrequisitos.',
  };
  return {
    tipo: 'IMPACTO_DESCENDIENTE', cursoNombre, faltantes,
    mensaje: [mensajes[contexto], avisoHoras?.mensaje].filter(Boolean).join(' '),
  };
};

export const notificacionJalado = (
  curso: CursoReferencia, invalidos: CursoReferencia[], ventana: string
): NotificacionMovimiento => {
  const recuperacion = ventana ? ` Deberás llevarlo ${ventana}.` : '';
  return {
    tipo: 'JALADO', cursoNombre: curso.nombre, faltantes: invalidos, deshacerJalado: curso.codigo,
    mensaje: invalidos.length
      ? `quedó como jalado.${recuperacion} ${pluralizar(invalidos.length,
        'Este curso planificado ya no cumple sus prerrequisitos:',
        `Estos ${invalidos.length} cursos planificados ya no cumplen sus prerrequisitos:`)}`
      : `quedó como jalado.${recuperacion}`,
  };
};

export const notificacionJaladoRetirado = (
  cursoNombre: string, afectados: CursoReferencia[], ventana: string
): NotificacionMovimiento | null => afectados.length ? {
  tipo: 'IMPACTO_DESCENDIENTE', cursoNombre, faltantes: afectados,
  mensaje: `volvió a su ciclo original. ${pluralizar(afectados.length, 'Este curso queda marcado',
    `Estos ${afectados.length} cursos quedan marcados`)} (falta llevar curso jalado) hasta que lo lleves ${ventana || 'en su periodo de recuperación'}:`,
} : null;

/** Toast después de "Aplicar a mi malla", con Deshacer. */
export const notificacionPlanAplicado = (
  advertencias: { periodo: PeriodoAcademico; total: number; limite: number }[],
  totalPlanificados = 0,
  analizarConAsistente = false,
): NotificacionMovimiento => ({
  tipo: 'PLAN_APLICADO', cursoNombre: 'Planificación automática', deshacerPlan: true,
  ...(analizarConAsistente ? { analizarConAsistente } : {}),
  mensaje: [
    `Se aplicó la propuesta: ${pluralizar(totalPlanificados, '1 curso ubicado', `${totalPlanificados} cursos ubicados`)}.`,
    ...(advertencias.length ? [`Carga recomendada superada: ${advertencias.map((aviso) => `${aviso.periodo.etiqueta}: ${aviso.total} h (recomendadas: ${aviso.limite} h)`).join('; ')}.`] : []),
  ].join(' '),
});

export const notificacionPeriodoBloqueado = (cursoNombre: string): NotificacionMovimiento => ({
  tipo: 'INMOVIBLE', cursoNombre,
  mensaje: 'El ciclo actual y los anteriores no permiten quitar ni mover cursos.',
});

export const notificacionErrorPersistencia = (cursoNombre: string): NotificacionMovimiento => ({
  tipo: 'ERROR_PERSISTENCIA', cursoNombre,
  mensaje: 'El cambio no se guardó. Inténtalo de nuevo; la planificación anterior sigue disponible.',
});
