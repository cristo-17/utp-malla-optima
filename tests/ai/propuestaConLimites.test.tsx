import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { AIContextSchema } from '../../src/application/ai/contracts';
import { buildAIContext } from '../../src/application/ai/buildAIContext';
import { detectarLimites, opcionesDePropuesta } from '../../src/application/ai/limites';
import { generarRespuestaMock } from '../../src/application/ai/mockRespuestas';
import { AsistenteMensajes } from '../../src/components/ai/AsistenteMensajes';
import { crearControladorAsistente, type MensajeChat } from '../../src/components/ai/controladorAsistente';
import { crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import type { AIClient } from '../../src/infrastructure/ai/HttpAIClient';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const FIXTURE = fileURLToPath(new URL('../fixtures/Plan_de_Estudio_1.xlsx', import.meta.url));
const CURSOS_OCTAVO = ['100000S06I', '100000S72T', '100000S73T', '100000H01C', '100000TD09', '100000I62N', '100000S71T'];

const crearStore = async () => {
  const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico('marzo', 7);
  await store.getState().setCursos(await parseUTPExcel(new File([readFileSync(FIXTURE)], 'Plan_de_Estudio_1.xlsx')));
  for (const codigo of CURSOS_OCTAVO) await store.getState().moverCursoAPeriodo(codigo, crearPeriodoRegular(8));
  return store;
};
type Store = Awaited<ReturnType<typeof crearStore>>;
const contextoCon = (store: Store, mensaje: string) =>
  buildAIContext(store.getState(), { presupuestoMensual: 900, limites: detectarLimites(mensaje) });

describe('CONTEXTO.propuestaConLimites (buildAIContext con detectarLimites)', () => {
  let store: Store;
  beforeAll(async () => { store = await crearStore(); });

  it('sin límites en el mensaje es null', () => {
    expect(buildAIContext(store.getState()).propuestaConLimites).toBeNull();
    expect(contextoCon(store, '¿Me alcanza mi presupuesto?').propuestaConLimites).toBeNull();
  });

  it('"menos de 20h": reordena hasta egresar con 20 h, cada periodo bajo el tope, y no se aplica a la malla', () => {
    const contexto = contextoCon(store, 'Quiero armar un plan que tenga menos de 20h semanales');
    expect(AIContextSchema.parse(contexto)).toEqual(contexto);
    const propuesta = contexto.propuestaConLimites!;
    expect(propuesta.limites).toMatchObject({ maxHorasPorPeriodo: 20, horasAplicadas: 20, alcance: 'hastaEgresar' });
    expect(propuesta.aplicadaEnMalla).toBe(false);
    // El 8vo que ubicó el alumno tenía 25 h: la propuesta lo reordena.
    expect(propuesta.periodos.map((item) => [item.periodoId, item.numeroCursos, item.horas]))
      .toEqual([['ciclo-8', 5, 19], ['ciclo-9', 7, 20], ['ciclo-10', 5, 20], ['ciclo-11', 3, 9]]);
    expect(propuesta.ciclosAgregados).toEqual([11]);
    expect(propuesta.periodos[0].cuotaMensual).toBe(815);
    // La malla del alumno no cambió.
    expect(contexto.periodosPlanificados.map((item) => item.horas)).toEqual([25]);
  });

  it('"menos de 18 créditos": ningún periodo pasa de 18', () => {
    const { periodos, limites } = contextoCon(store, 'Quiero que ordenes mis ciclos restantes con menos de 18 créditos').propuestaConLimites!;
    expect(limites.creditosAplicados).toBe(18);
    expect(periodos.every((item) => item.creditos <= 18)).toBe(true);
  });

  it('"900 soles": 24 h por la escala y 7 cursos en el Ciclo 8', () => {
    const { periodos, limites } = contextoCon(store, 'arma un plan con 900 soles de presupuesto mensual').propuestaConLimites!;
    expect(limites).toMatchObject({ maxCuotaMensual: 900, horasPorCuota: 24, horasAplicadas: 24, metodoPago: 'sin_descuento' });
    expect(periodos[0]).toMatchObject({ periodoId: 'ciclo-8', numeroCursos: 7, horas: 24, cuotaMensual: 892.62 });
  });

  it('"agrego otro ciclo": reparte en un ciclo más que sin límites, con las horas mínimas que lo permiten', () => {
    const sinLimites = contextoCon(store, 'Quiero armar un plan que tenga menos de 22h semanales').propuestaConLimites!;
    const { limites, cicloEgreso } = contextoCon(store, 'y qué pasa si agrego otro ciclo?').propuestaConLimites!;
    expect(limites.agregarCiclo).toBe(true);
    expect(cicloEgreso).toBe(sinLimites.cicloEgreso! + 1);
    expect(limites.horasAplicadas).toBeLessThan(22);
    const unaHoraMenos = buildAIContext(store.getState(), { limites: { ...detectarLimites('máximo 1 h')!, maxHorasPorPeriodo: limites.horasAplicadas - 1 } })
      .propuestaConLimites!;
    expect(unaHoraMenos.cicloEgreso).toBeGreaterThan(cicloEgreso!);
  });

  it('un solo ciclo nombrado (el próximo) arma solo ese periodo', () => {
    const { periodos, limites } = contextoCon(store, 'arma el ciclo 8 con menos de 20 h').propuestaConLimites!;
    expect(limites.alcance).toBe('proximoPeriodo');
    expect(periodos.map((item) => item.periodoId)).toEqual(['ciclo-8']);
  });

  it('opcionesDePropuesta: lo que abre la vista previa de Autogenerar', () => {
    const propuesta = contextoCon(store, 'Quiero armar un plan que tenga menos de 20h semanales').propuestaConLimites!;
    expect(opcionesDePropuesta(propuesta)).toEqual({
      alcance: 'hastaEgresar', maxHorasPorPeriodo: 20, maxCreditosPorPeriodo: null, maxCuotaMensual: null,
      usarVeranos: false, conservarUbicados: false,
    });
  });

  it('el mock explica la propuesta por periodo y nombra el botón, sin aplicar nada', () => {
    const contexto = contextoCon(store, 'Quiero armar un plan que tenga menos de 20h semanales');
    const respuesta = generarRespuestaMock({ modo: 'chat', contexto, mensajes: [{ rol: 'user', texto: 'Quiero armar un plan que tenga menos de 20h semanales' }] });
    expect('texto' in respuesta && respuesta.texto).toContain('Ciclo 8: 5 cursos (19 h)');
    expect('texto' in respuesta && respuesta.texto).toContain('Necesitas 1 ciclo más.');
    expect('texto' in respuesta && respuesta.texto).toContain('«Aplicar a mi malla»');
  });
});

describe('Chat: "Aplicar a mi malla" debajo de una respuesta con propuesta', () => {
  it('el controlador manda el mensaje a obtenerContexto y guarda las opciones de la propuesta en la respuesta', async () => {
    const store = await crearStore();
    const cliente: AIClient = { esMock: true, enviar: vi.fn(async () => ({ ok: true as const, respuesta: { texto: 'ok', cursos: [], preguntasSugeridas: [] } })) };
    const pedidos: (string | undefined)[] = [];
    const controlador = crearControladorAsistente({
      cliente, privacidadAceptada: true,
      obtenerContexto: ({ mensaje, ...opciones }) => {
        pedidos.push(mensaje);
        return buildAIContext(store.getState(), { ...opciones, limites: mensaje ? detectarLimites(mensaje) : null });
      },
    });
    await controlador.preguntar('Quiero armar un plan que tenga menos de 20h semanales');
    await controlador.preguntar('¿Estoy sobrecargado?');
    await controlador.analizar();
    expect(pedidos).toEqual(['Quiero armar un plan que tenga menos de 20h semanales', '¿Estoy sobrecargado?', undefined]);
    const respuestas = controlador.obtener().mensajes.filter((mensaje) => mensaje.rol === 'assistant' && mensaje.tipo === 'texto');
    expect(respuestas.map((mensaje) => 'propuesta' in mensaje ? mensaje.propuesta?.maxHorasPorPeriodo : undefined)).toEqual([20, undefined, undefined]);
  });

  it('el botón aparece solo en la respuesta con propuesta', () => {
    const mensajes: MensajeChat[] = [
      { id: 1, rol: 'assistant', tipo: 'texto', texto: 'Así queda tu plan.', cursos: [], preguntas: [],
        propuesta: { alcance: 'hastaEgresar', maxHorasPorPeriodo: 20, maxCreditosPorPeriodo: null, maxCuotaMensual: null, usarVeranos: false, conservarUbicados: false } },
      { id: 2, rol: 'assistant', tipo: 'texto', texto: 'Sin propuesta.', cursos: [], preguntas: [] },
    ];
    const html = renderToStaticMarkup(<AsistenteMensajes mensajes={mensajes} nombres={new Map()} enviando={false} deshabilitado={false}
      onPreguntar={() => undefined} onReintentar={() => undefined} onAplicarPropuesta={() => undefined} />);
    expect(html.match(/Aplicar a mi malla/g)).toHaveLength(1);
    expect(html.indexOf('Aplicar a mi malla')).toBeLessThan(html.indexOf('Sin propuesta.'));
  });
});
