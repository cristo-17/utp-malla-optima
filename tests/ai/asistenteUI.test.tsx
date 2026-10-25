import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Curso } from '../../src/types/academic';
import type { AIRequest } from '../../src/application/ai/contracts';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { buildAIContext } from '../../src/application/ai/buildAIContext';
import { crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { HttpAIClient, MENSAJES_ERROR, MockAIClient, type AIClient, type ResultadoIA } from '../../src/infrastructure/ai/HttpAIClient';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { AsistenteFab } from '../../src/components/ai/AsistenteFab';
import { PanelAdjuntar } from '../../src/components/ai/AsistenteEntrada';
import { AsistentePanel, TEXTO_PRIVACIDAD, type AccionesPanel } from '../../src/components/ai/AsistentePanel';
import {
  almacen, CLAVES_ASISTENTE, debeOcultarFab, filtrarCursos, opcionesAdjuntar, partirPorCodigos, type FocoUI,
} from '../../src/components/ai/asistenteLogica';
import {
  crearControladorAsistente, historialParaEnviar, type EstadoAsistente, type MensajeChat,
} from '../../src/components/ai/controladorAsistente';
import { crearContextoMinimo } from '../helpers/aiContexto';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const curso = (codigo: string, nombre: string, cambios: Partial<Curso> = {}): Curso => ({
  codigo, nombre, ciclo: 8, cicloOrigen: 8, tipoPeriodo: 'REGULAR', ubicacion: 'periodo',
  horasSemanales: 4, creditos: 4, tipo: 'OBLIGATORIO', prerrequisitos: [], estado: 'PENDIENTE', ...cambios,
});
const CURSOS = [
  curso('100000I62N', 'INTELIGENCIA DE NEGOCIOS'),
  curso('100000S71T', 'NEGOCIACIÓN Y NARRATIVA'),
  curso('100000S61T', 'HERRAMIENTAS DE DESARROLLO', { ciclo: 7, estado: 'EN_CURSO' }),
  curso('100000I0N2', 'MATEMÁTICA I', { ciclo: 1, estado: 'APROBADO' }),
  curso('100000I64M', 'CALIDAD DE SOFTWARE', { ubicacion: 'banco', tipo: 'ELECTIVO' }),
];
const opciones = opcionesAdjuntar(CURSOS, 7);
const nombres = new Map(CURSOS.map((item) => [item.codigo, item.nombre]));

const sinAccion = () => undefined;
const acciones: AccionesPanel = {
  onCerrar: sinAccion, onNuevaConversacion: sinAccion, onAceptarPrivacidad: sinAccion, onCancelarPrivacidad: sinAccion,
  onAnalizar: sinAccion, onPresupuesto: sinAccion, onPreguntar: sinAccion, onReintentar: sinAccion,
  onAlternarPanel: sinAccion, onCerrarPanel: sinAccion, onElegirFoco: sinAccion, onQuitarFoco: sinAccion,
};
const estadoBase = (cambios: Partial<EstadoAsistente> = {}): EstadoAsistente => ({
  mensajes: [], enviando: false, privacidadAceptada: true, foco: null, focoEnviado: false, panel: null, presupuesto: '', ...cambios,
});
const renderPanel = (estado: EstadoAsistente, extra: { enLinea?: boolean; tooltip?: boolean } = {}) => renderToStaticMarkup(
  <AsistentePanel {...acciones} estado={estado} enLinea={extra.enLinea ?? true} nombres={nombres} opciones={opciones}
    mostrarTooltipRapidas={extra.tooltip ?? false} />);

/** Cliente de prueba que guarda las peticiones y responde en orden. */
const clienteFalso = (...resultados: ResultadoIA[]) => {
  const peticiones: AIRequest[] = [];
  const cliente: AIClient = {
    esMock: true,
    enviar: vi.fn(async (peticion: AIRequest) => {
      peticiones.push(peticion);
      return resultados.shift() ?? { ok: true, respuesta: { texto: 'ok', cursos: [], preguntasSugeridas: [] } };
    }),
  };
  return { cliente, peticiones };
};
const contextoMinimo = crearContextoMinimo();

afterEach(() => vi.unstubAllGlobals());

describe('Asistente - render', () => {
  it('el panel es un diálogo accesible con cabecera, estado y bienvenida', () => {
    const html = renderPanel(estadoBase());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="ia-titulo"');
    expect(html).toContain('Asistente académico IA');
    expect(html).toContain('En línea');
    expect(html).toContain('aria-label="Nueva conversación"');
    expect(html).toContain('aria-label="Cerrar asistente"');
    expect(html).toContain('Presupuesto mensual (S/)');
    expect(html).toContain('Analizar mi plan');
    expect(html).toContain('Toca 😊 para ver preguntas rápidas o 📎 para preguntar por un ciclo o curso.');
  });

  it('la barra va en orden 📎, 😊, input y enviar; el input admite 1000 caracteres', () => {
    const html = renderPanel(estadoBase());
    const posiciones = ['Preguntar sobre un ciclo o curso', 'aria-label="Preguntas rápidas"', 'aria-label="Escribe tu pregunta"', 'aria-label="Enviar"']
      .map((texto) => html.indexOf(texto));
    expect(posiciones.every((posicion) => posicion > 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    expect(html).toContain('maxLength="1000"');
  });

  it('muestra "escribiendo…" mientras espera', () => {
    expect(renderPanel(estadoBase({ enviando: true }))).toContain('escribiendo…');
    expect(renderPanel(estadoBase())).not.toContain('escribiendo…');
  });

  it('el texto de la IA es texto plano con saltos de línea, nunca HTML', () => {
    const mensajes: MensajeChat[] = [{ id: 1, rol: 'assistant', tipo: 'texto', texto: '<b>hola</b>\n<img src=x onerror=alert(1)>', cursos: [], preguntas: [] }];
    const html = renderPanel(estadoBase({ mensajes }));
    expect(html).toContain('&lt;b&gt;hola&lt;/b&gt;<br/>&lt;img');
    expect(html).not.toContain('<b>hola');
    expect(html).not.toContain('<img');
  });

  it('el análisis se muestra en tarjetas con el color de su nivel, códigos resaltados y chips', () => {
    const mensajes: MensajeChat[] = [{
      id: 1, rol: 'assistant', tipo: 'analisis', analisis: {
        resumen: 'Revisé tu plan.',
        secciones: [
          { tipo: 'carga', nivel: 'riesgo', titulo: 'Carga muy alta', detalle: 'Lleva 100000I62N con cuidado.', acciones: ['Mueve un curso.'], cursos: ['100000I62N'] },
          { tipo: 'financiero', nivel: 'ok', titulo: 'Costo', detalle: 'S/ 5,055.15', acciones: [], cursos: [] },
        ],
        preguntasSugeridas: ['¿Estoy sobrecargado?'],
      },
    }];
    const html = renderPanel(estadoBase({ mensajes }));
    expect(html).toContain('ia-seccion ia-nivel-riesgo');
    expect(html).toContain('ia-seccion ia-nivel-ok');
    expect(html).toContain('<mark class="ia-codigo">100000I62N</mark>');
    expect(html).toContain('INTELIGENCIA DE NEGOCIOS');
    expect(html).toContain('Riesgo');
    expect(html).toContain('aria-label="Preguntas sugeridas"');
    expect(html).toContain('¿Estoy sobrecargado?');
  });

  it('partirPorCodigos solo resalta los códigos dados', () => {
    expect(partirPorCodigos('A 100000I62N y XX', ['100000I62N'])).toEqual([
      { texto: 'A ', codigo: false }, { texto: '100000I62N', codigo: true }, { texto: ' y XX', codigo: false },
    ]);
  });
});

describe('Asistente - saludo de una sola vez', () => {
  it('el botón muestra el saludo junto a él solo cuando se pide', () => {
    const con = renderToStaticMarkup(<AsistenteFab oculto={false} mostrarSaludo onAbrir={sinAccion} onCerrarSaludo={sinAccion} />);
    expect(con).toContain('¡Hola! ¿Te ayudo a planificar tu matrícula?');
    expect(con).toContain('aria-label="Cerrar saludo"');
    expect(con).toContain('aria-label="Abrir asistente académico IA"');
    const sin = renderToStaticMarkup(<AsistenteFab oculto={false} mostrarSaludo={false} onAbrir={sinAccion} onCerrarSaludo={sinAccion} />);
    expect(sin).not.toContain('¡Hola!');
  });

  it('se recuerda en localStorage: la segunda visita ya no lo muestra', () => {
    const datos = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (clave: string) => datos.get(clave) ?? null, setItem: (clave: string, valor: string) => datos.set(clave, valor) } });
    expect(almacen.leer(CLAVES_ASISTENTE.saludo)).toBe(false);
    almacen.guardar(CLAVES_ASISTENTE.saludo);
    expect(almacen.leer(CLAVES_ASISTENTE.saludo)).toBe(true);
  });

  it('si localStorage falla no rompe (try/catch)', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } } });
    expect(almacen.leer(CLAVES_ASISTENTE.saludo)).toBe(false);
    expect(() => almacen.guardar(CLAVES_ASISTENTE.saludo)).not.toThrow();
  });
});

describe('Asistente - aviso de privacidad', () => {
  it('sin aceptar se muestra el aviso con Aceptar y Cancelar, sin barra de entrada', () => {
    const html = renderPanel(estadoBase({ privacidadAceptada: false }));
    expect(html).toContain(TEXTO_PRIVACIDAD);
    expect(html).toContain('>Aceptar<');
    expect(html).toContain('>Cancelar<');
    expect(html).not.toContain('aria-label="Escribe tu pregunta"');
    expect(html).not.toContain('Analizar mi plan');
  });

  it('sin aceptar no se envía nada; al aceptar se recuerda y ya se puede enviar', async () => {
    const { cliente } = clienteFalso();
    const alAceptarPrivacidad = vi.fn();
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, alAceptarPrivacidad });
    await controlador.preguntar('Hola');
    await controlador.analizar();
    expect(cliente.enviar).not.toHaveBeenCalled();
    expect(controlador.obtener().mensajes).toEqual([]);
    controlador.aceptarPrivacidad();
    expect(alAceptarPrivacidad).toHaveBeenCalledOnce();
    await controlador.preguntar('¿Estoy sobrecargado?');
    expect(cliente.enviar).toHaveBeenCalledOnce();
  });
});

describe('Asistente - paneles 😊 y 📎', () => {
  it('😊 muestra "Preguntas rápidas" con sus 6 chips, "Armar mi plan con límites" y el tooltip la primera vez', () => {
    const html = renderPanel(estadoBase({ panel: 'rapidas' }), { tooltip: true });
    expect(html).toContain('id="ia-panel-rapidas" role="group" aria-label="Preguntas rápidas"');
    for (const texto of ['¿Me alcanza mi presupuesto?', '¿Estoy sobrecargado?', '¿Qué pasa si jalo un curso?', 'Mi ruta hasta egresar',
      '¿Qué electivo me conviene?', '¿Cómo funcionan los descuentos de la UTP?']) {
      expect(html).toContain(texto);
    }
    for (const emoji of ['💰', '😰', '🔀', '🗺️', '🎯', '💸']) expect(html).toContain(emoji);
    // Sin Autogenerar disponible no se ofrece la acción; con él, sí.
    expect(html).not.toContain('Armar mi plan con límites');
    const conAccion = renderToStaticMarkup(<AsistentePanel {...acciones} estado={estadoBase({ panel: 'rapidas' })} enLinea nombres={nombres}
      opciones={opciones} mostrarTooltipRapidas={false} onAutogenerar={sinAccion} />);
    expect(conAccion).toContain('🗓️');
    expect(conAccion).toContain('Armar mi plan con límites');
    expect(html).toContain('role="tooltip"');
    expect(renderPanel(estadoBase({ panel: 'rapidas' }))).not.toContain('role="tooltip"');
  });

  it('📎 muestra "Preguntar sobre…" con plan completo, un ciclo y un curso', () => {
    const html = renderPanel(estadoBase({ panel: 'adjuntar' }));
    expect(html).toContain('aria-label="Preguntar sobre…"');
    expect(html).toContain('Mi plan completo');
    expect(html).toContain('Un ciclo');
    expect(html).toContain('Un curso');
  });

  it('📎 lista los periodos planificados y los cursos con buscador', () => {
    expect(opciones.periodos).toEqual([{ id: 'ciclo-8', etiqueta: 'Ciclo 8', cursos: 2 }]);
    const ciclos = renderToStaticMarkup(<PanelAdjuntar opciones={opciones} onElegir={sinAccion} vistaInicial="ciclos" />);
    expect(ciclos).toContain('Ciclo 8');
    const cursos = renderToStaticMarkup(<PanelAdjuntar opciones={opciones} onElegir={sinAccion} vistaInicial="cursos" />);
    expect(cursos).toContain('aria-label="Buscar curso"');
    expect(cursos).toContain('INTELIGENCIA DE NEGOCIOS');
    expect(cursos).not.toContain('MATEMÁTICA I');
    expect(filtrarCursos(opciones.cursos, 'negociacion').map((item) => item.codigo)).toEqual(['100000S71T']);
    expect(filtrarCursos(opciones.cursos, 'i62n').map((item) => item.codigo)).toEqual(['100000I62N']);
  });

  it.each([
    [{ tipo: 'ciclo', id: 'ciclo-8', etiqueta: 'Ciclo 8' }, '📎 Ciclo 8', '¿Estoy sobrecargado en este ciclo?'],
    [{ tipo: 'curso', id: '100000I62N', etiqueta: 'INTELIGENCIA DE NEGOCIOS' }, '📎 INTELIGENCIA DE NEGOCIOS', '¿Me conviene llevarlo ahora?'],
  ] as [FocoUI, string, string][])('con foco aparece el chip quitable y 3 preguntas: %s', (foco, chip, pregunta) => {
    const html = renderPanel(estadoBase({ foco }));
    expect(html).toContain(chip);
    expect(html).toContain(`aria-label="Quitar ${foco.etiqueta}"`);
    expect(html).toContain(pregunta);
    expect(html.match(/aria-label="Preguntas sobre el foco"[\s\S]*?<\/div>/)![0].match(/class="ia-chip"/g)).toHaveLength(3);
  });

  it('el controlador alterna los paneles y los cierra al enviar o al elegir foco', async () => {
    const { cliente } = clienteFalso();
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    controlador.alternarPanel('rapidas');
    expect(controlador.obtener().panel).toBe('rapidas');
    controlador.alternarPanel('adjuntar');
    expect(controlador.obtener().panel).toBe('adjuntar');
    controlador.setFoco({ tipo: 'ciclo', id: 'ciclo-8', etiqueta: 'Ciclo 8' });
    expect(controlador.obtener().panel).toBeNull();
    controlador.alternarPanel('rapidas');
    const envio = controlador.preguntar('¿Estoy sobrecargado?');
    expect(controlador.obtener().panel).toBeNull();
    await envio;
  });
});

describe('Asistente - envío del foco', () => {
  it('con un curso adjunto, AIRequest.foco y el contexto llevan ese curso (Excel real)', async () => {
    const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
    await store.getState().setTarifario(FinancialConfigurationProvider.load());
    await store.getState().setContextoAcademico('marzo', 7);
    const fixture = fileURLToPath(new URL('../fixtures/Plan_de_Estudio_1.xlsx', import.meta.url));
    await store.getState().setCursos(await parseUTPExcel(new File([readFileSync(fixture)], 'Plan_de_Estudio_1.xlsx')), 'Plan_de_Estudio_1.xlsx');
    await store.getState().moverCursoAPeriodo('100000I62N', crearPeriodoRegular(8));

    const { cliente, peticiones } = clienteFalso();
    const controlador = crearControladorAsistente({
      cliente, privacidadAceptada: true, obtenerContexto: (opciones) => buildAIContext(store.getState(), opciones),
    });
    controlador.setPresupuesto('900');
    controlador.setFoco({ tipo: 'curso', id: '100000I62N', etiqueta: 'INTELIGENCIA DE NEGOCIOS' });
    await controlador.preguntar('¿Qué pasa si lo jalo?');

    const [peticion] = peticiones;
    expect(peticion.modo).toBe('chat');
    expect(peticion.foco).toEqual({ tipo: 'curso', id: '100000I62N' });
    expect(peticion.contexto.foco).toMatchObject({ tipo: 'curso', codigo: '100000I62N' });
    expect(peticion.contexto.financiero?.presupuestoMensual).toBe(900);
    expect(peticion.mensajes).toEqual([{ rol: 'user', texto: '¿Qué pasa si lo jalo?' }]);
    expect(JSON.stringify(peticion)).not.toContain('Plan_de_Estudio');
    expect(controlador.obtener().mensajes[0]).toMatchObject({ rol: 'user', foco: { etiqueta: 'INTELIGENCIA DE NEGOCIOS' } });
  });

  it('"Mi plan completo" se envía como foco plan y quitar el foco ya no lo envía', async () => {
    const { cliente, peticiones } = clienteFalso();
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    controlador.setFoco({ tipo: 'plan', etiqueta: 'Mi plan completo' });
    await controlador.preguntar('¿Cómo ves mi plan?');
    controlador.setFoco(null);
    await controlador.preguntar('Hola');
    expect(peticiones[0].foco).toEqual({ tipo: 'plan' });
    expect('foco' in peticiones[1]).toBe(false);
  });

  it('al servidor van solo los últimos 8 mensajes y "Nueva conversación" borra el historial', async () => {
    const { cliente, peticiones } = clienteFalso();
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    for (let indice = 1; indice <= 6; indice += 1) await controlador.preguntar(`pregunta ${indice}`);
    expect(peticiones.at(-1)!.mensajes).toHaveLength(8);
    expect(peticiones.at(-1)!.mensajes.at(-1)).toEqual({ rol: 'user', texto: 'pregunta 6' });
    expect(historialParaEnviar(controlador.obtener().mensajes)).toHaveLength(8);
    controlador.nuevaConversacion();
    expect(controlador.obtener().mensajes).toEqual([]);
    await controlador.preguntar('otra');
    expect(peticiones.at(-1)!.mensajes).toEqual([{ rol: 'user', texto: 'otra' }]);
  });

  it('el análisis usa el modo analisis', async () => {
    const { cliente, peticiones } = clienteFalso();
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    await controlador.analizar();
    expect(peticiones[0]).toMatchObject({ modo: 'analisis', mensajes: [{ rol: 'user', texto: 'Analizar mi plan' }] });
  });
});

describe('Asistente - sin conexión', () => {
  it('el estado dice "Sin conexión", el input queda deshabilitado y aparece el aviso', () => {
    const html = renderPanel(estadoBase({ panel: 'rapidas' }), { enLinea: false });
    expect(html).toContain('ia-punto sin-conexion');
    expect(html).toContain('Sin conexión: el asistente necesita internet');
    expect(html).toMatch(/<input[^>]*class="ia-input"[^>]*disabled=""/);
    expect(html).not.toContain('id="ia-panel-rapidas"');
  });

  it('sin conexión el cliente no llama y la burbuja muestra el error', async () => {
    const fetch = vi.fn();
    const cliente = new HttpAIClient({ endpoint: 'https://x/api', fetch, enLinea: () => false });
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    await controlador.preguntar('Hola');
    expect(fetch).not.toHaveBeenCalled();
    expect(controlador.obtener().mensajes.at(-1)).toMatchObject({ tipo: 'error', error: 'SIN_CONEXION' });
  });
});

describe('Asistente - error con Reintentar', () => {
  it('muestra el error en una burbuja con "Reintentar" y al reintentar se reemplaza por la respuesta', async () => {
    const { cliente, peticiones } = clienteFalso(
      { ok: false, error: 'LIMITE', mensaje: MENSAJES_ERROR.LIMITE },
      { ok: true, respuesta: { texto: 'Ahora sí.', cursos: [], preguntasSugeridas: [] } },
    );
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    controlador.setFoco({ tipo: 'curso', id: '100000I62N', etiqueta: 'INTELIGENCIA DE NEGOCIOS' });
    await controlador.preguntar('¿Cuánto me cuesta?');
    const error = controlador.obtener().mensajes.at(-1)!;
    expect(error).toMatchObject({ tipo: 'error', error: 'LIMITE' });

    const html = renderPanel(controlador.obtener());
    expect(html).toContain('role="alert"');
    expect(html).toContain(MENSAJES_ERROR.LIMITE);
    expect(html).toContain('Reintentar');

    controlador.setFoco(null);
    await controlador.reintentar(error.id);
    const mensajes = controlador.obtener().mensajes;
    expect(mensajes.map((mensaje) => mensaje.rol === 'user' ? mensaje.texto : mensaje.tipo)).toEqual(['¿Cuánto me cuesta?', 'texto']);
    // El reintento conserva el foco de la pregunta original.
    expect(peticiones[1].foco).toEqual({ tipo: 'curso', id: '100000I62N' });
  });
});

describe('Asistente - descarte de códigos inexistentes', () => {
  it('un código que no está en el contexto no llega a la conversación ni se resalta', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      texto: 'Revisa 100000I62N y FALSO99.', cursos: ['100000I62N', 'FALSO99'], preguntasSugeridas: [],
    })));
    const cliente = new HttpAIClient({ endpoint: 'https://x/api', fetch, enLinea: () => true });
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: () => contextoMinimo, privacidadAceptada: true });
    await controlador.preguntar('¿Qué llevo?');
    expect(controlador.obtener().mensajes.at(-1)).toMatchObject({ tipo: 'texto', cursos: ['100000I62N'] });
    const html = renderPanel(controlador.obtener());
    expect(html).toContain('<mark class="ia-codigo">100000I62N</mark>');
    expect(html).not.toContain('<mark class="ia-codigo">FALSO99</mark>');
  });

  it('el mock local también responde dentro del contrato', async () => {
    const controlador = crearControladorAsistente({
      cliente: new MockAIClient({ esperaMs: 0, enLinea: () => true }), obtenerContexto: () => contextoMinimo, privacidadAceptada: true,
    });
    await controlador.analizar();
    const ultimo = controlador.obtener().mensajes.at(-1)!;
    expect(ultimo).toMatchObject({ rol: 'assistant', tipo: 'analisis' });
  });
});

describe('Asistente - ocultamiento del botón', () => {
  const visible = { arrastrando: false, cursoAMover: null, panelAbierto: false, estrategiaAbierta: false };

  it.each([
    ['mientras se arrastra un curso', { arrastrando: true }],
    ['con la barra "Moviendo curso"', { cursoAMover: '100000I62N' }],
    ['con el panel abierto', { panelAbierto: true }],
    ['con el drawer Estrategia abierto', { estrategiaAbierta: true }],
  ])('se oculta %s', (_caso, cambios) => {
    expect(debeOcultarFab(visible)).toBe(false);
    expect(debeOcultarFab({ ...visible, ...cambios })).toBe(true);
  });

  it('oculto no renderiza nada (ni el saludo)', () => {
    expect(renderToStaticMarkup(<AsistenteFab oculto mostrarSaludo onAbrir={sinAccion} onCerrarSaludo={sinAccion} />)).toBe('');
  });
});
