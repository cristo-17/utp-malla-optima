import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { BookOpen, CalendarRange, ChevronLeft, LayoutGrid, Paperclip, Search, SendHorizontal, Smile, WifiOff, X } from 'lucide-react';
import { MAX_TEXTO_MENSAJE } from '../../application/ai/contracts';
import {
  ACCION_ARMAR_PLAN, FOCO_PLAN, PREGUNTAS_RAPIDAS, filtrarCursos, type FocoUI, type OpcionesAdjuntar,
} from './asistenteLogica';
import type { PanelEntrada } from './controladorAsistente';

interface PanelRapidasProps {
  onElegir: (texto: string) => void;
  /** "🗓️ Armar mi plan con límites": abre Autogenerar (no envía nada al asistente). */
  onArmarPlan?: () => void;
}

export function PanelRapidas({ onElegir, onArmarPlan }: PanelRapidasProps) {
  return <div className="ia-subpanel" id="ia-panel-rapidas" role="group" aria-label="Preguntas rápidas">
    <p className="ia-subpanel-titulo">Preguntas rápidas</p>
    <div className="ia-chips">
      {PREGUNTAS_RAPIDAS.map(({ emoji, texto }) => <button key={texto} type="button" className="ia-chip" onClick={() => onElegir(texto)}>
        <span aria-hidden="true">{emoji}</span> {texto}
      </button>)}
      {onArmarPlan && <button type="button" className="ia-chip ia-chip-accion" onClick={onArmarPlan}>
        <span aria-hidden="true">{ACCION_ARMAR_PLAN.emoji}</span> {ACCION_ARMAR_PLAN.texto}
      </button>}
    </div>
  </div>;
}

type VistaAdjuntar = 'menu' | 'ciclos' | 'cursos';

interface PanelAdjuntarProps {
  opciones: OpcionesAdjuntar;
  onElegir: (foco: FocoUI) => void;
  vistaInicial?: VistaAdjuntar;
}

export function PanelAdjuntar({ opciones, onElegir, vistaInicial = 'menu' }: PanelAdjuntarProps) {
  const [vista, setVista] = useState<VistaAdjuntar>(vistaInicial);
  const [busqueda, setBusqueda] = useState('');
  const cursos = filtrarCursos(opciones.cursos, busqueda);
  const volver = <button type="button" className="ia-volver" onClick={() => setVista('menu')}><ChevronLeft size={16} aria-hidden="true" /> Volver</button>;

  return <div className="ia-subpanel" id="ia-panel-adjuntar" role="group" aria-label="Preguntar sobre…">
    <p className="ia-subpanel-titulo">Preguntar sobre…</p>
    {vista === 'menu' && <div className="ia-opciones">
      <button type="button" className="ia-opcion" onClick={() => onElegir(FOCO_PLAN)}><LayoutGrid size={18} aria-hidden="true" /> Mi plan completo</button>
      <button type="button" className="ia-opcion" onClick={() => setVista('ciclos')} disabled={!opciones.periodos.length}>
        <CalendarRange size={18} aria-hidden="true" /> Un ciclo{!opciones.periodos.length && <small>Sin periodos planificados</small>}
      </button>
      <button type="button" className="ia-opcion" onClick={() => setVista('cursos')}><BookOpen size={18} aria-hidden="true" /> Un curso</button>
    </div>}
    {vista === 'ciclos' && <>
      {volver}
      <ul className="ia-lista" aria-label="Periodos planificados">
        {opciones.periodos.map((periodo) => <li key={periodo.id}>
          <button type="button" onClick={() => onElegir({ tipo: 'ciclo', id: periodo.id, etiqueta: periodo.etiqueta })}>
            {periodo.etiqueta} <small>{periodo.cursos} {periodo.cursos === 1 ? 'curso' : 'cursos'}</small>
          </button>
        </li>)}
      </ul>
    </>}
    {vista === 'cursos' && <>
      {volver}
      <label className="ia-buscador">
        <Search size={15} aria-hidden="true" />
        <input type="search" value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar curso o código" aria-label="Buscar curso" />
      </label>
      <ul className="ia-lista" aria-label="Cursos">
        {cursos.map((curso) => <li key={curso.codigo}>
          <button type="button" onClick={() => onElegir({ tipo: 'curso', id: curso.codigo, etiqueta: curso.nombre })}>
            {curso.nombre} <small>{curso.codigo}</small>
          </button>
        </li>)}
        {!cursos.length && <li className="ia-lista-vacia">No hay cursos con ese nombre.</li>}
      </ul>
    </>}
  </div>;
}

interface EntradaProps {
  panel: PanelEntrada;
  foco: FocoUI | null;
  /** Sugerencias del foco que se muestran bajo el chip (vacías tras el primer envío con ese foco). */
  sugerenciasFoco: string[];
  enLinea: boolean;
  enviando: boolean;
  bloqueado: boolean;
  opciones: OpcionesAdjuntar;
  mostrarTooltipRapidas: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onAlternarPanel: (panel: Exclude<PanelEntrada, null>) => void;
  onCerrarPanel: () => void;
  onElegirFoco: (foco: FocoUI) => void;
  onQuitarFoco: () => void;
  onEnviar: (texto: string) => void;
  onArmarPlan?: () => void;
}

export function AsistenteEntrada(props: EntradaProps) {
  const { panel, foco, enLinea, enviando, bloqueado, opciones, mostrarTooltipRapidas, inputRef } = props;
  const [texto, setTexto] = useState('');
  const zonaRef = useRef<HTMLDivElement>(null);
  const { onCerrarPanel } = props;
  const deshabilitado = !enLinea || bloqueado;

  // Los paneles se cierran al tocar fuera de la zona de entrada.
  useEffect(() => {
    if (!panel) return;
    const alTocar = (event: PointerEvent) => {
      if (!zonaRef.current?.contains(event.target as Node)) onCerrarPanel();
    };
    document.addEventListener('pointerdown', alTocar);
    return () => document.removeEventListener('pointerdown', alTocar);
  }, [panel, onCerrarPanel]);

  const enviar = (valor: string) => {
    if (deshabilitado || enviando || !valor.trim()) return;
    props.onEnviar(valor);
    setTexto('');
  };
  const alEnviar = (event: FormEvent) => {
    event.preventDefault();
    enviar(texto);
  };

  return <div className="ia-entrada-zona" ref={zonaRef}>
    {!enLinea && <p className="ia-offline" role="status"><WifiOff size={16} aria-hidden="true" /> Sin conexión: el asistente necesita internet</p>}
    {panel === 'rapidas' && !deshabilitado && <PanelRapidas onElegir={enviar} onArmarPlan={props.onArmarPlan} />}
    {panel === 'adjuntar' && !deshabilitado && <PanelAdjuntar opciones={opciones} onElegir={props.onElegirFoco} />}
    {foco && <div className="ia-foco">
      <span className="ia-foco-chip">📎 {foco.etiqueta}
        <button type="button" onClick={props.onQuitarFoco} aria-label={`Quitar ${foco.etiqueta}`}><X size={14} aria-hidden="true" /></button>
      </span>
      {props.sugerenciasFoco.length > 0 && <div className="ia-chips" role="group" aria-label="Preguntas sobre el foco">
        {props.sugerenciasFoco.map((pregunta) => <button key={pregunta} type="button" className="ia-chip" disabled={deshabilitado || enviando} onClick={() => enviar(pregunta)}>{pregunta}</button>)}
      </div>}
    </div>}
    <form className="ia-barra" onSubmit={alEnviar}>
      <button type="button" className={`ia-icono-btn ${panel === 'adjuntar' ? 'activo' : ''}`} onClick={() => props.onAlternarPanel('adjuntar')}
        disabled={deshabilitado} aria-label="Preguntar sobre un ciclo o curso" aria-expanded={panel === 'adjuntar'} aria-controls="ia-panel-adjuntar">
        <Paperclip size={20} aria-hidden="true" />
      </button>
      <span className="ia-tooltip-ancla">
        <button type="button" className={`ia-icono-btn ${panel === 'rapidas' ? 'activo' : ''}`} onClick={() => props.onAlternarPanel('rapidas')}
          disabled={deshabilitado} aria-label="Preguntas rápidas" aria-expanded={panel === 'rapidas'} aria-controls="ia-panel-rapidas" title="Preguntas rápidas">
          <Smile size={20} aria-hidden="true" />
        </button>
        {mostrarTooltipRapidas && !deshabilitado && <span className="ia-tooltip" role="tooltip">Preguntas rápidas</span>}
      </span>
      <input ref={inputRef} className="ia-input" type="text" value={texto} maxLength={MAX_TEXTO_MENSAJE} disabled={deshabilitado}
        onChange={(event) => setTexto(event.target.value)} placeholder={enLinea ? 'Escribe tu pregunta…' : 'Sin conexión'}
        aria-label="Escribe tu pregunta" enterKeyHint="send" autoComplete="off" />
      <button type="submit" className="ia-enviar" disabled={deshabilitado || enviando || !texto.trim()} aria-label="Enviar">
        <SendHorizontal size={20} aria-hidden="true" />
      </button>
    </form>
  </div>;
}

