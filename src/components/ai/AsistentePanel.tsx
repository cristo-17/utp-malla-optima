import type { KeyboardEvent, Ref } from 'react';
import { Bot, CalendarPlus, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { AsistenteEntrada } from './AsistenteEntrada';
import { AsistenteMensajes } from './AsistenteMensajes';
import { preguntasPorFoco, type FocoUI, type OpcionesAdjuntar } from './asistenteLogica';
import type { EstadoAsistente, PanelEntrada } from './controladorAsistente';
import type { OpcionesPropuesta } from '../../application/ai/limites';

export const TEXTO_PRIVACIDAD = 'Enviaremos tu plan de forma anónima a un servicio de IA externo (DeepSeek) para analizarlo. No enviamos tu nombre ni tu código.';

export interface AccionesPanel {
  onCerrar: () => void;
  onNuevaConversacion: () => void;
  onAceptarPrivacidad: () => void;
  onCancelarPrivacidad: () => void;
  onAnalizar: () => void;
  onPresupuesto: (valor: string) => void;
  onPreguntar: (texto: string) => void;
  onReintentar: (id: number) => void;
  onAlternarPanel: (panel: Exclude<PanelEntrada, null>) => void;
  onCerrarPanel: () => void;
  onElegirFoco: (foco: FocoUI) => void;
  onQuitarFoco: () => void;
  /** Abre Autogenerar; con el próximo ciclo vacío, con alcance "Próximo ciclo". */
  onAutogenerar?: (alcance: 'proximoPeriodo' | 'hastaEgresar') => void;
  /** "Aplicar a mi malla" debajo de una respuesta con propuesta: abre Autogenerar con esos límites. */
  onAplicarPropuesta?: (opciones: OpcionesPropuesta) => void;
}

interface PanelProps extends AccionesPanel {
  estado: EstadoAsistente;
  enLinea: boolean;
  nombres: Map<string, string>;
  opciones: OpcionesAdjuntar;
  mostrarTooltipRapidas: boolean;
  esMock?: boolean;
  /** Número del próximo ciclo si no tiene cursos (tarjeta "¿Lo armo?"); null si ya tiene. */
  cicloVacio?: number | null;
  panelRef?: Ref<HTMLDivElement>;
  inputRef?: Ref<HTMLInputElement>;
  mensajesRef?: Ref<HTMLDivElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function AvisoPrivacidad({ onAceptar, onCancelar }: { onAceptar: () => void; onCancelar: () => void }) {
  return <div className="ia-privacidad" role="alertdialog" aria-labelledby="ia-privacidad-titulo" aria-describedby="ia-privacidad-texto">
    <ShieldCheck size={28} aria-hidden="true" />
    <h3 id="ia-privacidad-titulo">Antes de empezar</h3>
    <p id="ia-privacidad-texto">{TEXTO_PRIVACIDAD}</p>
    <div className="ia-privacidad-acciones">
      <button type="button" className="ia-btn-secundario" onClick={onCancelar}>Cancelar</button>
      <button type="button" className="ia-btn-primario" onClick={onAceptar} data-autofocus>Aceptar</button>
    </div>
  </div>;
}

/** Con el próximo ciclo vacío, esta tarjeta va antes que "Analizar mi plan". */
export function TarjetaCicloVacio({ ciclo, deshabilitado, onAutogenerar }: { ciclo: number; deshabilitado?: boolean; onAutogenerar: () => void }) {
  return <div className="ia-fila">
    <div className="ia-burbuja ia-burbuja-bot ia-ciclo-vacio" role="group" aria-labelledby="ia-ciclo-vacio-titulo">
      <p id="ia-ciclo-vacio-titulo"><CalendarPlus size={16} aria-hidden="true" /> <b>Tu Ciclo {ciclo} está vacío. ¿Lo armo?</b></p>
      <p className="ia-ayuda">Te muestro una propuesta con tus límites y tú decides si la aplicas a tu malla.</p>
      <button type="button" className="ia-btn-primario" onClick={onAutogenerar} disabled={deshabilitado}>
        <Sparkles size={16} aria-hidden="true" /> Autogenerar
      </button>
    </div>
  </div>;
}

interface BienvenidaProps {
  presupuesto: string;
  deshabilitado: boolean;
  onPresupuesto: (valor: string) => void;
  onAnalizar: () => void;
}

function Bienvenida({ presupuesto, deshabilitado, onPresupuesto, onAnalizar }: BienvenidaProps) {
  return <div className="ia-fila">
    <div className="ia-burbuja ia-burbuja-bot ia-bienvenida">
      <p>¡Hola! Soy tu asistente académico. Reviso tu carga, el costo de tu matrícula, tu ruta hasta egresar y qué pasa si jalas un curso.</p>
      <label className="ia-presupuesto">
        <span>Presupuesto mensual (S/)</span>
        <input type="number" inputMode="decimal" min="0" step="10" value={presupuesto} placeholder="Opcional"
          onChange={(event) => onPresupuesto(event.target.value)} disabled={deshabilitado} />
      </label>
      <button type="button" className="ia-btn-primario ia-analizar" onClick={onAnalizar} disabled={deshabilitado}>
        <Sparkles size={16} aria-hidden="true" /> Analizar mi plan
      </button>
      <p className="ia-ayuda">Toca 😊 para ver preguntas rápidas o 📎 para preguntar por un ciclo o curso.</p>
    </div>
  </div>;
}

export function AsistentePanel({ panelRef, inputRef, mensajesRef, onKeyDown, ...props }: PanelProps) {
  const { estado, enLinea, nombres, opciones, esMock } = props;
  const pidePrivacidad = !estado.privacidadAceptada;
  const sugerenciasFoco = estado.foco && !estado.focoEnviado ? preguntasPorFoco(estado.foco) : [];

  return <div className="ia-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="ia-titulo" onKeyDown={onKeyDown}>
    <header className="ia-cabecera">
      <span className="ia-avatar" aria-hidden="true"><Bot size={22} /></span>
      <div className="ia-cabecera-texto">
        <h2 id="ia-titulo">Asistente académico IA</h2>
        <span className="ia-estado" role="status">
          <i className={`ia-punto ${enLinea ? 'en-linea' : 'sin-conexion'}`} aria-hidden="true" />
          {enLinea ? 'En línea' : 'Sin conexión'}{esMock && enLinea ? ' · demo' : ''}
        </span>
      </div>
      <button type="button" className="ia-cabecera-btn" onClick={props.onNuevaConversacion} aria-label="Nueva conversación" title="Nueva conversación" disabled={pidePrivacidad}>
        <RotateCcw size={19} aria-hidden="true" />
      </button>
      <button type="button" className="ia-cabecera-btn" onClick={props.onCerrar} aria-label="Cerrar asistente" title="Cerrar">
        <X size={20} aria-hidden="true" />
      </button>
    </header>

    {pidePrivacidad
      ? <div className="ia-cuerpo"><AvisoPrivacidad onAceptar={props.onAceptarPrivacidad} onCancelar={props.onCancelarPrivacidad} /></div>
      : <>
        <div className="ia-cuerpo" ref={mensajesRef} aria-live="polite">
          {props.cicloVacio && props.onAutogenerar && <TarjetaCicloVacio ciclo={props.cicloVacio}
            onAutogenerar={() => props.onAutogenerar?.('proximoPeriodo')} />}
          <Bienvenida presupuesto={estado.presupuesto} deshabilitado={!enLinea || estado.enviando}
            onPresupuesto={props.onPresupuesto} onAnalizar={props.onAnalizar} />
          <AsistenteMensajes mensajes={estado.mensajes} nombres={nombres} enviando={estado.enviando}
            deshabilitado={!enLinea || estado.enviando} excluirPreguntas={sugerenciasFoco} onPreguntar={props.onPreguntar} onReintentar={props.onReintentar}
            onAplicarPropuesta={props.onAplicarPropuesta} />
        </div>
        <AsistenteEntrada panel={estado.panel} foco={estado.foco} sugerenciasFoco={sugerenciasFoco} enLinea={enLinea} enviando={estado.enviando} bloqueado={pidePrivacidad}
          opciones={opciones} mostrarTooltipRapidas={props.mostrarTooltipRapidas} inputRef={inputRef}
          onAlternarPanel={props.onAlternarPanel} onCerrarPanel={props.onCerrarPanel} onElegirFoco={props.onElegirFoco}
          onQuitarFoco={props.onQuitarFoco} onEnviar={props.onPreguntar} />
      </>}
  </div>;
}
