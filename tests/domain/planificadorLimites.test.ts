import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import {
  generateOptimalPlanUseCase, type GenerateOptimalPlanInput, type PropuestaPlan,
} from '../../src/application/usecases/generateOptimalPlanUseCase';
import { obtenerPeriodoCurso, crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { FACTOR_HORAS_VERANO, LIMITE_CREDITOS_VERANO } from '../../src/domain/rules/planningRules';
import { validarCargaPlanificacionAutomatica } from '../../src/domain/services/automaticPlanningService';
import { motivoPlanificadoInvalido } from '../../src/domain/services/prerequisiteService';
import { calcularPresupuesto, cuotaMensualPorHoras, horasMaximasParaCuota } from '../../src/financial/engine/budgetCalculator';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { UniversityFinancialRulesProvider } from '../../src/financial/rules/UniversityFinancialRulesProvider';
import { FinancialPlanningService } from '../../src/financial/services/FinancialPlanningService';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import type { Curso, PeriodoAcademico } from '../../src/types/academic';
import type { Tarifario } from '../../src/types/financial';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const DISCIPLINA = 'Ingeniería y Arquitectura';
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

const entrada = (store: Store, cambios: Partial<GenerateOptimalPlanInput> = {}): GenerateOptimalPlanInput => {
  const estado = store.getState();
  return {
    cursos: estado.cursos, totalCiclos: estado.totalCiclos, ciclosExcluidos: estado.ciclosExcluidos,
    cicloActual: estado.cicloActual, periodoIngreso: estado.periodoIngreso,
    tarifario: estado.tarifario, disciplina: estado.disciplinaActiva, metodoPago: estado.metodoPago, ...cambios,
  };
};

const enPeriodo = (cursos: Curso[], periodo: PeriodoAcademico) => cursos.filter((curso) => curso.ubicacion === 'periodo' &&
  (curso.estado === 'PENDIENTE' || curso.estado === 'EN_CURSO') && obtenerPeriodoCurso(curso).id === periodo.id);

/**
 * Obligatorios pendientes que todavía cabrían en el periodo: no están en él, todos sus prerrequisitos de la malla
 * quedan aprobados, en curso o en un periodo anterior, y sus horas y créditos entran en lo que sobra.
 */
const cabeOtroCurso = (propuesta: PropuestaPlan, periodo: PeriodoAcademico) => {
  const { cursos, limites } = propuesta;
  const porCodigo = new Map(cursos.map((curso) => [curso.codigo, curso]));
  const verano = periodo.tipo === 'VERANO';
  const factor = verano ? FACTOR_HORAS_VERANO : 1;
  const carga = enPeriodo(cursos, periodo);
  const horasLibres = ((verano ? limites.horasVerano : limites.horas) - carga.reduce((s, c) => s + c.horasSemanales, 0) * factor) / factor;
  const creditosLibres = (verano ? limites.creditosVerano : limites.creditos ?? Infinity) - carga.reduce((s, c) => s + c.creditos, 0);
  const antes = (codigo: string) => {
    const requisito = porCodigo.get(codigo);
    if (!requisito || requisito.estado === 'APROBADO' || requisito.estado === 'CONVALIDADO') return true;
    return requisito.ubicacion === 'periodo' && obtenerPeriodoCurso(requisito).orden < periodo.orden;
  };
  return cursos.filter((curso) => curso.estado === 'PENDIENTE' && curso.tipo === 'OBLIGATORIO' && !curso.jalado &&
    !carga.includes(curso) && (curso.ubicacion === 'banco' || obtenerPeriodoCurso(curso).orden > periodo.orden) &&
    curso.prerrequisitos.every(antes) && curso.horasSemanales <= horasLibres && curso.creditos <= creditosLibres)
    .map((curso) => curso.codigo);
};

const sinInvalidos = (propuesta: PropuestaPlan, store: Store) => {
  const contexto = store.getState();
  expect(propuesta.cursos.filter((curso) => motivoPlanificadoInvalido(curso, propuesta.cursos, contexto))).toEqual([]);
  expect(() => validarCargaPlanificacionAutomatica(propuesta)).not.toThrow();
};

describe('horasMaximasParaCuota con la escala real (Ate 2026, Ingeniería y Arquitectura)', () => {
  const tarifario: Tarifario = FinancialConfigurationProvider.load();

  it('sin descuento: S/ 800 → 15 h (725.35); S/ 815 → 22 h; S/ 900 → 24 h (892.62 con recargo)', () => {
    expect(horasMaximasParaCuota(800, tarifario, DISCIPLINA, { metodoPago: 'sin_descuento' })).toBe(15);
    expect(horasMaximasParaCuota(815, tarifario, DISCIPLINA, { metodoPago: 'sin_descuento' })).toBe(22);
    expect(horasMaximasParaCuota(853.81, tarifario, DISCIPLINA, { metodoPago: 'sin_descuento' })).toBe(23);
    expect(horasMaximasParaCuota(900, tarifario, DISCIPLINA, { metodoPago: 'sin_descuento' })).toBe(24);
  });

  it('bordes de la escala: menos de 407.50 no paga ninguna hora; 407.50 paga 6 h y 570.50, 11 h', () => {
    expect(horasMaximasParaCuota(407.49, tarifario, DISCIPLINA)).toBe(0);
    expect(horasMaximasParaCuota(407.5, tarifario, DISCIPLINA)).toBe(6);
    expect(horasMaximasParaCuota(570.5, tarifario, DISCIPLINA)).toBe(11);
  });

  it('con pronto pago el descuento cuenta: S/ 800 paga 22 h con Interbank (774.25) y con BCP (794.62)', () => {
    expect(horasMaximasParaCuota(800, tarifario, DISCIPLINA, { metodoPago: 'interbank_scotiabank' })).toBe(22);
    expect(horasMaximasParaCuota(800, tarifario, DISCIPLINA, { metodoPago: 'bcp_bbva' })).toBe(22);
    expect(horasMaximasParaCuota(774.24, tarifario, DISCIPLINA, { metodoPago: 'interbank_scotiabank' })).toBe(15);
  });

  it('en verano no hay pronto pago: las horas tarifarias salen de la escala sin descuento', () => {
    expect(horasMaximasParaCuota(800, tarifario, DISCIPLINA, { metodoPago: 'interbank_scotiabank', tipoPeriodo: 'VERANO' })).toBe(15);
  });

  it('cuotaMensualPorHoras da la misma cuota que calcularPresupuesto de 1 a 30 h, con cada método', () => {
    for (const metodoPago of Object.keys(tarifario.metodosPago!)) {
      for (let horas = 1; horas <= 30; horas += 1) {
        const curso = { codigo: 'X', nombre: 'X', ciclo: 8, cicloOrigen: 8, tipoPeriodo: 'REGULAR', ubicacion: 'periodo',
          horasSemanales: horas, creditos: 3, tipo: 'OBLIGATORIO', prerrequisitos: [], estado: 'PENDIENTE' } satisfies Curso;
        expect(cuotaMensualPorHoras(horas, tarifario, DISCIPLINA, { metodoPago }), `${metodoPago} ${horas} h`)
          .toBe(calcularPresupuesto([curso], tarifario, DISCIPLINA, { metodoPago }).montoPorCuota);
      }
    }
  });
});

describe('planificador con límites (Plan_de_Estudio_1.xlsx, marzo, ciclo actual 7)', () => {
  let store: Store;
  beforeAll(async () => { store = await crearStore(); });

  it('sin límites: el tope de 22 h de siempre, y hace falta el ciclo 11 para el electivo', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store));
    expect(propuesta.limites).toMatchObject({ horas: 22, creditos: null });
    expect(propuesta.periodos.map(({ periodo, horas }) => [periodo.id, horas]))
      .toEqual([['ciclo-8', 22], ['ciclo-9', 22], ['ciclo-10', 21], ['ciclo-11', 3]]);
    expect(propuesta.ciclosAgregados).toEqual([11]);
    expect(propuesta.noPlanificados).toEqual([]);
  });

  it('tope de 20 h: ningún periodo pasa de 20 y cada periodo queda lleno (no cabe otro curso disponible)', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20 }));
    expect(propuesta.limites.horas).toBe(20);
    for (const { periodo, horas } of propuesta.periodos) {
      expect(horas, periodo.id).toBeLessThanOrEqual(20);
      expect(cabeOtroCurso(propuesta, periodo), periodo.id).toEqual([]);
    }
    expect(propuesta.periodos.map(({ horas }) => horas)).toEqual([19, 20, 20, 9]);
    sinInvalidos(propuesta, store);
  });

  it('el fallo del feedback: el Ciclo 8 con 20 h no se detiene en el primer curso que no entra', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20, alcance: 'proximoPeriodo' }));
    const ciclo8 = propuesta.periodos.find(({ periodo }) => periodo.id === 'ciclo-8')!;
    expect(ciclo8.horas).toBe(19);
    // Lo que no entró pasa las 20 h: la de 2 h daría 21.
    expect(propuesta.noPlanificados.every(({ motivos }) => motivos[0].tipo === 'NO_CABE_EN_PERIODO')).toBe(true);
    expect(propuesta.noPlanificados.map(({ codigo }) => codigo)).toContain('100000S71T');
    expect(cabeOtroCurso(propuesta, crearPeriodoRegular(8))).toEqual([]);
  });

  it('18 créditos: ningún periodo pasa de 18 y cada uno queda lleno por horas o por créditos', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCreditosPorPeriodo: 18 }));
    expect(propuesta.limites).toMatchObject({ horas: 22, creditos: 18 });
    for (const { periodo, creditos, horas } of propuesta.periodos) {
      expect(creditos, periodo.id).toBeLessThanOrEqual(18);
      expect(horas, periodo.id).toBeLessThanOrEqual(22);
      expect(cabeOtroCurso(propuesta, periodo), periodo.id).toEqual([]);
    }
    sinInvalidos(propuesta, store);
  });

  it('cuota máxima de S/ 800 sin descuento: 15 h por ciclo, cada cuota bajo 800, y un ciclo más que sin límites', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCuotaMensual: 800, metodoPago: 'sin_descuento' }));
    expect(propuesta.limitesPedidos).toMatchObject({ maxCuotaMensual: 800, horasPorCuota: 15, metodoPago: 'sin_descuento' });
    expect(propuesta.limites.horas).toBe(15);
    for (const { periodo, horas, costos } of propuesta.periodos) {
      expect(horas, periodo.id).toBeLessThanOrEqual(15);
      expect(costos!.cuotas.find((cuota) => cuota.metodo === 'sin_descuento')!.cuotaMensual, periodo.id).toBeLessThanOrEqual(800);
      expect(cabeOtroCurso(propuesta, periodo), periodo.id).toEqual([]);
    }
    expect(propuesta.ciclosAgregados).toEqual([11, 12]);
    expect(propuesta.comparacionSinLimites).toMatchObject({ cicloEgreso: 11, ciclosExtra: 1 });
  });

  it('S/ 900: paga 24 h (con recargo) y, como entran 7 cursos en el Ciclo 8, arma 7', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCuotaMensual: 900 }));
    expect(propuesta.limitesPedidos.horasPorCuota).toBe(24);
    const [ciclo8] = propuesta.periodos;
    expect(ciclo8).toMatchObject({ periodo: { id: 'ciclo-8' }, horas: 24 });
    expect(ciclo8.cursos).toHaveLength(7);
    expect(ciclo8.costos!.cuotas[0]).toEqual({ metodo: 'sin_descuento', nombre: 'Sin descuento', cuotaMensual: 892.62 });
    expect(ciclo8.costos!.pagoUnico).toMatchObject({ descuentoPorcentaje: 7.5 });
    expect(cabeOtroCurso(propuesta, ciclo8.periodo)).toEqual([]);
    // Con 24 h egresa en el Ciclo 10, sin el ciclo 11.
    expect(propuesta.ciclosAgregados).toEqual([]);
  });

  it('con un jalado: va primero, en su ventana, y el resto respeta el tope', async () => {
    const conJalado = await crearStore();
    await conJalado.getState().marcarComoJalado('100000S61T');
    const propuesta = generateOptimalPlanUseCase(entrada(conJalado, { maxHorasPorPeriodo: 20 }));
    const [primero] = propuesta.periodos;
    expect(primero.periodo.id).toBe('ciclo-8');
    expect(primero.cursos[0]).toMatchObject({ codigo: '100000S61T', jalado: true });
    expect(primero.horas).toBeLessThanOrEqual(20);
    expect(propuesta.explicacion).toContainEqual({ tipo: 'JALADOS_PRIMERO', total: 1, periodos: ['Ciclo 8'] });
    sinInvalidos(propuesta, conJalado);
  });

  it('usarVeranos false: solo ciclos regulares; true: usa el Verano 8 (≤ 11 créditos) y ya no necesita el ciclo 11', () => {
    const sinVeranos = generateOptimalPlanUseCase(entrada(store, { usarVeranos: false }));
    expect(sinVeranos.veranosUsados).toEqual([]);
    expect(sinVeranos.periodos.every(({ periodo }) => periodo.tipo === 'REGULAR')).toBe(true);
    expect(sinVeranos.cicloEgreso).toBe(11);

    const conVeranos = generateOptimalPlanUseCase(entrada(store, { usarVeranos: true }));
    expect(conVeranos.veranosUsados).toEqual(['verano-8']);
    expect(conVeranos.ciclosAgregados).toEqual([]);
    expect(conVeranos.cicloEgreso).toBe(10);
    const verano = conVeranos.periodos.find(({ periodo }) => periodo.id === 'verano-8')!;
    expect(verano.creditos).toBeLessThanOrEqual(LIMITE_CREDITOS_VERANO);
    expect(verano.horas).toBeLessThanOrEqual(22);
    expect(verano.costos!.pagoUnico).toBeNull();
    expect(conVeranos.explicacion).toContainEqual({ tipo: 'VERANOS_USADOS', periodos: ['Verano 8'] });
    sinInvalidos(conVeranos, store);
  });

  it('los veranos solo se usan si hacen falta: con S/ 900 egresa en el Ciclo 10 sin veranos', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCuotaMensual: 900, usarVeranos: true }));
    expect(propuesta.veranosUsados).toEqual([]);
    expect(propuesta.cicloEgreso).toBe(10);
  });

  it('un caso que requiere el ciclo 11: con 20 h agrega el ciclo 11 y lo explica', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20 }));
    expect(propuesta.ciclosAgregados).toEqual([11]);
    expect(propuesta.cicloEgreso).toBe(11);
    expect(propuesta.cicloFinal).toBe(11);
    expect(propuesta.explicacion).toContainEqual({ tipo: 'CICLOS_AGREGADOS', ciclos: [11] });
    expect(propuesta.cursos.some((curso) => curso.ubicacion === 'periodo' && curso.ciclo === 11)).toBe(true);
  });

  it('electivos solo hasta los créditos mínimos: uno de 3 créditos', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20 }));
    const electivos = propuesta.cursos.filter((curso) => curso.tipo === 'ELECTIVO' && curso.ubicacion === 'periodo' &&
      curso.estado === 'PENDIENTE');
    expect(electivos.map((curso) => curso.creditos)).toEqual([3]);
  });

  it('conservarUbicados (por defecto): lo que el alumno ya ubicó se queda; con false se vuelve a planificar', async () => {
    const ubicado = await crearStore();
    expect(await ubicado.getState().moverCursoAPeriodo('100000S71T', crearPeriodoRegular(9))).toBe(true);
    const conservando = generateOptimalPlanUseCase(entrada(ubicado, { maxHorasPorPeriodo: 20 }));
    expect(conservando.cursos.find((curso) => curso.codigo === '100000S71T')).toMatchObject({ ciclo: 9, ubicacion: 'periodo' });
    expect(conservando.periodos.find(({ periodo }) => periodo.id === 'ciclo-9')!.cursos
      .find((curso) => curso.codigo === '100000S71T')).toMatchObject({ conservado: true });
    const reordenando = generateOptimalPlanUseCase(entrada(ubicado, { maxHorasPorPeriodo: 20, conservarUbicados: false }));
    expect(reordenando.totalConservados).toBe(0);
  });

  it('alcance "proximoPeriodo": solo arma el Ciclo 8 y deja el resto de la malla como estaba', async () => {
    const ubicado = await crearStore();
    expect(await ubicado.getState().moverCursoAPeriodo('100000S71T', crearPeriodoRegular(9))).toBe(true);
    const propuesta = generateOptimalPlanUseCase(entrada(ubicado, { alcance: 'proximoPeriodo' }));
    expect(propuesta.comparacionSinLimites).toBeNull();
    expect(propuesta.periodos.map(({ periodo }) => periodo.id)).toEqual(['ciclo-8', 'ciclo-9']);
    expect(propuesta.periodos[1].cursos.map((curso) => curso.codigo)).toEqual(['100000S71T']);
    const fuera = propuesta.cursos.filter((curso) => curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' && curso.ciclo !== 8);
    expect(fuera.map((curso) => curso.codigo)).toEqual(['100000S71T']);
  });
});

describe('alternativas y límites estrictos (Plan_de_Estudio_1.xlsx, escala real)', () => {
  let store: Store;
  beforeAll(async () => { store = await crearStore(); });

  it('S/ 800 sin descuento: Ciclo 12; con pronto pago caben 22 h (Ciclo 11) y con pronto pago y el Verano 8 egresa en el Ciclo 10; las dos cuestan menos', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCuotaMensual: 800, metodoPago: 'sin_descuento' }));
    expect(propuesta).toMatchObject({ cicloEgreso: 12, costoTotalHastaEgresar: 19349.5 });
    expect(propuesta.alternativas.map((alternativa) => [alternativa.tipo, alternativa.opciones, alternativa.cicloEgreso, alternativa.costoTotalHastaEgresar]))
      .toEqual([
        ['metodoPagoYVeranos', { metodoPago: 'interbank_scotiabank', usarVeranos: true }, 10, 14456.45],
        ['metodoPago', { metodoPago: 'interbank_scotiabank' }, 11, 15141.35],
      ]);
    const conProntoPago = propuesta.alternativas[0];
    expect(conProntoPago.veranosUsados).toEqual(['verano-8']);
    expect(conProntoPago.costoTotalHastaEgresar!).toBeLessThan(propuesta.costoTotalHastaEgresar!);
    // Con pronto pago, la cuota de 22 h entra en S/ 800 (774.25); la de 23 h ya no (811.12).
    expect(conProntoPago.horasPorPeriodo.every(({ horas }) => horas <= 22)).toBe(true);
  });

  it('el costo total es el de FinancialPlanningService para la malla de la propuesta (sin sumas nuevas)', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCuotaMensual: 800 }));
    const servicio = new FinancialPlanningService(new UniversityFinancialRulesProvider());
    const { tarifario, disciplinaActiva } = store.getState();
    expect(propuesta.costoTotalHastaEgresar).toBe(
      Math.round(servicio.calcular(propuesta.cursos, tarifario!, disciplinaActiva, { metodoPago: 'sin_descuento', cicloActual: 7 }).totalGeneral * 100) / 100);
  });

  it('sin límites: el Ciclo 11 es solo por un electivo; la alternativa de 23 h (con recargo) egresa en el Ciclo 10 y cuesta menos, y también el Verano 8', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store));
    expect(propuesta).toMatchObject({ ciclosAgregados: [11], costoTotalHastaEgresar: 15854.5 });
    expect(propuesta.periodos.at(-1)).toMatchObject({ periodo: { id: 'ciclo-11' }, creditos: 3 });
    const [tope, veranos] = propuesta.alternativas;
    expect(tope).toMatchObject({ tipo: 'topeSinCicloExtra', opciones: { maxHorasPorPeriodo: 23 }, cicloEgreso: 10, ciclosAgregados: [],
      conRecargo: true, costoTotalHastaEgresar: 13807.1 });
    expect(veranos).toMatchObject({ tipo: 'veranos', cicloEgreso: 10, veranosUsados: ['verano-8'], costoTotalHastaEgresar: 14798.75 });
  });

  it('solo alternativas que egresan antes o cuestan menos: con S/ 900 queda el pronto pago (mismo egreso, menos costo)', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCuotaMensual: 900 }));
    for (const alternativa of propuesta.alternativas) {
      const antes = (alternativa.periodoEgreso?.orden ?? 99) < propuesta.periodoEgreso!.orden;
      expect(antes || alternativa.costoTotalHastaEgresar! < propuesta.costoTotalHastaEgresar!).toBe(true);
    }
    expect(propuesta.alternativas.map((alternativa) => alternativa.tipo)).toEqual(['metodoPago']);
  });

  it('"menos de 18 créditos": ningún periodo llega a 18', () => {
    const propuesta = generateOptimalPlanUseCase(entrada(store, { maxCreditosPorPeriodo: 18, creditosEstricto: true }));
    expect(propuesta.limites).toMatchObject({ creditos: 18, creditosEstricto: true });
    expect(propuesta.periodos.every(({ creditos }) => creditos < 18)).toBe(true);
    expect(() => validarCargaPlanificacionAutomatica(propuesta)).not.toThrow();
    // "Máximo 18" sí permite 18.
    expect(generateOptimalPlanUseCase(entrada(store, { maxCreditosPorPeriodo: 18 })).periodos.some(({ creditos }) => creditos === 18)).toBe(true);
  });

  it('"menos de 20 h": ningún periodo llega a 20 h; "máximo 20 h" sí', () => {
    const estricto = generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20, horasEstricto: true }));
    expect(estricto.periodos.every(({ horas }) => horas < 20)).toBe(true);
    expect(generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20 })).periodos.some(({ horas }) => horas === 20)).toBe(true);
    // La validación trata llegar a N como exceso con el límite estricto.
    const conVeinte = generateOptimalPlanUseCase(entrada(store, { maxHorasPorPeriodo: 20 }));
    expect(() => validarCargaPlanificacionAutomatica({ ...conVeinte, limites: { ...conVeinte.limites, horasEstricto: true } })).toThrow();
  });
});
