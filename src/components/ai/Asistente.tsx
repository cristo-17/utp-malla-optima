import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAcademicStore } from '../../store/useAcademicStore';
import { buildAIContext } from '../../application/ai/buildAIContext';
import { detectarLimites } from '../../application/ai/limites';
import { conexionActual, crearAIClient, escucharConexion } from '../../infrastructure/ai/HttpAIClient';
import { AsistenteFab } from './AsistenteFab';
import { AsistentePanel } from './AsistentePanel';
import { almacen, CLAVES_ASISTENTE, debeOcultarFab, opcionesAdjuntar } from './asistenteLogica';
import { crearControladorAsistente } from './controladorAsistente';
import { cicloVacioProximo } from '../../presentation/messages/autogenerarMessages';
import './asistente.css';

const DURACION_TOOLTIP_MS = 6000;
const ENFOCABLES = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const useEnLinea = () => useSyncExternalStore(
  (avisar) => escucharConexion(() => avisar()), conexionActual, () => true);

/** Arrastre nativo de tarjetas: el botón se oculta para no tapar los destinos. */
const useArrastrando = () => {
  const [arrastrando, setArrastrando] = useState(false);
  useEffect(() => {
    const iniciar = () => setArrastrando(true);
    const terminar = () => setArrastrando(false);
    document.addEventListener('dragstart', iniciar);
    document.addEventListener('dragend', terminar);
    document.addEventListener('drop', terminar);
    return () => {
      document.removeEventListener('dragstart', iniciar);
      document.removeEventListener('dragend', terminar);
      document.removeEventListener('drop', terminar);
    };
  }, []);
  return arrastrando;
};

export function Asistente() {
  const { cursos, cicloActual, cursoAMover, estrategiaAbierta, abrirAutogenerar } = useAcademicStore(useShallow((state) => ({
    cursos: state.cursos, cicloActual: state.cicloActual,
    cursoAMover: state.cursoAMover, estrategiaAbierta: state.panelPlanificadorAbierto,
    abrirAutogenerar: state.abrirAutogenerar,
  })));
  const [controlador] = useState(() => {
    const cliente = crearAIClient();
    return Object.assign(crearControladorAsistente({
      cliente,
      // El contexto se recalcula en cada envío con el estado actual del store.
      obtenerContexto: ({ mensaje, ...opciones }) =>
        buildAIContext(useAcademicStore.getState(), { ...opciones, limites: mensaje ? detectarLimites(mensaje) : null }),
      privacidadAceptada: almacen.leer(CLAVES_ASISTENTE.privacidad),
      alAceptarPrivacidad: () => almacen.guardar(CLAVES_ASISTENTE.privacidad),
    }), { esMock: cliente.esMock });
  });
  const estado = useSyncExternalStore(controlador.suscribir, controlador.obtener, controlador.obtener);
  const enLinea = useEnLinea();
  const arrastrando = useArrastrando();
  const [abierto, setAbierto] = useState(false);
  const [saludoPendiente, setSaludoPendiente] = useState(() => !almacen.leer(CLAVES_ASISTENTE.saludo));
  const [tooltipRapidas, setTooltipRapidas] = useState(() => !almacen.leer(CLAVES_ASISTENTE.tooltipRapidas));
  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mensajesRef = useRef<HTMLDivElement>(null);
  const estabaAbierto = useRef(false);

  const sinMalla = cursos.length === 0;
  const fabOculto = debeOcultarFab({ sinMalla, arrastrando, cursoAMover, panelAbierto: abierto, estrategiaAbierta });
  const mostrarSaludo = saludoPendiente && !fabOculto;
  const nombres = useMemo(() => new Map(cursos.map((curso) => [curso.codigo, curso.nombre])), [cursos]);
  const opciones = useMemo(() => opcionesAdjuntar(cursos, cicloActual), [cursos, cicloActual]);
  const cicloVacio = useMemo(() => cicloVacioProximo(cursos, cicloActual), [cursos, cicloActual]);

  // Padding inferior del contenido para que el botón nunca tape tarjetas.
  useEffect(() => {
    if (sinMalla) return;
    document.body.classList.add('ia-con-asistente');
    return () => document.body.classList.remove('ia-con-asistente');
  }, [sinMalla]);

  // El saludo es de una sola vez: se marca como visto apenas aparece.
  useEffect(() => {
    if (mostrarSaludo) almacen.guardar(CLAVES_ASISTENTE.saludo);
  }, [mostrarSaludo]);
  const cerrarSaludo = useCallback(() => setSaludoPendiente(false), []);

  const mostrarTooltip = abierto && tooltipRapidas && estado.privacidadAceptada;
  useEffect(() => {
    if (!mostrarTooltip) return;
    almacen.guardar(CLAVES_ASISTENTE.tooltipRapidas);
    const temporizador = window.setTimeout(() => setTooltipRapidas(false), DURACION_TOOLTIP_MS);
    return () => window.clearTimeout(temporizador);
  }, [mostrarTooltip]);

  const abrir = () => {
    setSaludoPendiente(false);
    setAbierto(true);
    try {
      // Una entrada en el historial para que el botón atrás de Android cierre el panel.
      window.history.pushState({ ...(window.history.state ?? {}), asistenteIA: true }, '');
    } catch {
      // Sin historial el panel se cierra con X o Esc.
    }
  };
  const cerrar = useCallback(() => {
    if (window.history.state?.asistenteIA) window.history.back();
    else setAbierto(false);
  }, []);

  useEffect(() => {
    if (!abierto) return;
    const alVolver = () => setAbierto(false);
    window.addEventListener('popstate', alVolver);
    return () => window.removeEventListener('popstate', alVolver);
  }, [abierto]);

  // Foco inicial dentro del panel y regreso al botón al cerrar.
  useEffect(() => {
    if (abierto) {
      const panel = panelRef.current;
      (panel?.querySelector<HTMLElement>('[data-autofocus]') ?? inputRef.current ?? panel?.querySelector<HTMLElement>(ENFOCABLES))?.focus();
    } else if (estabaAbierto.current) {
      fabRef.current?.focus();
    }
    estabaAbierto.current = abierto;
  }, [abierto, estado.privacidadAceptada]);

  // Celular: el panel sigue al viewport visible para que el input quede sobre el teclado.
  useEffect(() => {
    const viewport = window.visualViewport;
    const panel = panelRef.current;
    if (!abierto || !viewport || !panel) return;
    const ajustar = () => {
      panel.style.setProperty('--ia-vv-h', `${viewport.height}px`);
      panel.style.setProperty('--ia-vv-top', `${viewport.offsetTop}px`);
    };
    ajustar();
    viewport.addEventListener('resize', ajustar);
    viewport.addEventListener('scroll', ajustar);
    return () => {
      viewport.removeEventListener('resize', ajustar);
      viewport.removeEventListener('scroll', ajustar);
    };
  }, [abierto, estado.privacidadAceptada]);

  useEffect(() => {
    const lista = mensajesRef.current;
    if (lista) lista.scrollTop = lista.scrollHeight;
  }, [estado.mensajes.length, estado.enviando, abierto]);

  const alTeclear = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (estado.panel) controlador.setPanel(null);
      else cerrar();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const enfocables = [...panelRef.current.querySelectorAll<HTMLElement>(ENFOCABLES)];
    const primero = enfocables[0];
    const ultimo = enfocables.at(-1);
    if (!primero || !ultimo) return;
    if (event.shiftKey && document.activeElement === primero) {
      event.preventDefault();
      ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
      event.preventDefault();
      primero.focus();
    }
  };

  const cerrarPanelEntrada = useCallback(() => controlador.setPanel(null), [controlador]);

  return <>
    <AsistenteFab oculto={fabOculto} mostrarSaludo={mostrarSaludo} onAbrir={abrir} onCerrarSaludo={cerrarSaludo} botonRef={fabRef} />
    {abierto && <>
      <div className="ia-fondo" aria-hidden="true" onClick={cerrar} />
      <AsistentePanel
        estado={estado} enLinea={enLinea} nombres={nombres} opciones={opciones} esMock={controlador.esMock} cicloVacio={cicloVacio}
        onAutogenerar={(alcance) => abrirAutogenerar({ alcance })}
        onAplicarPropuesta={abrirAutogenerar}
        mostrarTooltipRapidas={mostrarTooltip} panelRef={panelRef} inputRef={inputRef} mensajesRef={mensajesRef} onKeyDown={alTeclear}
        onCerrar={cerrar}
        onNuevaConversacion={controlador.nuevaConversacion}
        onAceptarPrivacidad={controlador.aceptarPrivacidad}
        onCancelarPrivacidad={cerrar}
        onAnalizar={() => void controlador.analizar()}
        onPresupuesto={controlador.setPresupuesto}
        onPreguntar={(texto) => void controlador.preguntar(texto)}
        onReintentar={(id) => void controlador.reintentar(id)}
        onAlternarPanel={(panel) => {
          if (panel === 'rapidas') setTooltipRapidas(false);
          controlador.alternarPanel(panel);
        }}
        onCerrarPanel={cerrarPanelEntrada}
        onElegirFoco={controlador.setFoco}
        onQuitarFoco={() => controlador.setFoco(null)}
      />
    </>}
  </>;
}
