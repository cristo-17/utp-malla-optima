import { MAX_MENSAJES, MAX_TEXTO_MENSAJE, type AIContext, type AIErrorCodigo, type AIMensaje, type AIRequest, type AIRespuesta } from '../../src/contracts.js';
import { costoEstimadoUsd, sumarUso, USO_VACIO, type UsoTokens } from '../../src/consumo.js';
import type { IntentoCrudo, Verificacion } from '../../src/deepseek.js';
import { aplicarMontoDelAlumno } from '../../src/presupuesto.js';
import type { Caso, Fixture } from './casos.js';
import { chequear, type Fallo, type Severidad } from './chequeos.js';

/** Resultado de una llamada (la real usa llamarDeepSeek, igual que producción). */
export interface ResultadoLlamada {
  respuesta: AIRespuesta | null;
  error: AIErrorCodigo | null;
  /** Contenido crudo de la última respuesta del modelo (para el reporte y los códigos sin filtrar). */
  crudo: string | null;
  uso: UsoTokens;
  intentos: number;
  /** Cada intento por separado (finish_reason, usage crudo, razonamiento y contenido). */
  detalle?: IntentoCrudo[];
  /** Resultado del filtro de salida (null si la llamada falló antes). */
  verificacion?: Verificacion | null;
  /** Chequeos del filtro que fallaron (en la primera respuesta o en la regenerada). */
  chequeosFiltro?: string[];
}

export interface Repeticion {
  numero: number;
  ms: number;
  costoUsd: number;
  uso: UsoTokens;
  intentos: number;
  error: AIErrorCodigo | null;
  respuesta: AIRespuesta | null;
  crudo: string | null;
  detalle: IntentoCrudo[];
  verificacion: Verificacion | null;
  chequeosFiltro: string[];
  fallos: Fallo[];
  /** Caso encadenado: el historial con que se hizo la última pregunta (sin ella). */
  historial?: AIMensaje[];
}

export interface ResultadoCaso {
  caso: Caso;
  repeticiones: Repeticion[];
  /** Pasa solo si todas sus repeticiones pasan. */
  aprobado: boolean;
}

export interface ResultadoEvaluacion {
  casos: ResultadoCaso[];
  detenidoPorCosto: boolean;
  costoUsd: number;
  uso: UsoTokens;
  latencias: number[];
  latenciasPorModo: Record<'analisis' | 'chat', number[]>;
}

export interface OpcionesEvaluacion {
  casos: Caso[];
  fixtures: (nombre: Fixture) => AIContext;
  llamar: (peticion: AIRequest) => Promise<ResultadoLlamada>;
  repeticiones: number;
  solo?: string;
  maxUsd: number;
  /** true si la llamada cae en horario pico (precio doble). */
  horarioPico: () => boolean;
  ahora?: () => number;
  progreso?: (linea: string) => void;
}

export const peticionDe = (caso: Caso, contexto: AIContext): AIRequest => ({
  modo: caso.modo,
  contexto,
  ...(caso.foco ? { foco: caso.foco } : {}),
  mensajes: caso.mensajes.map((texto) => ({ rol: 'user' as const, texto })),
});

const codigosCrudos = (crudo: string | null): string[] => {
  if (!crudo) return [];
  try {
    const datos = JSON.parse(crudo) as { cursos?: unknown; secciones?: { cursos?: unknown }[] };
    const listas = [datos.cursos, ...(datos.secciones ?? []).map((seccion) => seccion.cursos)];
    return listas.flatMap((lista) => (Array.isArray(lista) ? lista.filter((item): item is string => typeof item === 'string') : []));
  } catch {
    return [];
  }
};

/**
 * Turnos anteriores de un caso encadenado, preguntados de verdad. Como el cliente (historialParaEnviar): una respuesta
 * con error no entra al historial, el texto se recorta a 1000 caracteres y van los últimos 8 mensajes.
 */
const historialDe = async (caso: Caso, contexto: AIContext, llamar: OpcionesEvaluacion['llamar']) => {
  const historial: AIMensaje[] = [];
  const llamadas: ResultadoLlamada[] = [];
  for (const texto of caso.mensajes.slice(0, -1)) {
    historial.push({ rol: 'user', texto });
    const llamada = await llamar({ modo: caso.modo, contexto, ...(caso.foco ? { foco: caso.foco } : {}), mensajes: historial.slice(-MAX_MENSAJES) });
    llamadas.push(llamada);
    if (llamada.respuesta && 'texto' in llamada.respuesta) historial.push({ rol: 'assistant', texto: llamada.respuesta.texto.slice(0, MAX_TEXTO_MENSAJE) });
  }
  return { historial, llamadas };
};

/** Corre los casos en serie. Antes de cada llamada revisa el tope de costo. */
export const evaluar = async (opciones: OpcionesEvaluacion): Promise<ResultadoEvaluacion> => {
  const { llamar, fixtures, repeticiones, maxUsd, horarioPico, ahora = Date.now, progreso = () => undefined } = opciones;
  const casos = opciones.solo ? opciones.casos.filter((caso) => caso.id === opciones.solo) : opciones.casos;
  if (opciones.solo && !casos.length) throw new Error(`No existe el caso "${opciones.solo}".`);

  const resultado: ResultadoEvaluacion = {
    casos: [], detenidoPorCosto: false, costoUsd: 0, uso: USO_VACIO, latencias: [], latenciasPorModo: { analisis: [], chat: [] },
  };
  for (const caso of casos) {
    const contexto = fixtures(caso.fixture);
    const filas: Repeticion[] = [];
    for (let numero = 1; numero <= repeticiones; numero += 1) {
      if (resultado.costoUsd >= maxUsd) {
        resultado.detenidoPorCosto = true;
        break;
      }
      const previo = caso.encadenada ? await historialDe(caso, caso.fixturePrevio ? fixtures(caso.fixturePrevio) : contexto, llamar) : null;
      const peticion = peticionDe(caso, contexto);
      if (previo) peticion.mensajes = [...previo.historial, ...peticion.mensajes.slice(-1)].slice(-MAX_MENSAJES);
      // La latencia es la de la última pregunta; el costo, el de toda la conversación.
      const inicio = ahora();
      const llamada = await llamar(peticion);
      const ms = ahora() - inicio;
      const usoTotal = (previo?.llamadas ?? []).reduce((suma, previa) => sumarUso(suma, previa.uso), llamada.uso);
      const costoUsd = costoEstimadoUsd(usoTotal, horarioPico());
      // Se evalúa lo que ve el alumno: la respuesta que pasó el filtro de salida, o el aviso que la reemplaza.
      const fallos: Fallo[] = llamada.error === 'RESPUESTA_NO_VERIFICADA'
        ? [{ severidad: 'MAYOR', chequeo: 'respuesta-segura', detalle: `El filtro de salida devolvió la respuesta segura (${(llamada.chequeosFiltro ?? []).join(', ')}).` }]
        : llamada.error === 'RESPUESTA_LARGA'
          ? [{ severidad: 'CRITICO', chequeo: 'respuesta-cortada', detalle: 'Se cortó dos veces (finish_reason "length"): el alumno ve RESPUESTA_LARGA.' }]
          : llamada.error === 'RESPUESTA_INVALIDA'
            ? [{ severidad: 'CRITICO', chequeo: 'respuesta-invalida', detalle: 'Dos salidas que no cumplen el contrato: el alumno ve RESPUESTA_INVALIDA (502).' }]
          : llamada.error
            ? [{ severidad: 'CRITICO' as Severidad, chequeo: 'error-proveedor', detalle: `La llamada falló con ${llamada.error}.` }]
            : chequear({
          // Lo mismo que ve el modelo: el monto del último mensaje como presupuesto (llamarConVerificacion).
          modo: caso.modo, contexto: caso.modo === 'chat' ? aplicarMontoDelAlumno(contexto, caso.mensajes.at(-1) ?? '') : contexto, mensajes: caso.mensajes, esperado: caso.esperado,
          presupuestoDelPlan: contexto.financiero?.presupuestoMensual ?? null,
          respuesta: llamada.respuesta, codigosCrudos: codigosCrudos(llamada.crudo),
        });
      filas.push({
        numero, ms, costoUsd, uso: usoTotal, intentos: llamada.intentos, error: llamada.error, respuesta: llamada.respuesta, crudo: llamada.crudo,
        detalle: llamada.detalle ?? [], verificacion: llamada.verificacion ?? null, chequeosFiltro: llamada.chequeosFiltro ?? [], fallos,
        ...(previo ? { historial: previo.historial } : {}),
      });
      resultado.costoUsd = Number((resultado.costoUsd + costoUsd).toFixed(6));
      resultado.uso = sumarUso(resultado.uso, usoTotal);
      resultado.latencias.push(ms);
      resultado.latenciasPorModo[caso.modo].push(ms);
      progreso(`${fallos.length ? '✗' : '✓'} ${caso.id} #${numero} · ${ms} ms · US$ ${resultado.costoUsd.toFixed(4)}${fallos.length ? ` · ${fallos.map((fallo) => `${fallo.severidad}:${fallo.chequeo}`).join(', ')}` : ''}`);
    }
    if (filas.length) resultado.casos.push({ caso, repeticiones: filas, aprobado: filas.length === repeticiones && filas.every((fila) => !fila.fallos.length) });
    if (resultado.detenidoPorCosto) break;
  }
  return resultado;
};

export const percentil = (valores: number[], p: number): number => {
  if (!valores.length) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)];
};

export const fallosPorSeveridad = (resultado: ResultadoEvaluacion): Record<Severidad, number> => {
  const conteo: Record<Severidad, number> = { CRITICO: 0, MAYOR: 0, MENOR: 0 };
  for (const { repeticiones } of resultado.casos) for (const fila of repeticiones) for (const fallo of fila.fallos) conteo[fallo.severidad] += 1;
  return conteo;
};

/** Cuántas repeticiones pasaron el filtro a la primera, tras regenerar o con la respuesta segura. */
export const resultadosFiltro = (resultado: ResultadoEvaluacion) => {
  const filas = resultado.casos.flatMap((caso) => caso.repeticiones);
  const conteo: Record<Verificacion, number> = { primera: 0, regenerada: 0, segura: 0 };
  const chequeos: Record<string, number> = {};
  for (const fila of filas) {
    if (fila.verificacion) conteo[fila.verificacion] += 1;
    for (const chequeo of fila.chequeosFiltro) chequeos[chequeo] = (chequeos[chequeo] ?? 0) + 1;
  }
  return { ...conteo, total: filas.length, chequeos };
};

export interface Criterio { nombre: string; cumple: boolean; valor: string }

/** Criterios de aprobación (2026-10-23, corrida 3) para la salida final que ve el alumno. */
export const criterios = (resultado: ResultadoEvaluacion): Criterio[] => {
  const filas = resultado.casos.flatMap((caso) => caso.repeticiones);
  const ok = filas.filter((fila) => !fila.fallos.some((fallo) => fallo.severidad !== 'MENOR')).length;
  const conMenor = filas.filter((fila) => fila.fallos.some((fallo) => fallo.severidad === 'MENOR')).length;
  const filtro = resultadosFiltro(resultado);
  const criticos = fallosPorSeveridad(resultado).CRITICO;
  const p95Chat = percentil(resultado.latenciasPorModo.chat, 95);
  const p95Analisis = percentil(resultado.latenciasPorModo.analisis, 95);
  const pct = (parte: number) => (filas.length ? (parte / filas.length) * 100 : 0);
  return [
    { nombre: '0 fallos CRÍTICOS', cumple: criticos === 0, valor: String(criticos) },
    { nombre: '≥ 95 % de repeticiones sin CRÍTICO ni MAYOR', cumple: pct(ok) >= 95, valor: `${pct(ok).toFixed(1)} %` },
    { nombre: 'MENOR en ≤ 10 % de las repeticiones', cumple: pct(conMenor) <= 10, valor: `${pct(conMenor).toFixed(1)} %` },
    { nombre: 'respuestas seguras ≤ 3 %', cumple: pct(filtro.segura) <= 3, valor: `${pct(filtro.segura).toFixed(1)} %` },
    { nombre: 'p95 chat < 6 s', cumple: p95Chat < 6000, valor: `${p95Chat} ms` },
    { nombre: 'p95 análisis < 10 s', cumple: p95Analisis < 10_000, valor: `${p95Analisis} ms` },
  ];
};

/** 1 si hay algún fallo CRÍTICO; 2 si se detuvo por el tope de costo; 0 si no. */
export const codigoDeSalida = (resultado: ResultadoEvaluacion): number =>
  fallosPorSeveridad(resultado).CRITICO > 0 ? 1 : resultado.detenidoPorCosto ? 2 : 0;
