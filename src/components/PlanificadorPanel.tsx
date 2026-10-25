import { formatCredits } from '../utils/formatCredits';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ChevronDown, CreditCard, Settings2, Sparkles, TrendingUp, X } from 'lucide-react';
import { calcularRutaCritica } from '../domain/services/recommendationService';
import { useAcademicStore } from '../store/useAcademicStore';
import { useFinancialPlanning } from '../financial/FinancialPlanningContext';
import { PeriodFinancialCard } from '../financial/components/PeriodFinancialCard';
import { FinancialTotalCard } from '../financial/components/FinancialTotalCard';
import { LIMITE_HORAS_PLANIFICACION } from '../domain/rules/planningRules';

export function PlanificadorPanel() {
  const {
    cursos, tarifario, disciplinaActiva, panelPlanificadorAbierto, totalCiclos, ciclosExcluidos, cicloActual,
    setPanelPlanificadorAbierto, abrirAutogenerar, metodoPago, setMetodoPago, pagoUnicoPorPeriodo: pagoUnico, setPagoUnico,
  } = useAcademicStore();
  const financialPlanning = useFinancialPlanning();
  const [pestana, setPestana] = useState<'academico' | 'financiero'>('academico');
  const [ajustesCuotasAbiertos, setAjustesCuotasAbiertos] = useState(false);
  const [avisoPago, setAvisoPago] = useState('');
  const criticos = useMemo(() => calcularRutaCritica(cursos).slice(0, 6), [cursos]);
  const creditosPendientes = cursos.filter((curso) => curso.estado === 'PENDIENTE')
    .reduce((suma, curso) => suma + curso.creditos, 0);
  const resumen = useMemo(() => tarifario
    ? financialPlanning.calcular(cursos, tarifario, disciplinaActiva, {
        metodoPago, pagoUnicoPorPeriodo: pagoUnico, cicloActual,
      })
    : null, [cursos, tarifario, disciplinaActiva, metodoPago, pagoUnico, cicloActual, financialPlanning]);

  useLayoutEffect(() => {
    if (!avisoPago) return;
    const timer = window.setTimeout(() => setAvisoPago(''), 3500);
    return () => window.clearTimeout(timer);
  }, [avisoPago]);

  useEffect(() => {
    if (!panelPlanificadorAbierto) return;
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflowAnterior; };
  }, [panelPlanificadorAbierto]);

  if (!panelPlanificadorAbierto) return null;

  const cerrarEstrategia = () => {
    setAvisoPago('');
    setPanelPlanificadorAbierto(false);
  };

  return <div className="strategy-layer">
    <button type="button" className="drawer-backdrop" onClick={cerrarEstrategia} aria-label="Cerrar estrategia" />
    <aside className="budget-drawer strategy-drawer open" aria-label="Estrategia académica y financiera">
      <div className="budget-drawer-head"><div><span className="budget-kicker">Estrategia de matrícula</span><h2>Plan académico y presupuesto</h2></div>
        <button type="button" className="drawer-close" onClick={cerrarEstrategia} aria-label="Cerrar"><X size={18} /></button></div>
      <div className="strategy-navigation">
        <div className="strategy-drawer-tabs" role="tablist" aria-label="Secciones de estrategia">
          <button type="button" role="tab" aria-selected={pestana === 'academico'} onClick={() => setPestana('academico')}><Sparkles size={14} /> Ruta académica</button>
          <button type="button" role="tab" aria-selected={pestana === 'financiero'} onClick={() => setPestana('financiero')}><CreditCard size={14} /> Simulación de cuotas</button>
        </div>
        {pestana === 'financiero' && <button type="button" className="quota-settings-toggle"
          aria-label="Configuración de cuotas" title="Mostrar u ocultar configuración de cuotas"
          aria-expanded={ajustesCuotasAbiertos} aria-controls="quota-settings"
          onClick={() => setAjustesCuotasAbiertos((actual) => !actual)}>
          <Settings2 size={20} aria-hidden="true" /><span className="quota-settings-label">Configuración</span><ChevronDown size={14} aria-hidden="true" />
        </button>}
      </div>
      {pestana === 'academico' ? <div className="strategy-tab-content" role="tabpanel">
        <section className="strategy-block strategy-automatic"><h3><TrendingUp size={15} /> Planificación automática</h3>
          <p>Ciclo actual: {cicloActual ?? 'sin configurar'}. La propuesta organiza tus pendientes desde el ciclo {(cicloActual ?? 0) + 1} (tu malla llega al {totalCiclos}). Sin límites usa hasta {LIMITE_HORAS_PLANIFICACION} horas por ciclo; puedes poner tu máximo de horas, de créditos o tu presupuesto mensual, y usar veranos.</p>
          <p>Primero van los jalados en su ventana, luego los obligatorios por prioridad y al final los electivos que faltan para el mínimo de créditos. Si hace falta, agrega ciclos.</p>
          {ciclosExcluidos.length > 0 && <p>Ciclos retirados: {ciclosExcluidos.join(', ')}. No se utilizarán en la propuesta.</p>}
          <button type="button" className="planning-generate-btn" onClick={() => abrirAutogenerar({ alcance: 'hastaEgresar' })}><Sparkles size={14} /> Generar propuesta</button>
        </section>
        <section className="strategy-block"><h3>Cursos críticos</h3><p>Materias obligatorias pendientes que desbloquean más obligatorios posteriores.</p>
          <div className="critical-courses-grid">{criticos.map((curso) => <div className="critical-course-pill" key={curso.codigo}><b>{curso.codigo}</b><span>{curso.nombre}</span><small>Desbloquea {curso.desbloquea}</small></div>)}</div></section>
      </div> : <div className="strategy-tab-content" role="tabpanel">
        <div id="quota-settings" className="quota-settings" hidden={!ajustesCuotasAbiertos}>
          {tarifario && <small className="budget-config-note">Facultad: {disciplinaActiva} · {[tarifario.sede, tarifario.modalidadEstudio, tarifario.vigencia].filter(Boolean).join(' · ')}</small>}
          {tarifario?.metodosPago && <div className="budget-control-block"><label htmlFor="metodo-pago-select"><CreditCard size={14} /> Método de pago</label>
            <select id="metodo-pago-select" value={metodoPago} onChange={(event) => { setMetodoPago(event.target.value); setAvisoPago('Método de pago aplicado a la simulación.'); }}>
              {Object.entries(tarifario.metodosPago).map(([clave, metodo]) => <option key={clave} value={clave}>{metodo.nombre}{metodo.descuentoPorcentaje ? ` (${metodo.descuentoPorcentaje}%)` : ''}</option>)}
            </select></div>}
        </div>
        <div className="financial-scroll-panel">{resumen?.periodos.length
          ? resumen.periodos.map((periodo) => <PeriodFinancialCard key={periodo.id} periodo={periodo}
              pagoUnicoActivo={Boolean(pagoUnico[periodo.id])}
              onTogglePagoUnico={() => { setPagoUnico(periodo.id, !pagoUnico[periodo.id]); setAvisoPago('Cambios aplicados a la simulación.'); }} />)
          : <div className="budget-empty">No hay cursos pendientes planificados.</div>}</div>
        {resumen && <FinancialTotalCard total={resumen.totalGeneral} />}
      </div>}
      <div className="strategy-shared-footer"><span>Créditos pendientes: <b>{formatCredits(creditosPendientes)}</b></span><span>Inversión estimada: <b>S/ {(resumen?.totalGeneral ?? 0).toFixed(2)}</b></span></div>
    </aside>
    {avisoPago && <div className="nav-feedback-toast toast-exito" role="status">{avisoPago}</div>}
  </div>;
}
