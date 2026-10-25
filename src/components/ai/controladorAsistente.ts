import {
  MAX_MENSAJES, MAX_TEXTO_MENSAJE,
  type AIAnalisisResponse, type AIContext, type AIErrorCodigo, type AIFoco, type AIMensaje, type AIRequest,
} from '../../application/ai/contracts';
import type { AIClient } from '../../infrastructure/ai/HttpAIClient';
import { opcionesDePropuesta, type OpcionesPropuesta } from '../../application/ai/limites';
import { focoParaEnviar, mismoFoco, type FocoUI } from './asistenteLogica';

export interface Solicitud {
  modo: AIRequest['modo'];
  texto: string;
  foco: FocoUI | null;
}

export type MensajeChat =
  | { id: number; rol: 'user'; texto: string; foco: FocoUI | null }
  | {
    id: number; rol: 'assistant'; tipo: 'texto'; texto: string; cursos: string[]; preguntas: string[];
    /** La respuesta explica una propuesta con límites: el botón "Aplicar a mi malla" abre su vista previa. */
    propuesta?: OpcionesPropuesta;
  }
  | { id: number; rol: 'assistant'; tipo: 'analisis'; analisis: AIAnalisisResponse }
  | { id: number; rol: 'assistant'; tipo: 'error'; error: AIErrorCodigo; mensaje: string; reintento: Solicitud };

export type PanelEntrada = 'rapidas' | 'adjuntar' | null;

export interface EstadoAsistente {
  mensajes: MensajeChat[];
  enviando: boolean;
  privacidadAceptada: boolean;
  foco: FocoUI | null;
  /** Ya se envió una pregunta con el foco actual: sus 3 sugerencias se ocultan y queda solo el chip. */
  focoEnviado: boolean;
  panel: PanelEntrada;
  presupuesto: string;
}

export interface DependenciasAsistente {
  cliente: AIClient;
  /** Recalcula el contexto en cada envío (buildAIContext con el estado actual del store). */
  obtenerContexto: (opciones: { foco?: AIFoco; presupuestoMensual?: number | null; mensaje?: string }) => AIContext;
  privacidadAceptada?: boolean;
  alAceptarPrivacidad?: () => void;
}

export const TEXTO_ANALISIS = 'Analizar mi plan';

const estadoInicial = (privacidadAceptada: boolean): EstadoAsistente => ({
  mensajes: [], enviando: false, privacidadAceptada, foco: null, focoEnviado: false, panel: null, presupuesto: '',
});

/** Texto de un mensaje tal como se envía en el historial (el análisis se resume). */
const textoHistorial = (mensaje: MensajeChat): string | null => {
  if (mensaje.rol === 'user') return mensaje.texto;
  if (mensaje.tipo === 'texto') return mensaje.texto;
  if (mensaje.tipo === 'analisis') {
    const { resumen, secciones } = mensaje.analisis;
    return [resumen, ...secciones.map((seccion) => `${seccion.titulo}: ${seccion.detalle}`)].join('\n');
  }
  return null;
};

/** Solo los últimos 8 mensajes (sin errores), recortados a 1000 caracteres. */
export const historialParaEnviar = (mensajes: MensajeChat[]): AIMensaje[] =>
  mensajes.flatMap((mensaje) => {
    const texto = textoHistorial(mensaje);
    return texto === null ? [] : [{ rol: mensaje.rol, texto: texto.slice(0, MAX_TEXTO_MENSAJE) }];
  }).slice(-MAX_MENSAJES);

export const presupuestoNumerico = (texto: string): number | null => {
  const valor = Number(texto.replace(',', '.'));
  return Number.isFinite(valor) && valor > 0 ? valor : null;
};

/**
 * Estado de la conversación sin React ni DOM: historial solo en memoria,
 * nada se envía sin aceptar el aviso de privacidad.
 */
export const crearControladorAsistente = (dependencias: DependenciasAsistente) => {
  let estado = estadoInicial(Boolean(dependencias.privacidadAceptada));
  let siguienteId = 1;
  let generacion = 0;
  const oyentes = new Set<() => void>();

  const actualizar = (cambios: Partial<EstadoAsistente>) => {
    estado = { ...estado, ...cambios };
    oyentes.forEach((oyente) => oyente());
  };

  const enviar = async (solicitud: Solicitud): Promise<void> => {
    if (!estado.privacidadAceptada || estado.enviando) return;
    const texto = solicitud.texto.trim().slice(0, MAX_TEXTO_MENSAJE);
    if (!texto) return;
    const pregunta: MensajeChat = { id: siguienteId++, rol: 'user', texto, foco: solicitud.foco };
    const mensajes = [...estado.mensajes, pregunta];
    actualizar({ mensajes, enviando: true, panel: null, focoEnviado: estado.focoEnviado || Boolean(solicitud.foco && mismoFoco(solicitud.foco, estado.foco)) });

    const foco = focoParaEnviar(solicitud.foco);
    // En el chat, el mensaje puede pedir límites (detectarLimites): el contexto trae la propuesta del planificador.
    const contexto = dependencias.obtenerContexto({
      foco, presupuestoMensual: presupuestoNumerico(estado.presupuesto), ...(solicitud.modo === 'chat' ? { mensaje: texto } : {}),
    });
    const peticion: AIRequest = {
      modo: solicitud.modo,
      contexto,
      ...(foco ? { foco } : {}),
      mensajes: historialParaEnviar(mensajes),
    };
    const generacionEnvio = generacion;
    const resultado = await dependencias.cliente.enviar(peticion);
    // "Nueva conversación" durante la espera descarta la respuesta.
    if (generacionEnvio !== generacion) return;

    const id = siguienteId++;
    const respuesta: MensajeChat = !resultado.ok
      ? { id, rol: 'assistant', tipo: 'error', error: resultado.error, mensaje: resultado.mensaje, reintento: { ...solicitud, texto } }
      : 'secciones' in resultado.respuesta
        ? { id, rol: 'assistant', tipo: 'analisis', analisis: resultado.respuesta }
        : {
          id, rol: 'assistant', tipo: 'texto', texto: resultado.respuesta.texto, cursos: resultado.respuesta.cursos,
          preguntas: resultado.respuesta.preguntasSugeridas,
          ...(contexto.propuestaConLimites ? { propuesta: opcionesDePropuesta(contexto.propuestaConLimites) } : {}),
        };
    actualizar({ mensajes: [...estado.mensajes, respuesta], enviando: false });
  };

  return {
    obtener: () => estado,
    suscribir: (oyente: () => void) => {
      oyentes.add(oyente);
      return () => { oyentes.delete(oyente); };
    },
    aceptarPrivacidad: () => {
      dependencias.alAceptarPrivacidad?.();
      actualizar({ privacidadAceptada: true });
    },
    analizar: () => enviar({ modo: 'analisis', texto: TEXTO_ANALISIS, foco: estado.foco }),
    preguntar: (texto: string) => enviar({ modo: 'chat', texto, foco: estado.foco }),
    /** Quita la burbuja de error y repite la misma solicitud con el contexto recalculado. */
    reintentar: (idError: number) => {
      const indice = estado.mensajes.findIndex((mensaje) => mensaje.id === idError);
      const error = estado.mensajes[indice];
      if (!error || error.rol !== 'assistant' || error.tipo !== 'error' || estado.enviando) return Promise.resolve();
      // También se quita la pregunta original: enviar() la vuelve a agregar.
      const previa = estado.mensajes[indice - 1];
      const quitar = new Set([error.id, ...(previa?.rol === 'user' ? [previa.id] : [])]);
      actualizar({ mensajes: estado.mensajes.filter((mensaje) => !quitar.has(mensaje.id)) });
      return enviar(error.reintento);
    },
    nuevaConversacion: () => {
      generacion += 1;
      actualizar({ ...estadoInicial(estado.privacidadAceptada), presupuesto: estado.presupuesto });
    },
    /** Un foco distinto vuelve a mostrar sus sugerencias; elegir el mismo no las repone. */
    setFoco: (foco: FocoUI | null) => actualizar({ foco, panel: null, focoEnviado: mismoFoco(foco, estado.foco) && estado.focoEnviado }),
    setPanel: (panel: PanelEntrada) => actualizar({ panel }),
    alternarPanel: (panel: Exclude<PanelEntrada, null>) => actualizar({ panel: estado.panel === panel ? null : panel }),
    setPresupuesto: (presupuesto: string) => actualizar({ presupuesto }),
  };
};

export type ControladorAsistente = ReturnType<typeof crearControladorAsistente>;
