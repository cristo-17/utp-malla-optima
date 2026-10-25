import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Sparkles, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAcademicStore } from '../store/useAcademicStore';
import type { OpcionesAutogenerar } from '../store/types';
import type { AlternativaPlan, PropuestaPlan } from '../application/usecases/generateOptimalPlanUseCase';
import { nombrePeriodoCorto } from '../domain/rules/jaladoRules';
import { explicarMotivo } from '../presentation/messages/planningMessages';
import {
  avisoDePropuesta, avisosPropuesta, cuotaDelPeriodo, periodosVistaPrevia, resumenEgreso, textoAlternativa,
} from '../presentation/messages/autogenerarMessages';
import { formatCredits } from '../utils/formatCredits';
import { pluralizar } from '../utils/pluralizar';

const ENFOCABLES = 'button:not([disabled]), input:not([disabled])';

/** "" o un número no negativo; lo demás no limita. */
const aNumero = (texto: string): number | null => {
  if (!texto.trim()) return null;
  const valor = Number(texto.replace(',', '.'));
  return Number.isFinite(valor) && valor >= 0 ? valor : null;
};
const aTexto = (valor: number | null | undefined) => typeof valor === 'number' ? String(valor) : '';

/**
 * Autogenerar: el alumno elige sus límites, ve la propuesta del planificador por periodo y la aplica con un botón
 * (con Deshacer en el toast). Nada cambia en la malla hasta "Aplicar a mi malla" (D-001: la IA nunca la modifica).
 */
type StoreModal = ReturnType<typeof useStoreModal>;
const useStoreModal = () => useAcademicStore(useShallow((state) => ({
  autogenerar: state.autogenerar, cerrarAutogenerar: state.cerrarAutogenerar, setAvisoPlanDesdeChat: state.setAvisoPlanDesdeChat,
  presupuestoMensual: state.presupuestoMensual, setPresupuestoMensual: state.setPresupuestoMensual,
  previsualizar: state.previsualizarPlanificacionOptima, aplicar: state.aplicarPlanificacionOptima,
  cursos: state.cursos, totalCiclos: state.totalCiclos, ciclosExcluidos: state.ciclosExcluidos,
  cicloActual: state.cicloActual, periodoIngreso: state.periodoIngreso, tarifario: state.tarifario,
  disciplinaActiva: state.disciplinaActiva, metodoPago: state.metodoPago, pagoUnico: state.pagoUnicoPorPeriodo,
  setMetodoPago: state.setMetodoPago,
})));

export function AutogenerarModal() {
  const store = useStoreModal();
  if (!store.autogenerar) return null;
  return <Contenido key={JSON.stringify(store.autogenerar)} inicial={store.autogenerar.inicial} origen={store.autogenerar.origen} store={store} />;
}

function Contenido({ inicial, origen, store }: { inicial: OpcionesAutogenerar; origen?: 'chat'; store: StoreModal }) {
  const [alcance, setAlcance] = useState(inicial.alcance ?? 'hastaEgresar');
  const [horas, setHoras] = useState(aTexto(inicial.maxHorasPorPeriodo));
  const [creditos, setCreditos] = useState(aTexto(inicial.maxCreditosPorPeriodo));
  // Sin un monto propio (el de una propuesta del chat), parte del presupuesto que el alumno ya escribió.
  const [cuota, setCuota] = useState(inicial.maxCuotaMensual === undefined ? store.presupuestoMensual : aTexto(inicial.maxCuotaMensual));
  const [usarVeranos, setUsarVeranos] = useState(inicial.usarVeranos ?? false);
  const [conservar, setConservar] = useState(inicial.conservarUbicados ?? true);
  // Una alternativa con otro método de pago lo cambia solo en esta vista previa; al aplicar, pasa a Estrategia.
  const [metodoElegido, setMetodoElegido] = useState<string | null>(inicial.metodoPago ?? null);
  const [error, setError] = useState('');
  const [aplicando, setAplicando] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const cerrarRef = useRef<HTMLButtonElement>(null);
  const { cursos, totalCiclos, ciclosExcluidos, cicloActual, periodoIngreso, tarifario, disciplinaActiva, previsualizar } = store;
  const metodoPago = metodoElegido ?? store.metodoPago;

  useLayoutEffect(() => {
    const focoAnterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cerrarRef.current?.focus();
    return () => {
      document.body.style.overflow = overflowAnterior;
      if (focoAnterior?.isConnected) focoAnterior.focus({ preventScroll: true });
    };
  }, []);

  const opciones: OpcionesAutogenerar = useMemo(() => ({
    alcance, maxHorasPorPeriodo: aNumero(horas), maxCreditosPorPeriodo: aNumero(creditos),
    maxCuotaMensual: aNumero(cuota), usarVeranos, conservarUbicados: conservar, metodoPago,
  }), [alcance, horas, creditos, cuota, usarVeranos, conservar, metodoPago]);
  const propuesta = useMemo((): PropuestaPlan | null => {
    try {
      return previsualizar(opciones);
    } catch {
      return null;
    }
    // La vista previa se recalcula si cambia la malla o la configuración que lee el planificador del store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opciones, previsualizar, cursos, totalCiclos, ciclosExcluidos, cicloActual, periodoIngreso, tarifario, disciplinaActiva, metodoPago]);

  const nombreMetodo = tarifario?.metodosPago?.[metodoPago]?.nombre;
  const avisos = propuesta ? avisosPropuesta(propuesta, { usarVeranos, tieneIngreso: Boolean(periodoIngreso), nombreMetodo }) : [];
  const periodos = propuesta ? periodosVistaPrevia(propuesta) : [];
  const alternativas = propuesta ? propuesta.alternativas.map((alternativa) => ({ alternativa, ...textoAlternativa(alternativa, propuesta) })) : [];
  /** "Usar esta": la vista previa pasa a la alternativa (otro método, veranos o más horas). */
  const usarAlternativa = ({ opciones: cambios }: AlternativaPlan) => {
    if (cambios.metodoPago) setMetodoElegido(cambios.metodoPago);
    if (cambios.usarVeranos !== undefined) setUsarVeranos(cambios.usarVeranos);
    if (cambios.maxHorasPorPeriodo !== undefined) setHoras(String(cambios.maxHorasPorPeriodo));
  };
  const proximo = `Ciclo ${(cicloActual ?? 0) + 1}`;

  const cerrar = () => store.cerrarAutogenerar();
  const aplicar = async () => {
    if (!propuesta) return;
    setAplicando(true);
    setError('');
    try {
      await store.aplicar(propuesta);
      if (metodoElegido && metodoElegido !== store.metodoPago) store.setMetodoPago(metodoElegido);
      // Desde el chat, la app (no la IA) cuenta qué quedó en el próximo ciclo.
      const aviso = avisoDePropuesta(propuesta);
      if (origen === 'chat' && aviso) store.setAvisoPlanDesdeChat(aviso);
      cerrar();
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : 'No se pudo aplicar la propuesta.');
      setAplicando(false);
    }
  };

  return <>
    <div className="autogen-backdrop" role="presentation" onMouseDown={cerrar} />
    <section ref={modalRef} className="autogen-modal" role="dialog" aria-modal="true" aria-labelledby="autogen-titulo"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cerrar(); }
        if (event.key !== 'Tab') return;
        const enfocables = modalRef.current?.querySelectorAll<HTMLElement>(ENFOCABLES);
        const primero = enfocables?.[0];
        const ultimo = enfocables?.[enfocables.length - 1];
        if ((event.shiftKey && document.activeElement === primero) || (!event.shiftKey && document.activeElement === ultimo)) {
          event.preventDefault();
          (event.shiftKey ? ultimo : primero)?.focus();
        }
      }}>
      <header className="autogen-head">
        <div><span><Sparkles size={16} aria-hidden="true" /> Autogenerar</span><h2 id="autogen-titulo">Arma tu plan con tus límites</h2></div>
        <button ref={cerrarRef} type="button" className="autogen-close" onClick={cerrar} aria-label="Cerrar Autogenerar"><X size={20} /></button>
      </header>
      <div className="autogen-body">
        <fieldset className="autogen-alcance">
          <legend>Alcance</legend>
          <label><input type="radio" name="autogen-alcance" checked={alcance === 'proximoPeriodo'} onChange={() => setAlcance('proximoPeriodo')} /> Próximo ciclo ({proximo})</label>
          <label><input type="radio" name="autogen-alcance" checked={alcance === 'hastaEgresar'} onChange={() => setAlcance('hastaEgresar')} /> Hasta egresar</label>
        </fieldset>
        <div className="autogen-campos">
          <label htmlFor="autogen-horas">Máximo de horas por ciclo
            <input id="autogen-horas" type="number" inputMode="numeric" min="0" step="1" placeholder="22 (opcional)" value={horas} onChange={(event) => setHoras(event.target.value)} /></label>
          <label htmlFor="autogen-creditos">Máximo de créditos
            <input id="autogen-creditos" type="number" inputMode="numeric" min="0" step="1" placeholder="Opcional" value={creditos} onChange={(event) => setCreditos(event.target.value)} /></label>
          <label htmlFor="autogen-cuota">Presupuesto mensual (S/)
            <input id="autogen-cuota" type="number" inputMode="decimal" min="0" step="10" placeholder="Opcional" value={cuota}
              onChange={(event) => { setCuota(event.target.value); store.setPresupuestoMensual(event.target.value); }} /></label>
        </div>
        <div className="autogen-checks">
          <label><input type="checkbox" checked={usarVeranos} onChange={(event) => setUsarVeranos(event.target.checked)} /> Usar veranos</label>
          <label><input type="checkbox" checked={conservar} onChange={(event) => setConservar(event.target.checked)} /> Conservar lo que ya ubiqué</label>
        </div>

        <section className="autogen-preview" aria-labelledby="autogen-preview-titulo" aria-live="polite">
          <h3 id="autogen-preview-titulo">Vista previa</h3>
          <p className="autogen-nota">Nada cambia en tu malla hasta que toques «Aplicar a mi malla».</p>
          {!propuesta && <p className="autogen-error" role="alert">No se pudo generar la propuesta.</p>}
          {avisos.length > 0 && <ul className="autogen-avisos">{avisos.map((aviso) => <li key={aviso}><AlertTriangle size={15} aria-hidden="true" /> {aviso}</li>)}</ul>}
          {propuesta && propuesta.costoTotalHastaEgresar !== null && <p className="autogen-total">
            {resumenEgreso(propuesta)}{metodoElegido ? ` · ${tarifario?.metodosPago?.[metodoElegido]?.nombre ?? metodoElegido}` : ''}</p>}
          {alternativas.length > 0 && <section className="autogen-alternativas" aria-label="Alternativas">
            <h4>Otras opciones que te convienen</h4>
            <ul>{alternativas.map(({ alternativa, titulo, detalle }) => <li key={titulo}>
              <div><b>{titulo}</b><span>{detalle}</span></div>
              <button type="button" className="autogen-usar" onClick={() => usarAlternativa(alternativa)}>Usar esta</button>
            </li>)}</ul>
          </section>}
          {propuesta && periodos.length === 0 && <p className="autogen-nota">No hay cursos pendientes por ubicar.</p>}
          {periodos.map((periodo) => {
            const cuotaMes = cuotaDelPeriodo(periodo, metodoPago);
            const unico = store.pagoUnico[periodo.periodo.id] ? periodo.costos?.pagoUnico : null;
            return <article key={periodo.periodo.id} className={`autogen-periodo${periodo.periodo.tipo === 'VERANO' ? ' autogen-verano' : ''}`}>
              <h4>{nombrePeriodoCorto(periodo.periodo)}
                <span>{periodo.cursos.length} {pluralizar(periodo.cursos.length, 'curso', 'cursos')} · {periodo.horas} h · {formatCredits(periodo.creditos)} cr
                  {unico ? ` · Pago único S/ ${unico.pensionAlInicio.toFixed(2)} al inicio` : cuotaMes !== null ? ` · S/ ${cuotaMes.toFixed(2)}/mes` : ''}</span></h4>
              <ul>{periodo.cursos.map((curso) => <li key={curso.codigo}>{curso.nombre}
                {curso.jalado && <em className="autogen-tag autogen-tag-jalado">Jalado</em>}
                {curso.conservado && !curso.jalado && <em className="autogen-tag">Ya ubicado</em>}</li>)}</ul>
            </article>;
          })}
          {propuesta && propuesta.noPlanificados.length > 0 && <div className="autogen-no-entraron">
            <b>{alcance === 'proximoPeriodo'
              ? `No entraron en el ${proximo}`
              : pluralizar(propuesta.noPlanificados.length, '1 curso no entra', `${propuesta.noPlanificados.length} cursos no entran`)}</b>
            <ul>{propuesta.noPlanificados.map((curso) => <li key={curso.codigo}><strong>{curso.nombre}</strong>: {curso.motivos.map(explicarMotivo).join(' ')}</li>)}</ul>
          </div>}
        </section>
      </div>
      <footer className="autogen-footer">
        {error && <p className="autogen-error" role="alert">{error}</p>}
        <div className="autogen-acciones">
          <button type="button" className="autogen-cancelar" onClick={cerrar}>Cancelar</button>
          <button type="button" className="autogen-aplicar" onClick={() => void aplicar()}
            disabled={!propuesta || propuesta.totalPlanificados === 0 || aplicando}><Check size={16} aria-hidden="true" /> Aplicar a mi malla</button>
        </div>
      </footer>
    </section>
  </>;
}
