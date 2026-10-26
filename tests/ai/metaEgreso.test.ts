import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import type { AIRequest } from '../../src/application/ai/contracts';
import { AIContextSchema } from '../../src/application/ai/contracts';
import { buildAIContext } from '../../src/application/ai/buildAIContext';
import { detectarLimites, opcionesDeMeta } from '../../src/application/ai/limites';
import { cadenaMasLarga, metaEgresoUseCase, type VarianteMeta } from '../../src/application/usecases/metaEgresoUseCase';
import { crearControladorAsistente } from '../../src/components/ai/controladorAsistente';
import { obtenerPeriodoCurso } from '../../src/domain/rules/academicPeriodRules';
import { FACTOR_HORAS_VERANO, LIMITE_CREDITOS_PERIODO, LIMITE_CREDITOS_VERANO } from '../../src/domain/rules/planningRules';
import { motivoPlanificadoInvalido } from '../../src/domain/services/prerequisiteService';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import type { AIClient } from '../../src/infrastructure/ai/HttpAIClient';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const leer = (nombre: string) => new File(
  [readFileSync(fileURLToPath(new URL(`../fixtures/${nombre}`, import.meta.url)))], nombre);

const crearStore = async () => {
  const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico('marzo', 7);
  await store.getState().setCursos(await parseUTPExcel(leer('Plan_de_Estudio_1.xlsx')));
  return store;
};
type Store = Awaited<ReturnType<typeof crearStore>>;

const meta = (store: Store, ciclo: number, veranos = true) => {
  const s = store.getState();
  return metaEgresoUseCase({
    cursos: s.cursos, totalCiclos: s.totalCiclos, ciclosExcluidos: s.ciclosExcluidos, cicloActual: s.cicloActual,
    periodoIngreso: s.periodoIngreso, tarifario: s.tarifario, disciplina: s.disciplinaActiva, metodoPago: s.metodoPago,
  }, ciclo, veranos);
};

const resumen = (variante: VarianteMeta | null) => variante && {
  horas: variante.horasMaximasNecesarias,
  cicloEgreso: variante.propuesta.cicloEgreso,
  veranos: variante.propuesta.veranosUsados,
  costo: variante.propuesta.costoTotalHastaEgresar,
  periodos: variante.propuesta.periodos.map(({ periodo, cursos, horas, creditos }) => [periodo.id, cursos.length, horas, creditos]),
};

/** El plan respeta los prerrequisitos, el tope de horas, los 11 créditos de un verano y creditosMaximos por ciclo. */
const respetaReglas = (store: Store, variante: VarianteMeta) => {
  const { propuesta, horasMaximasNecesarias } = variante;
  expect(propuesta.noPlanificados).toEqual([]);
  expect(propuesta.cursos.filter((curso) => motivoPlanificadoInvalido(curso, propuesta.cursos, store.getState()))).toEqual([]);
  for (const { periodo, horas, creditos } of propuesta.periodos) {
    expect(horas, periodo.id).toBeLessThanOrEqual(horasMaximasNecesarias);
    expect(creditos, periodo.id).toBeLessThanOrEqual(periodo.tipo === 'VERANO' ? LIMITE_CREDITOS_VERANO : LIMITE_CREDITOS_PERIODO);
  }
};

describe('Meta de egreso con el Excel real (ingreso marzo, ciclo actual 7)', () => {
  it('Ciclo 9 sin veranos: sí, con 34 h por periodo (carga pesada); con una hora menos ya no llega', async () => {
    const store = await crearStore();
    const resultado = meta(store, 9, false);
    expect(resultado.sePuede).toBe(true);
    expect(resumen(resultado.sinVeranos)).toEqual({
      horas: 34, cicloEgreso: 9, veranos: [], costo: 13603.2,
      periodos: [['ciclo-8', 9, 34, 29], ['ciclo-9', 11, 34, 31]],
    });
    expect(resultado.elegida).toBe(resultado.sinVeranos);
    expect(resultado.conVeranos).toBeNull();
    respetaReglas(store, resultado.sinVeranos!);
    // 33 h ya no alcanza: es el menor máximo.
    const conMenos = store.getState().previsualizarPlanificacionOptima({ maxHorasPorPeriodo: 33, conservarUbicados: false, cicloMeta: 9 });
    expect(conMenos.cicloEgreso).toBeGreaterThan(9);
  });

  it('Ciclo 9 con veranos: con el Verano 8 bastan 28 h por periodo y cuesta menos (S/ 13,180.22)', async () => {
    const store = await crearStore();
    const resultado = meta(store, 9);
    expect(resultado.elegida).toBe(resultado.sinVeranos);
    expect(resumen(resultado.conVeranos)).toEqual({
      horas: 28, cicloEgreso: 9, veranos: ['verano-8'], costo: 13180.22,
      periodos: [['ciclo-8', 8, 28, 25], ['verano-8', 4, 28, 11], ['ciclo-9', 8, 26, 24]],
    });
    respetaReglas(store, resultado.conVeranos!);
    // En el verano, 28 h efectivas son 14 h de clase (factor 2) y no pasa de 11 créditos.
    const verano = resultado.conVeranos!.propuesta.cursos.filter((curso) => curso.ubicacion === 'periodo' && curso.tipoPeriodo === 'VERANO' &&
      curso.estado === 'PENDIENTE' && obtenerPeriodoCurso(curso).id === 'verano-8');
    expect(verano.reduce((suma, curso) => suma + curso.horasSemanales, 0) * FACTOR_HORAS_VERANO).toBe(28);
  });

  it('Ciclo 8: no se puede (la cadena INTELIGENCIA DE NEGOCIOS → su siguiente necesita 2 periodos); lo más cercano es el 9', async () => {
    const store = await crearStore();
    const resultado = meta(store, 8);
    expect(resultado).toMatchObject({ sePuede: false, elegida: null, cicloMasCercano: 9 });
    expect(resultado.motivo).toMatchObject({ tipo: 'CADENA_PRERREQUISITOS', periodosNecesarios: 2, periodosDisponibles: 1 });
    expect(resultado.motivo?.tipo === 'CADENA_PRERREQUISITOS' && resultado.motivo.cadena.map((curso) => curso.codigo))
      .toEqual(['100000I62N', '100000S09I']);
    expect(cadenaMasLarga(store.getState().cursos)).toHaveLength(2);
  });

  it('Ciclo 11: sí, con carga normal (18 h por periodo, sin veranos ni periodos de más de 24 h)', async () => {
    const store = await crearStore();
    const resultado = meta(store, 11);
    expect(resumen(resultado.sinVeranos)).toMatchObject({ horas: 18, cicloEgreso: 11, veranos: [], costo: 17443.75 });
    expect(resultado.elegida!.propuesta.periodos.every((periodo) => periodo.horas <= 22)).toBe(true);
    respetaReglas(store, resultado.elegida!);
  });
});

describe('CONTEXTO.metaEgreso (R3)', () => {
  it('"Quiero terminar mi carrera en el ciclo 9, se puede?": sePuede, 34 h, carga pesada, la opción con veranos y el costo', async () => {
    const store = await crearStore();
    const contexto = buildAIContext(store.getState(), { limites: detectarLimites('Quiero terminar mi carrera en el ciclo 9, se puede?') });
    expect(AIContextSchema.parse(contexto)).toEqual(contexto);
    expect(contexto.propuestaConLimites).toBeNull();
    expect(contexto.metaEgreso).toMatchObject({
      cicloMeta: 9, sePuede: true, horasMaximasNecesarias: 34, usaVeranos: false, veranosUsados: [], cicloEgreso: 9,
      costoTotalHastaEgresar: 13603.2, horasRecomendadas: 24, periodosCargaPesada: ['ciclo-8', 'ciclo-9'],
      conVeranos: { horasMaximasNecesarias: 28, veranosUsados: ['verano-8'], costoTotalHastaEgresar: 13180.22 },
      motivo: null, cicloMasCercano: 9, aplicadaEnMalla: false,
    });
    expect(contexto.metaEgreso?.periodos.map(({ periodoId, numeroCursos, horas, creditos, cuotaMensual }) =>
      [periodoId, numeroCursos, horas, creditos, cuotaMensual])).toEqual([['ciclo-8', 9, 34, 29, 1280.72], ['ciclo-9', 11, 34, 31, 1280.72]]);
  });

  it('"¿Puedo egresar en el ciclo 8?": no, con el motivo y el ciclo más cercano; "en 4 ciclos" es el Ciclo 11', async () => {
    const store = await crearStore();
    const ocho = buildAIContext(store.getState(), { limites: detectarLimites('¿Puedo egresar en el ciclo 8?') }).metaEgreso;
    expect(ocho).toMatchObject({
      cicloMeta: 8, sePuede: false, horasMaximasNecesarias: null, periodos: [], costoTotalHastaEgresar: null, cicloMasCercano: 9,
      motivo: { tipo: 'cadenaPrerrequisitos', cursos: ['100000I62N', '100000S09I'], periodosNecesarios: 2, periodosDisponibles: 1 },
    });
    const enCuatro = buildAIContext(store.getState(), { limites: detectarLimites('¿puedo terminar en 4 ciclos?') }).metaEgreso;
    expect(enCuatro).toMatchObject({ cicloMeta: 11, sePuede: true, horasMaximasNecesarias: 18 });
    // Sin pedido, no hay meta.
    expect(buildAIContext(store.getState()).metaEgreso).toBeNull();
  });

  it('el chat muestra "Aplicar a mi malla" y el modal (el mismo motor) reproduce el plan de la meta', async () => {
    const store = await crearStore();
    const peticiones: AIRequest[] = [];
    const cliente: AIClient = { esMock: true, enviar: vi.fn(async (peticion: AIRequest) => {
      peticiones.push(peticion);
      return { ok: true as const, respuesta: { texto: 'Sí se puede.', cursos: [], preguntasSugeridas: [] } };
    }) };
    const controlador = crearControladorAsistente({
      cliente, privacidadAceptada: true,
      obtenerContexto: ({ mensaje, ...opciones }) => buildAIContext(store.getState(), { ...opciones, limites: mensaje ? detectarLimites(mensaje) : null }),
    });
    await controlador.preguntar('Quiero terminar mi carrera en el ciclo 9, se puede?');
    const respuesta = controlador.obtener().mensajes.at(-1);
    const opciones = opcionesDeMeta(peticiones[0].contexto.metaEgreso!);
    expect(opciones).toEqual({
      alcance: 'hastaEgresar', maxHorasPorPeriodo: 34, maxCreditosPorPeriodo: null, maxCuotaMensual: null, usarVeranos: false,
      conservarUbicados: false, horasEstricto: false, creditosEstricto: false, cicloMeta: 9,
    });
    expect(respuesta).toMatchObject({ rol: 'assistant', tipo: 'texto', propuesta: opciones });
    const vistaPrevia = store.getState().previsualizarPlanificacionOptima(opciones!);
    expect(vistaPrevia.periodos.map(({ periodo, horas }) => [periodo.id, horas])).toEqual([['ciclo-8', 34], ['ciclo-9', 34]]);

    // La opción con veranos también se reproduce en el modal: la meta decide que se habilite el Verano 8.
    const conVeranos = store.getState().previsualizarPlanificacionOptima({ ...opciones!, maxHorasPorPeriodo: 28, usarVeranos: true });
    expect(conVeranos.veranosUsados).toEqual(['verano-8']);
    expect(conVeranos.cicloEgreso).toBe(9);

    // Sin plan posible no hay botón.
    await controlador.preguntar('¿Puedo egresar en el ciclo 8?');
    expect(controlador.obtener().mensajes.at(-1)).not.toHaveProperty('propuesta');
  });
});
