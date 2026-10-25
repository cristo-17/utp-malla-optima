import { Fragment, type ReactNode } from 'react';
import {
  AlertTriangle, Bot, Check, CircleCheck, GitBranch, Gauge, OctagonAlert, RefreshCw, Route, Sparkles, Target, Wallet,
} from 'lucide-react';
import type { OpcionesPropuesta } from '../../application/ai/limites';
import type { AISeccion, Nivel } from '../../application/ai/contracts';
import { cursosParaMostrar, partirPorCodigos, sinRepetidas } from './asistenteLogica';
import type { MensajeChat } from './controladorAsistente';

const ICONO_SECCION: Record<AISeccion['tipo'], ReactNode> = {
  financiero: <Wallet size={17} aria-hidden="true" />,
  carga: <Gauge size={17} aria-hidden="true" />,
  ruta: <Route size={17} aria-hidden="true" />,
  whatIf: <GitBranch size={17} aria-hidden="true" />,
  electivos: <Target size={17} aria-hidden="true" />,
};

const NIVEL: Record<Nivel, { texto: string; icono: ReactNode }> = {
  ok: { texto: 'Bien', icono: <CircleCheck size={14} aria-hidden="true" /> },
  atencion: { texto: 'Atención', icono: <AlertTriangle size={14} aria-hidden="true" /> },
  riesgo: { texto: 'Riesgo', icono: <OctagonAlert size={14} aria-hidden="true" /> },
};

/** Texto plano de la IA: saltos de línea como <br>, nunca HTML; resalta los códigos de curso. */
export function TextoPlano({ texto, codigos = [] }: { texto: string; codigos?: string[] }) {
  return <>{texto.split('\n').map((linea, indice) => <Fragment key={indice}>
    {indice > 0 && <br />}
    {partirPorCodigos(linea, codigos).map((parte, posicion) => parte.codigo
      ? <mark key={posicion} className="ia-codigo">{parte.texto}</mark>
      : <Fragment key={posicion}>{parte.texto}</Fragment>)}
  </Fragment>)}</>;
}

interface CursosProps {
  codigos: string[];
  nombres: Map<string, string>;
  /** Cursos del próximo periodo: van primero. */
  prioridad?: readonly string[];
}

/** Hasta 5 chips, primero los del próximo periodo. */
function CursosResaltados({ codigos, nombres, prioridad }: CursosProps) {
  const visibles = cursosParaMostrar(codigos, prioridad);
  if (!visibles.length) return null;
  return <ul className="ia-cursos" aria-label="Cursos mencionados">
    {visibles.map((codigo) => <li key={codigo}><span>{nombres.get(codigo) ?? codigo}</span> <mark className="ia-codigo">{codigo}</mark></li>)}
  </ul>;
}

interface ChipsProps {
  preguntas: string[];
  excluir: string[];
  onElegir: (texto: string) => void;
  deshabilitado: boolean;
}

function Chips({ preguntas, excluir, onElegir, deshabilitado }: ChipsProps) {
  const visibles = sinRepetidas(preguntas, excluir);
  if (!visibles.length) return null;
  return <div className="ia-chips" role="group" aria-label="Preguntas sugeridas">
    {visibles.map((pregunta) => <button key={pregunta} type="button" className="ia-chip" disabled={deshabilitado} onClick={() => onElegir(pregunta)}>{pregunta}</button>)}
  </div>;
}

export function TarjetaSeccion({ seccion, nombres, prioridad }: { seccion: AISeccion; nombres: Map<string, string>; prioridad?: readonly string[] }) {
  const nivel = NIVEL[seccion.nivel];
  return <article className={`ia-seccion ia-nivel-${seccion.nivel}`} aria-label={`${seccion.titulo}: ${nivel.texto}`}>
    <header>
      <span className="ia-seccion-icono">{ICONO_SECCION[seccion.tipo]}</span>
      <h3>{seccion.titulo}</h3>
      <span className="ia-nivel">{nivel.icono}{nivel.texto}</span>
    </header>
    <p><TextoPlano texto={seccion.detalle} codigos={seccion.cursos} /></p>
    {seccion.acciones.length > 0 && <ul className="ia-acciones">{seccion.acciones.map((accion) => <li key={accion}>{accion}</li>)}</ul>}
    <CursosResaltados codigos={seccion.cursos} nombres={nombres} prioridad={prioridad} />
  </article>;
}

interface MensajesProps {
  mensajes: MensajeChat[];
  nombres: Map<string, string>;
  enviando: boolean;
  deshabilitado: boolean;
  /** Preguntas ya visibles en otra parte (las del foco): no se repiten como chips de la respuesta. */
  excluirPreguntas?: string[];
  onPreguntar: (texto: string) => void;
  onReintentar: (id: number) => void;
  onAplicarPropuesta?: (opciones: OpcionesPropuesta) => void;
  onAnalizar?: () => void;
  /** Códigos del próximo periodo (prioridad de los chips de cursos). */
  prioridadCursos?: readonly string[];
}

export function AsistenteMensajes({
  mensajes, nombres, enviando, deshabilitado, excluirPreguntas = [], onPreguntar, onReintentar, onAplicarPropuesta, onAnalizar,
  prioridadCursos = [],
}: MensajesProps) {
  const ultimo = mensajes.at(-1);
  return <>
    {mensajes.map((mensaje) => {
      if (mensaje.rol === 'user') {
        return <div key={mensaje.id} className="ia-fila ia-fila-user">
          <div className="ia-burbuja ia-burbuja-user">
            {mensaje.foco && <span className="ia-burbuja-foco">📎 {mensaje.foco.etiqueta}</span>}
            <TextoPlano texto={mensaje.texto} />
          </div>
        </div>;
      }
      const esUltimo = mensaje === ultimo;
      if (mensaje.tipo === 'error') {
        return <div key={mensaje.id} className="ia-fila">
          <div className="ia-burbuja ia-burbuja-bot ia-burbuja-error" role="alert">
            <p>{mensaje.mensaje}</p>
            <button type="button" className="ia-reintentar" disabled={deshabilitado} onClick={() => onReintentar(mensaje.id)}>
              <RefreshCw size={15} aria-hidden="true" /> Reintentar
            </button>
          </div>
        </div>;
      }
      if (mensaje.tipo === 'app') {
        return <div key={mensaje.id} className="ia-fila">
          <div className="ia-burbuja ia-burbuja-bot ia-mensaje-app" role="status">
            <p>{mensaje.texto}</p>
            {onAnalizar && <button type="button" className="ia-btn-primario ia-accion-plan" disabled={deshabilitado} onClick={onAnalizar}>
              <Sparkles size={16} aria-hidden="true" /> Analizar mi plan
            </button>}
          </div>
        </div>;
      }
      if (mensaje.tipo === 'analisis') {
        return <div key={mensaje.id} className="ia-fila">
          <div className="ia-analisis">
            <div className="ia-burbuja ia-burbuja-bot"><TextoPlano texto={mensaje.analisis.resumen} /></div>
            {mensaje.analisis.secciones.map((seccion, indice) => <TarjetaSeccion key={`${seccion.tipo}-${indice}`} seccion={seccion} nombres={nombres} prioridad={prioridadCursos} />)}
            <p className="ia-nota">Costos referenciales (tarifario 2026): verifícalos en el portal de la UTP antes de pagar.</p>
            {esUltimo && <Chips preguntas={mensaje.analisis.preguntasSugeridas} excluir={excluirPreguntas} onElegir={onPreguntar} deshabilitado={deshabilitado} />}
          </div>
        </div>;
      }
      return <div key={mensaje.id} className="ia-fila">
        <div className="ia-columna">
          <div className="ia-burbuja ia-burbuja-bot">
            <p><TextoPlano texto={mensaje.texto} codigos={mensaje.cursos} /></p>
            <CursosResaltados codigos={mensaje.cursos} nombres={nombres} prioridad={prioridadCursos} />
            {mensaje.propuesta && onAplicarPropuesta && <button type="button" className="ia-btn-primario ia-accion-plan"
              onClick={() => onAplicarPropuesta(mensaje.propuesta!)}><Check size={16} aria-hidden="true" /> Aplicar a mi malla</button>}
          </div>
          {esUltimo && <Chips preguntas={mensaje.preguntas} excluir={excluirPreguntas} onElegir={onPreguntar} deshabilitado={deshabilitado} />}
        </div>
      </div>;
    })}
    {enviando && <div className="ia-fila" role="status" aria-live="polite">
      <div className="ia-burbuja ia-burbuja-bot ia-escribiendo"><Bot size={15} aria-hidden="true" /><span>escribiendo…</span><span className="ia-puntos" aria-hidden="true"><i /><i /><i /></span></div>
    </div>}
  </>;
}
