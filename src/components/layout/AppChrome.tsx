import { Calculator, CircleHelp, FileSpreadsheet, GraduationCap, Menu, Moon, RotateCcw, Settings2, Sparkles, Sun, Upload } from 'lucide-react';
import { APP_NAME, APP_SUBTITLE } from '../../config/appIdentity';
import { MINIMO_CREDITOS_ELECTIVOS } from '../../domain/rules/planningRules';
import { formatCredits } from '../../utils/formatCredits';
import { BackupControls } from '../BackupControls';
import { FacultadDropdown } from '../FacultadDropdown';
import { SaveAsMenu } from '../SaveAsMenu';
import type { AppController } from '../../hooks/useAppController';
import { useChromeHeight } from '../../hooks/useChromeHeight';

export function AppChrome({ app }: { app: AppController }) {
  const barrasRef = useChromeHeight(app.perfilCargado);
  return <div ref={barrasRef} className="app-chrome">
    <TopBar app={app} />
    <MainNav app={app} />
    {!app.sinMalla && <PlannerToolbar app={app} />}
  </div>;
}

function TopBar({ app }: { app: AppController }) {
  return <header id="app-topbar">
    <span className="topbar-brand"><GraduationCap size={23} className="topbar-logo-icon" /><b className="topbar-title">{APP_NAME}<span className="topbar-title-extended"> · {APP_SUBTITLE}</span></b></span>
    <span className="topbar-badge">UTP</span><span className="topbar-sep" />
    <span className="topbar-note">Sede Ate - Tarifario Oficial 2026 Referencial</span>
    <button type="button" className="topbar-help-btn" onClick={() => app.setModalAyuda(true)} aria-label="Ayuda: cómo usar MallaU" title="Ayuda: cómo usar MallaU"><CircleHelp size={20} /></button>
    <button type="button" className="theme-toggle" onClick={app.cambiarTema} aria-label={app.tema === 'light' ? 'Activar modo oscuro' : 'Activar modo claro'} aria-pressed={app.tema === 'dark'} title={app.tema === 'light' ? 'Activar modo oscuro' : 'Activar modo claro'}>{app.tema === 'light' ? <Moon size={18} /> : <Sun size={18} />}<span className="theme-toggle-label">{app.tema === 'light' ? 'Modo oscuro' : 'Modo claro'}</span></button>
    <button type="button" className="topbar-mob-menu-btn" onClick={() => app.setMenuMovil((actual) => !actual)} aria-label="Abrir menú" aria-expanded={app.menuMovil}><Menu size={22} /></button>
  </header>;
}

function MainNav({ app }: { app: AppController }) {
  return <nav id="app-nav" className={app.menuMovil ? 'integration-nav-open' : ''} aria-label="Controles principales">
    <div className="nav-group"><span className="nav-group-label"><FileSpreadsheet size={12} /> Malla</span>
      <button type="button" className="nav-control-btn" onClick={() => app.setModalCarga(true)}><Upload size={14} /> {app.nombreArchivoCargado ? 'Actualizar Excel' : 'Subir Excel'}</button>
    </div>
    <div className="nav-divider" />
    <div className="nav-group"><span className="nav-group-label">Avance</span><span className="nav-progress">{app.avance.llevados} llevados · {app.avance.enCurso} en curso · {app.avance.planificados} planificados · {app.avance.pendientes} pendientes</span></div>
    <div className="nav-divider" />
    <div className="nav-group" title={`Créditos electivos mínimos: ${MINIMO_CREDITOS_ELECTIVOS}`}><span className="nav-group-label">Electivos</span><span className="nav-chip-electivos">{formatCredits(app.creditosElectivos)} / {MINIMO_CREDITOS_ELECTIVOS} cr</span></div>
    <div className="nav-spacer" />
    <button type="button" className="nav-action secondary" onClick={() => app.setModalContexto(true)}><Settings2 size={14} /> Configuración</button>
    <button type="button" className="nav-action secondary" onClick={() => void app.reiniciarPlanificacion()}><RotateCcw size={14} /> Limpiar plan</button>
    <BackupControls />
    <div className="nav-final-actions">
      <SaveAsMenu cursos={app.cursos} exportandoPNG={app.exportando} onGuardarPNG={app.descargarPNG} />
      <FacultadDropdown />
      <button type="button" className="nav-action autogen-nav-action" onClick={() => app.abrirAutogenerar()}><Sparkles size={14} /> Autogenerar</button>
      <button type="button" className="nav-action primary strategy-nav-action" onClick={() => app.setPanelPlanificadorAbierto(true)}><Calculator size={14} /> Estrategia</button>
    </div>
  </nav>;
}

function PlannerToolbar({ app }: { app: AppController }) {
  return <div className="integration-settings">
    <label htmlFor="visible-start">Mostrar desde ciclo</label>
    <select id="visible-start" value={app.inicioVisible} onChange={(event) => app.setCicloInicioVisible(Number(event.target.value))}>
      {app.ciclosDisponibles.map((numero) => <option key={numero} value={numero}>{numero}</option>)}
    </select>
    <label className="summer-switch"><input type="checkbox" checked={app.mostrarVeranos} onChange={(event) => app.setMostrarVeranos(event.target.checked)} /> <Sun size={14} /> Mostrar veranos</label>
    <span>Inicio: {app.periodoIngreso === 'agosto' ? 'agosto' : 'marzo'} · Ciclo actual: {app.cicloActual}</span>
  </div>;
}
