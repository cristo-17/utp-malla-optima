import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AIContextSchema, AIRequestSchema, errorSecciones, esquemaRespuesta, MAX_CURSOS, MAX_TEXTO_MENSAJE, parsearRespuesta, TIPOS_SECCION,
} from '../../src/application/ai/contracts';
import { crearContextoMinimo } from '../helpers/aiContexto';

const contexto = crearContextoMinimo();
const mensaje = (texto: string) => ({ rol: 'user' as const, texto });

describe('Contratos IA - AIRequest', () => {
  it('acepta una petición de análisis con foco y mensajes', () => {
    const peticion = { modo: 'analisis', contexto, foco: { tipo: 'curso', id: '100000I62N' }, mensajes: [mensaje('Hola')] };
    expect(AIRequestSchema.safeParse(peticion).success).toBe(true);
  });

  it('el contexto mínimo de prueba cumple AIContextSchema', () => {
    expect(AIContextSchema.safeParse(contexto).success).toBe(true);
  });

  it('rechaza más de 8 mensajes', () => {
    const mensajes = Array.from({ length: 9 }, (_, indice) => mensaje(`m${indice}`));
    expect(AIRequestSchema.safeParse({ modo: 'chat', contexto, mensajes }).success).toBe(false);
  });

  it('rechaza textos de más de 1000 caracteres', () => {
    const largo = mensaje('x'.repeat(MAX_TEXTO_MENSAJE + 1));
    expect(AIRequestSchema.safeParse({ modo: 'chat', contexto, mensajes: [largo] }).success).toBe(false);
    const justo = mensaje('x'.repeat(MAX_TEXTO_MENSAJE));
    expect(AIRequestSchema.safeParse({ modo: 'chat', contexto, mensajes: [justo] }).success).toBe(true);
  });

  it('rechaza un modo o un rol desconocidos', () => {
    expect(AIRequestSchema.safeParse({ modo: 'otro', contexto, mensajes: [] }).success).toBe(false);
    expect(AIRequestSchema.safeParse({ modo: 'chat', contexto, mensajes: [{ rol: 'system', texto: 'x' }] }).success).toBe(false);
  });
});

describe('Contratos IA - respuestas', () => {
  const seccion = {
    tipo: 'carga', nivel: 'riesgo', titulo: 'Carga alta', detalle: 'x',
    acciones: ['a'], cursos: ['100000I62N', 'INVENTADO', '100000I62N'],
  };

  const resto = ['financiero', 'ruta', 'whatIf', 'electivos'].map((tipo) => ({ ...seccion, tipo, cursos: [] }));

  it('el análisis descarta códigos inexistentes y duplicados', () => {
    const respuesta = parsearRespuesta('analisis', { resumen: 'r', secciones: [seccion, ...resto], preguntasSugeridas: [] }, contexto);
    expect(respuesta.secciones[0].cursos).toEqual(['100000I62N']);
  });

  it('el análisis exige exactamente 5 secciones, una de cada tipo, en orden: carga, financiero, ruta, whatIf, electivos', () => {
    expect(TIPOS_SECCION).toEqual(['carga', 'financiero', 'ruta', 'whatIf', 'electivos']);
    const analisis = (secciones: unknown[]) => ({ resumen: 'r', secciones, preguntasSugeridas: [] });
    expect(() => parsearRespuesta('analisis', analisis([seccion, ...resto.slice(0, 3)]), contexto)).toThrow();
    expect(() => parsearRespuesta('analisis', analisis([resto[0], seccion, ...resto.slice(1)]), contexto)).toThrow();
    expect(() => parsearRespuesta('analisis', analisis([seccion, ...resto, seccion]), contexto)).toThrow();
    // El proxy lee con secciones libres para que el filtro de salida pida corregirlas.
    expect(parsearRespuesta('analisis', analisis([seccion]), contexto, true).secciones).toHaveLength(1);
    const prefijos = (esquemaRespuesta('analisis') as { properties: { secciones: { prefixItems: { properties: { tipo: { const: string } } }[] } } })
      .properties.secciones.prefixItems.map((item) => item.properties.tipo.const);
    expect(prefijos).toEqual(['carga', 'financiero', 'ruta', 'whatIf', 'electivos']);
  });

  it('errorSecciones nombra lo que falta, lo que sobra o el orden', () => {
    const orden = 'Incluye exactamente 5 secciones, en este orden: carga, financiero, ruta, whatIf, electivos.';
    expect(errorSecciones(['carga', 'financiero', 'ruta', 'whatIf', 'electivos'])).toBeNull();
    expect(errorSecciones(['carga', 'financiero', 'ruta', 'electivos'])).toBe(`Faltan las secciones whatIf. ${orden}`);
    expect(errorSecciones(['carga', 'financiero', 'ruta', 'whatIf', 'electivos', 'carga'])).toBe(`Sobran las secciones carga. ${orden}`);
    expect(errorSecciones(['financiero', 'carga', 'ruta', 'whatIf', 'electivos'])).toBe(`Las secciones no están en el orden pedido. ${orden}`);
  });

  it('el chat descarta códigos inexistentes', () => {
    const respuesta = parsearRespuesta('chat', { texto: 't', cursos: ['XX', '100000S61T'], preguntasSugeridas: ['¿?'] }, contexto);
    expect(respuesta.cursos).toEqual(['100000S61T']);
  });

  it('rechaza más de 3 acciones o 3 preguntas sugeridas', () => {
    const muchas = { ...seccion, acciones: ['1', '2', '3', '4'] };
    expect(() => parsearRespuesta('analisis', { resumen: 'r', secciones: [muchas, ...resto], preguntasSugeridas: [] }, contexto)).toThrow();
    expect(() => parsearRespuesta('chat', { texto: 't', cursos: [], preguntasSugeridas: ['1', '2', '3', '4'] }, contexto)).toThrow();
  });

  it('el proxy lee al modelo de forma tolerante: recorta, descarta y completa los campos no críticos (D-059)', () => {
    const codigos = Array.from({ length: 12 }, (_, indice) => `100000X${String(indice).padStart(3, '0')}`);
    const amplio = { ...contexto, catalogo: [...contexto.catalogo, ...codigos.map((codigo) => ({ ...contexto.catalogo[0], codigo }))] };
    const chat = parsearRespuesta('chat', { texto: 't', cursos: ['INVENTADO', ...codigos], preguntasSugeridas: ['1', '2', '3', '4'], extra: 1 }, amplio, true);
    expect(MAX_CURSOS).toBe(10);
    expect(chat).toEqual({ texto: 't', cursos: codigos.slice(0, MAX_CURSOS), preguntasSugeridas: ['1', '2', '3'] });
    expect(parsearRespuesta('chat', { texto: 't' }, contexto, true)).toEqual({ texto: 't', cursos: [], preguntasSugeridas: [] });
    expect(parsearRespuesta('chat', { texto: 't', cursos: 'no', preguntasSugeridas: [1, '¿?'] }, contexto, true))
      .toEqual({ texto: 't', cursos: [], preguntasSugeridas: ['¿?'] });
    // El texto sigue siendo obligatorio y no vacío.
    for (const malo of [{}, { texto: '' }, { texto: '   ' }, { texto: 3 }]) expect(() => parsearRespuesta('chat', malo, contexto, true)).toThrow();
    const larga = { ...seccion, acciones: ['1', '2', '3', '4'] };
    const analisis = parsearRespuesta('analisis', { resumen: 'r', secciones: [larga, ...resto], otra: true }, contexto, true);
    expect(analisis.secciones[0].acciones).toEqual(['1', '2', '3']);
    expect(analisis.preguntasSugeridas).toEqual([]);
    expect(() => parsearRespuesta('analisis', { resumen: ' ', secciones: [seccion, ...resto] }, contexto, true)).toThrow();
  });

  it('rechaza un tipo de sección o nivel desconocido', () => {
    const mala = { ...seccion, nivel: 'grave' };
    expect(() => parsearRespuesta('analisis', { resumen: 'r', secciones: [mala, ...resto], preguntasSugeridas: [] }, contexto)).toThrow();
  });

  it('genera el esquema JSON de cada modo para el prompt', () => {
    expect(JSON.stringify(esquemaRespuesta('analisis'))).toContain('secciones');
    expect(JSON.stringify(esquemaRespuesta('chat'))).toContain('texto');
  });
});

describe('Contratos IA - copia del proxy', () => {
  it('ai-proxy/src/contracts.ts es idéntico a src/application/ai/contracts.ts', () => {
    const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    expect(leer('../../ai-proxy/src/contracts.ts')).toBe(leer('../../src/application/ai/contracts.ts'));
  });
});
