import type { AIRespuesta } from '../../src/contracts.js';
import { PRECIOS_DEEPSEEK_FLASH } from '../../src/consumo.js';
import type { IntentoCrudo } from '../../src/deepseek.js';
import { SEVERIDADES } from './chequeos.js';
import { criterios, fallosPorSeveridad, percentil, resultadosFiltro, type ResultadoEvaluacion } from './ejecutar.js';

export interface MetaReporte {
  fecha: Date;
  modelo: string;
  repeticiones: number;
  maxUsd: number;
  /** true si se corrió con el fetch simulado (sin la API real). */
  simulado: boolean;
}

const partesLima = (fecha: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(fecha).map((parte) => [parte.type, parte.value]));

/** docs/evaluaciones/AAAA-MM-DD-HHMM.md, en hora de Lima. */
export const nombreReporte = (fecha: Date): string => {
  const p = partesLima(fecha);
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.md`;
};

const porcentaje = (parte: number, total: number) => (total ? `${Math.round((parte / total) * 100)} %` : '—');

const resumen = (resultado: ResultadoEvaluacion) => {
  const aprobados = resultado.casos.filter((caso) => caso.aprobado).length;
  const repeticiones = resultado.casos.flatMap((caso) => caso.repeticiones);
  const repeticionesOk = repeticiones.filter((fila) => !fila.fallos.length).length;
  return { aprobados, total: resultado.casos.length, repeticiones: repeticiones.length, repeticionesOk, fallos: fallosPorSeveridad(resultado) };
};

export const resumenConsola = (resultado: ResultadoEvaluacion, meta: MetaReporte): string => {
  const r = resumen(resultado);
  const { uso } = resultado;
  return [
    `Evaluación ${meta.simulado ? '(SIMULADA, sin la API real) ' : ''}· modelo ${meta.modelo} · ${meta.repeticiones} repeticiones por caso`,
    `Casos aprobados (todas sus repeticiones): ${r.aprobados}/${r.total} (${porcentaje(r.aprobados, r.total)})`,
    `Repeticiones aprobadas: ${r.repeticionesOk}/${r.repeticiones} (${porcentaje(r.repeticionesOk, r.repeticiones)})`,
    `Fallos por severidad: ${SEVERIDADES.map((severidad) => `${severidad} ${r.fallos[severidad]}`).join(' · ')}`,
    `Latencia: p50 ${percentil(resultado.latencias, 50)} ms · p95 ${percentil(resultado.latencias, 95)} ms`
      + ` · chat p95 ${percentil(resultado.latenciasPorModo.chat, 95)} ms · análisis p95 ${percentil(resultado.latenciasPorModo.analisis, 95)} ms`,
    filtroEnLinea(resultado),
    `Tokens: entrada ${uso.prompt_tokens} (con caché ${uso.prompt_cache_hit_tokens}, sin caché ${uso.prompt_cache_miss_tokens}) · salida ${uso.completion_tokens}`,
    `Costo estimado: US$ ${resultado.costoUsd.toFixed(4)} (tope US$ ${meta.maxUsd.toFixed(2)})${resultado.detenidoPorCosto ? ' · DETENIDO POR EL TOPE DE COSTO' : ''}`,
    `Criterios: ${criterios(resultado).map((criterio) => `${criterio.cumple ? '✓' : '✗'} ${criterio.nombre} (${criterio.valor})`).join(' · ')}`,
  ].join('\n');
};

/** Lo que hizo el filtro de salida: la evaluación mide lo que ve el alumno, no solo la respuesta cruda. */
const filtroEnLinea = (resultado: ResultadoEvaluacion) => {
  const filtro = resultadosFiltro(resultado);
  const chequeos = Object.entries(filtro.chequeos).map(([chequeo, veces]) => `${chequeo} ${veces}`).join(', ');
  return `Filtro de salida: a la primera ${filtro.primera} · regeneradas ${filtro.regenerada} · seguras ${filtro.segura}`
    + ` (${porcentaje(filtro.segura, filtro.total)})${chequeos ? ` · chequeos que fallaron: ${chequeos}` : ''}`;
};

const bloque = (texto: string) => `\`\`\`\n${texto.replace(/```/g, "'''")}\n\`\`\``;

const respuestaLegible = (respuesta: AIRespuesta): string => 'texto' in respuesta
  ? `${respuesta.texto}${respuesta.cursos.length ? `\n\n[cursos: ${respuesta.cursos.join(', ')}]` : ''}`
  : [
    respuesta.resumen,
    ...respuesta.secciones.map((seccion) => [
      `\n## ${seccion.tipo} · ${seccion.nivel} · ${seccion.titulo}`,
      seccion.detalle,
      ...seccion.acciones.map((accion) => `- ${accion}`),
      seccion.cursos.length ? `[cursos: ${seccion.cursos.join(', ')}]` : '',
    ].filter(Boolean).join('\n')),
  ].join('\n');

/** Diagnóstico por intento: finish_reason, usage completo, si vino razonamiento y el contenido crudo. */
const detalleIntentos = (detalle: IntentoCrudo[]): string[] => [
  '<details><summary>Intentos</summary>',
  '',
  ...detalle.flatMap((intento, i) => [
    `Intento ${i + 1} · finish_reason \`${intento.finishReason ?? '—'}\` · reasoning_content: ${intento.razonamiento ? 'sí' : 'no'} · ${intento.contenido.length} caracteres`,
    '',
    `usage: \`${JSON.stringify(intento.usage)}\``,
    '',
    bloque(intento.contenido || '(vacío)'),
    '',
  ]),
  '</details>',
];

/** Reporte completo para revisar el tono a mano: todas las respuestas y los chequeos fallidos. */
export const reporteMarkdown = (resultado: ResultadoEvaluacion, meta: MetaReporte): string => {
  const r = resumen(resultado);
  const p = partesLima(meta.fecha);
  const lineas = [
    `# Evaluación del asistente · ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (Lima)`,
    '',
    meta.simulado ? '> **Simulada:** se corrió con el fetch simulado (respuestas mock), no con la API real.\n' : '',
    `- Modelo: \`${meta.modelo}\` · repeticiones por caso: ${meta.repeticiones} · tope: US$ ${meta.maxUsd.toFixed(2)}`,
    `- Precios: deepseek-flash, consultados el ${PRECIOS_DEEPSEEK_FLASH.fechaConsulta}.`,
    '',
    '## Resumen',
    '',
    '```',
    resumenConsola(resultado, meta),
    '```',
    '',
    '## Casos',
    '',
    '| Caso | Grupo | Aprobadas | Fallos |',
    '| --- | --- | --- | --- |',
    ...resultado.casos.map(({ caso, repeticiones, aprobado }) => {
      const ok = repeticiones.filter((fila) => !fila.fallos.length).length;
      const fallos = [...new Set(repeticiones.flatMap((fila) => fila.fallos.map((fallo) => `${fallo.severidad} ${fallo.chequeo}`)))];
      return `| ${aprobado ? '✅' : '❌'} \`${caso.id}\` | ${caso.grupo} | ${ok}/${repeticiones.length} | ${fallos.join('; ') || '—'} |`;
    }),
    '',
    `Global: ${r.aprobados}/${r.total} casos (${porcentaje(r.aprobados, r.total)}).`,
    '',
    '## Respuestas',
  ];
  for (const { caso, repeticiones } of resultado.casos) {
    lineas.push('', `### \`${caso.id}\` · ${caso.grupo}`, '', `Fixture \`${caso.fixture}\` · modo ${caso.modo}${caso.foco ? ` · foco ${caso.foco.tipo} ${caso.foco.id ?? ''}` : ''}`);
    if (caso.mensajes.length) lineas.push('', ...caso.mensajes.map((mensaje) => `> **Alumno:** ${mensaje.replace(/\n/g, ' ')}`));
    for (const fila of repeticiones) {
      const filtro = fila.verificacion ? ` · filtro: ${fila.verificacion}${fila.chequeosFiltro.length ? ` (${fila.chequeosFiltro.join(', ')})` : ''}` : '';
      lineas.push('', `**Repetición ${fila.numero}** · ${fila.ms} ms · ${fila.intentos} intento(s) · US$ ${fila.costoUsd.toFixed(6)}${fila.error ? ` · error ${fila.error}` : ''}${filtro}`, '');
      // Caso encadenado: lo que respondió el modelo en los turnos anteriores (la última pregunta ya está arriba).
      if (fila.historial) {
        lineas.push(...fila.historial.map((mensaje) => `> **${mensaje.rol === 'user' ? 'Alumno' : 'Asistente'}:** ${mensaje.texto.replace(/\n/g, ' ')}`), '');
      }
      lineas.push(bloque(fila.respuesta ? respuestaLegible(fila.respuesta) : (fila.crudo ?? '(sin respuesta)')));
      if (fila.fallos.length) lineas.push('', ...fila.fallos.map((fallo) => `- **${fallo.severidad}** \`${fallo.chequeo}\`: ${fallo.detalle}`));
      if (fila.detalle.length) lineas.push('', ...detalleIntentos(fila.detalle));
    }
  }
  return `${lineas.join('\n')}\n`;
};
