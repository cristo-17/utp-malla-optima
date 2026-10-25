import { useEffect } from 'react';
import { AlertTriangle, Clock3, Gauge, LockKeyhole, Sparkles, X } from 'lucide-react';
import { pluralizar } from '../utils/pluralizar';
import { useAcademicStore } from '../store/useAcademicStore';

export function PrerequisitoToast() {
  const { notificacionMovimiento, limpiarNotificacionMovimiento, desmarcarJalado, deshacerPlanificacion } = useAcademicStore();

  useEffect(() => {
    if (!notificacionMovimiento) return;
    // Se deja más tiempo cuando hay una acción Deshacer disponible.
    const timer = window.setTimeout(limpiarNotificacionMovimiento,
      notificacionMovimiento.deshacerJalado || notificacionMovimiento.deshacerPlan ||
        notificacionMovimiento.tipo === 'DATOS_DESACTUALIZADOS' ? 10000 : 5500);
    return () => window.clearTimeout(timer);
  }, [notificacionMovimiento, limpiarNotificacionMovimiento]);

  if (!notificacionMovimiento) return null;

  const { tipo } = notificacionMovimiento;
  const esAdvertencia = tipo === 'LIMITE_HORAS' || tipo === 'IMPACTO_DESCENDIENTE' || tipo === 'JALADO' ||
    tipo === 'DATOS_DESACTUALIZADOS' || tipo === 'PLAN_APLICADO';
  const faltantes = notificacionMovimiento.faltantes ?? [];
  const titulo =
    tipo === 'ERROR_PERSISTENCIA'
      ? 'No se pudo guardar'
      : tipo === 'PLAN_APLICADO'
      ? 'Propuesta aplicada'
      : tipo === 'INMOVIBLE'
      ? 'Curso bloqueado'
      : tipo === 'IMPACTO_DESCENDIENTE'
        ? 'Impacto en cursos posteriores'
      : tipo === 'JALADO'
        ? 'Curso marcado como jalado'
      : tipo === 'JALADO_OBLIGATORIO'
        ? pluralizar(Math.max(1, faltantes.length), 'Curso jalado obligatorio', 'Cursos jalados obligatorios')
      : tipo === 'DATOS_DESACTUALIZADOS'
        ? 'Vuelve a subir tu Excel'
      : tipo === 'PRERREQUISITOS'
        ? 'Prerrequisitos pendientes'
        : tipo === 'PERIODO_ANTERIOR' || tipo === 'PERIODO_ACTUAL'
          ? 'Periodo no disponible'
          : tipo === 'LIMITE_CREDITOS_VERANO'
            ? 'Límite de verano'
            : 'Carga horaria recomendada superada';

  const Icono =
    tipo === 'PLAN_APLICADO'
      ? Sparkles
      : tipo === 'INMOVIBLE'
      ? LockKeyhole
      : tipo === 'PERIODO_ANTERIOR' || tipo === 'PERIODO_ACTUAL'
        ? Clock3
        : tipo === 'LIMITE_CREDITOS_VERANO' || tipo === 'LIMITE_HORAS'
          ? Gauge
          : AlertTriangle;

  return (
    <div className={`planner-toast ${esAdvertencia ? 'planner-toast-warning' : ''}`} role={esAdvertencia ? 'status' : 'alert'} aria-live={esAdvertencia ? 'polite' : 'assertive'}>
      <div className="planner-toast-head">
        <Icono size={17} />
        <strong>{titulo}</strong>
        <button
          type="button"
          className="planner-toast-close"
          onClick={limpiarNotificacionMovimiento}
          aria-label="Cerrar advertencia"
        >
          <X size={16} />
        </button>
      </div>

      {tipo === 'INMOVIBLE' ? (
        <p>
          <b>{notificacionMovimiento.cursoNombre}</b>: {notificacionMovimiento.mensaje ?? 'El curso ya figura como aprobado, convalidado o en curso y no puede cambiarse de periodo.'}
        </p>
      ) : tipo === 'IMPACTO_DESCENDIENTE' ? (
        <><p><b>{notificacionMovimiento.cursoNombre}</b>: {notificacionMovimiento.mensaje}</p>
          <ul>{faltantes.map((curso) => <li key={curso.codigo}><span>{curso.codigo}</span><strong>{curso.nombre}</strong></li>)}</ul></>
      ) : tipo === 'JALADO' ? (
        <><p><b>{notificacionMovimiento.cursoNombre}</b> {notificacionMovimiento.mensaje}</p>
          {faltantes.length > 0 && <ul>{faltantes.map((curso) => <li key={curso.codigo}><span>{curso.codigo}</span><strong>{curso.nombre}</strong></li>)}</ul>}
          {notificacionMovimiento.deshacerJalado && <button type="button" className="planner-toast-undo"
            onClick={() => void desmarcarJalado(notificacionMovimiento.deshacerJalado!)}>Deshacer</button>}</>
      ) : tipo === 'PLAN_APLICADO' ? (
        <><p>{notificacionMovimiento.mensaje}</p>
          {notificacionMovimiento.deshacerPlan && <button type="button" className="planner-toast-undo"
            onClick={() => void deshacerPlanificacion()}>Deshacer</button>}</>
      ) : tipo === 'PRERREQUISITOS' ? (
        <>
          <p>
            Para mover <b>{notificacionMovimiento.cursoNombre}</b> a {notificacionMovimiento.periodoDestino ?? 'ese periodo'}, primero debes aprobar o planificar antes:
          </p>
          <ul>
            {faltantes.map((faltante) => (
              <li key={faltante.codigo}>
                <span>{faltante.codigo}</span>
                <strong>{faltante.nombre}</strong>
              </li>
            ))}
          </ul>
          <small>Los prerrequisitos deben estar en un periodo cronológicamente anterior.</small>
        </>
      ) : (
        <p>
          <b>{notificacionMovimiento.cursoNombre}</b>: {notificacionMovimiento.mensaje}
        </p>
      )}
    </div>
  );
}
