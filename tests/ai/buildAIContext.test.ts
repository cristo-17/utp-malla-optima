import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Curso } from '../../src/types/academic';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { AIContextSchema } from '../../src/application/ai/contracts';
import { buildAIContext, calcularCarga } from '../../src/application/ai/buildAIContext';
import { crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { UniversityFinancialRulesProvider } from '../../src/financial/rules/UniversityFinancialRulesProvider';
import { FinancialPlanningService } from '../../src/financial/services/FinancialPlanningService';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const FIXTURE = fileURLToPath(new URL('../fixtures/Plan_de_Estudio_1.xlsx', import.meta.url));
const CURSOS_OCTAVO = ['100000S06I', '100000S72T', '100000S73T', '100000H01C', '100000TD09', '100000I62N', '100000S71T'];

const crearStoreConOctavo = async () => {
  const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico('marzo', 7);
  await store.getState().setCursos(await parseUTPExcel(new File([readFileSync(FIXTURE)], 'Plan_de_Estudio_1.xlsx')), 'Plan_de_Estudio_1.xlsx');
  for (const codigo of CURSOS_OCTAVO) {
    expect(await store.getState().moverCursoAPeriodo(codigo, crearPeriodoRegular(8)), codigo).toBe(true);
  }
  return store;
};

type Store = Awaited<ReturnType<typeof crearStoreConOctavo>>;

describe('buildAIContext con Plan_de_Estudio_1.xlsx y el 8vo planificado', () => {
  let store: Store;
  beforeEach(async () => { store = await crearStoreConOctavo(); });

  it('cumple AIContextSchema y coincide con el snapshot', () => {
    const contexto = buildAIContext(store.getState());
    expect(AIContextSchema.parse(contexto)).toEqual(contexto);
    expect(contexto).toMatchSnapshot();
  });

  it('derivados: horas sobre el tope y las 24 h, diferencia por escenario, créditos para egresar (D-001)', () => {
    const { derivados, financiero, rutaSugerida } = buildAIContext(store.getState(), { presupuestoMensual: 900 });
    expect(derivados.horas).toEqual({
      proximoPeriodo: 25, topeEscala: 22, sobreTopeEscala: 3, margenTopeEscala: 0, recomendadas: 24, sobreRecomendadas: 1, margenRecomendadas: 0,
    });
    // BCP / BBVA: cuota 908.14 contra 900 → faltan 8.14 al mes y 40.70 en las 5 cuotas.
    expect(derivados.presupuesto?.find((item) => item.id === 'bcp_bbva')).toEqual({
      id: 'bcp_bbva', alcanza: false, diferenciaMes: -8.14, faltaPorMes: 8.14, sobraPorMes: 0, diferenciaCiclo: -40.7, faltaPorCiclo: 40.7, sobraPorCiclo: 0,
    });
    for (const escenario of financiero!.proximoPeriodo.filter((item) => item.id !== 'pago_unico')) {
      expect(derivados.presupuesto?.find((item) => item.id === escenario.id)?.diferenciaMes).toBe(escenario.diferenciaPresupuesto);
    }
    // Pago único: sin diferencia mensual; pensión 4307.86 al inicio, ahorro 5055.15 - 4705.86 y comparación
    // referencial 900 × 5 - 4307.86.
    expect(derivados.presupuesto?.map((item) => item.id)).toEqual(['sin_descuento', 'interbank_scotiabank', 'bcp_bbva']);
    expect(derivados.pagoUnico).toEqual({
      pensionAlInicio: 4307.86, matricula: 398, totalCiclo: 4705.86, ahorroVsSinDescuento: 349.29,
      diferenciaVsPresupuestoDelCiclo: 192.14, comparacion: 'comparación referencial',
    });
    expect(buildAIContext(store.getState()).derivados.pagoUnico).toMatchObject({ diferenciaVsPresupuestoDelCiclo: null, comparacion: null });
    // Ciclo 8 con 25 h y tope de 22 h: sin un curso de 4 h queda en 21 h (bajo el tope); sin uno de 2 h, en 23 h.
    expect(derivados.horasSinCadaCurso.find((curso) => curso.codigo === '100000I62N')).toEqual({
      codigo: '100000I62N', nombre: 'INTELIGENCIA DE NEGOCIOS', horasSinElCurso: 21, quedaBajoTopeEscala: true,
    });
    expect(derivados.horasSinCadaCurso.find((curso) => curso.codigo === '100000S71T')).toMatchObject({ horasSinElCurso: 23, quedaBajoTopeEscala: false });
    expect(derivados.horasSinCadaCurso).toHaveLength(7);
    // Ningún electivo aprobado: faltan los 3 créditos del mínimo.
    expect(derivados.creditosElectivosFaltantes).toBe(3);
    // 197 obligatorios + 3 electivos mínimos (academic.json); 121 aprobados o convalidados; 19 en curso.
    expect(derivados.creditos).toEqual({
      totalMalla: 210, obligatorios: 197, electivosMinimos: 3, paraEgresar: 200, aprobadosQueCuentan: 121, enCurso: 19,
      faltanParaEgresar: 79, faltanSiApruebaEnCurso: 60, ciclosRestantes: rutaSugerida.ciclosRestantes,
    });
    expect(derivados.cursosProximoPeriodo.map((curso) => curso.codigo)).toEqual(CURSOS_OCTAVO);
    expect(derivados.cursosProximoPeriodo[0]).toMatchObject({ creditos: 3, horas: 4, estado: 'PENDIENTE', jalado: false, sePuedeMover: true, bloquearia: [] });
    expect(buildAIContext(store.getState()).derivados.presupuesto).toBeNull();
  });

  it('derivados: el próximo periodo con el jalado fuera de su ventana, con el mismo motor, y los planificados que bloquea', async () => {
    expect(buildAIContext(store.getState()).derivados).toMatchObject({ proximoPeriodoConJalados: null, planificadosBloqueadosPorJalado: [] });
    expect(await store.getState().marcarComoJalado('100000S61T')).not.toBeNull();
    const { derivados, jalados } = buildAIContext(store.getState(), { presupuestoMensual: 900 });
    expect(jalados).toMatchObject([{ codigo: '100000S61T', ventana: ['ciclo-8'], enVentana: false }]);
    const conJalados = derivados.proximoPeriodoConJalados!;
    // 25 h + 4 h de HERRAMIENTAS DE DESARROLLO; 21 + 3 créditos.
    expect(conJalados).toMatchObject({
      periodoId: 'ciclo-8', jalados: ['100000S61T'], horas: 29, creditos: 24,
      superaTopeEscala: true, horasSobreTopeEscala: 7, superaRecomendadas: true, horasSobreRecomendadas: 5,
    });
    // Mismo motor que la Simulación de cuotas con el jalado en el Ciclo 8.
    const service = new FinancialPlanningService(new UniversityFinancialRulesProvider());
    const conElJalado = store.getState().cursos.map((curso) => curso.codigo === '100000S61T'
      ? { ...curso, ciclo: 8, tipoPeriodo: 'REGULAR' as const, ubicacion: 'periodo' as const } : curso);
    const sinDescuento = service.calcular(conElJalado, store.getState().tarifario!, store.getState().disciplinaActiva, { metodoPago: 'sin_descuento', cicloActual: 7 })
      .periodos.find((periodo) => periodo.id === 'ciclo-8')!.resumen;
    expect(conJalados.escenarios[0]).toEqual({
      id: 'sin_descuento', nombre: 'Sin descuento', cuotaMensual: sinDescuento.montoPorCuota, total: sinDescuento.costoTotalCiclo,
      diferenciaMes: Math.round((900 - sinDescuento.montoPorCuota) * 100) / 100,
    });
    expect(conJalados.escenarios.map((escenario) => escenario.id)).toEqual(['sin_descuento', 'interbank_scotiabank', 'bcp_bbva']);
    expect(conJalados.pagoUnico).toMatchObject({ matricula: 398, comparacion: 'comparación referencial' });
    // planificadosSinJalado: los 7 cursos del Ciclo 8 quedan bloqueados hasta agregar el jalado.
    expect(derivados.planificadosBloqueadosPorJalado.map((curso) => curso.codigo)).toEqual(CURSOS_OCTAVO);
  });

  it('derivados: un curso que es prerrequisito de otro planificado después no se puede mover', async () => {
    const dependiente = store.getState().cursos.find((curso) => curso.estado === 'PENDIENTE' && curso.prerrequisitos.includes('100000S06I'))!;
    expect(await store.getState().moverCursoAPeriodo(dependiente.codigo, crearPeriodoRegular(9))).toBe(true);
    const s06i = buildAIContext(store.getState()).derivados.cursosProximoPeriodo.find((curso) => curso.codigo === '100000S06I');
    expect(s06i).toMatchObject({ sePuedeMover: false, bloquearia: [dependiente.codigo] });
  });

  it('calcula perfil, próximo periodo y carga', () => {
    const { perfil, proximoPeriodo, carga } = buildAIContext(store.getState());
    expect(perfil).toMatchObject({ periodoIngreso: 'marzo', cicloActual: 7, creditos: { enCurso: 19, pendientesEnMalla: 70 } });
    expect(perfil.electivos).toEqual({ cubiertos: 0, minimo: 3, faltantes: 3 });
    expect(proximoPeriodo).toMatchObject({ id: 'ciclo-8', etiqueta: 'Ciclo 8', totalHoras: 25, totalCreditos: 21, horasExceso: 3 });
    expect(proximoPeriodo!.cursos.map((curso) => curso.codigo).sort()).toEqual([...CURSOS_OCTAVO].sort());
    expect(carga).toMatchObject({ nivel: 'riesgo', horas: 25, topeEscala: 22, cursos4HorasOMas: 5 });
  });

  it('los 4 escenarios coinciden con el motor financiero', () => {
    const { financiero } = buildAIContext(store.getState());
    expect(financiero!.planCompleto.map(({ id, total }) => [id, total])).toEqual([
      ['sin_descuento', 5055.15], ['interbank_scotiabank', 4822.3], ['bcp_bbva', 4938.7], ['pago_unico', 4705.86],
    ]);
    expect(financiero!.proximoPeriodo.map((escenario) => escenario.total)).toEqual([5055.15, 4822.3, 4938.7, 4705.86]);
    expect(financiero!.metodoPagoElegido).toEqual({ id: 'sin_descuento', nombre: 'Sin descuento' });
    expect(financiero!.costoHoraAdicional).toBe(38.81);
  });

  it('con presupuesto mensual informa la diferencia contra cada cuota (el pago único no tiene cuota mensual)', () => {
    const { financiero } = buildAIContext(store.getState(), { presupuestoMensual: 900 });
    expect(financiero!.presupuestoMensual).toBe(900);
    for (const escenario of financiero!.proximoPeriodo.filter((item) => item.id !== 'pago_unico')) {
      expect(escenario.diferenciaPresupuesto).toBeCloseTo(900 - escenario.cuotaMensual!, 2);
    }
    expect(financiero!.proximoPeriodo.find((item) => item.id === 'pago_unico')).toMatchObject({ cuotaMensual: null, diferenciaPresupuesto: null, total: 4705.86 });
    expect(buildAIContext(store.getState()).financiero!.proximoPeriodo[0].diferenciaPresupuesto).toBeNull();
  });

  it('lee el método de pago elegido del store', () => {
    store.getState().setMetodoPago('bcp_bbva');
    expect(buildAIContext(store.getState()).financiero!.metodoPagoElegido.id).toBe('bcp_bbva');
  });

  it('incluye what-if de los EN_CURSO y del próximo periodo, y la ruta sugerida sin aplicarla', () => {
    const antes = structuredClone(store.getState().cursos);
    const { whatIf, rutaSugerida } = buildAIContext(store.getState());
    expect(whatIf.filter((item) => item.origen === 'EN_CURSO')).toHaveLength(7);
    expect(whatIf.filter((item) => item.origen === 'PROXIMO_PERIODO')).toHaveLength(7);
    expect(whatIf.find((item) => item.codigo === '100000S61T')!.cursosBloqueados).toContain('100000I62N');
    expect(rutaSugerida.propuesta[0].periodoId).toBe('ciclo-8');
    expect(rutaSugerida.ciclosRestantes).toBeGreaterThan(0);
    expect(store.getState().cursos).toEqual(antes);
  });

  it('rutaSugerida.aplicadaEnMalla: false mientras solo es sugerencia; true después de aplicarla', async () => {
    // F-038: la IA presentaba la sugerencia como si fuera la malla del alumno ("parece que guarda planes pasados").
    expect(buildAIContext(store.getState()).rutaSugerida.aplicadaEnMalla).toBe(false);
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima());
    const { rutaSugerida, periodosPlanificados } = buildAIContext(store.getState());
    expect(rutaSugerida.aplicadaEnMalla).toBe(true);
    expect(periodosPlanificados.map((periodo) => periodo.id)).toEqual(rutaSugerida.propuesta.map((periodo) => periodo.periodoId));
  });

  it('lista los electivos con su área propuesta sin confirmar', () => {
    const { electivos } = buildAIContext(store.getState());
    expect(electivos.map((electivo) => electivo.codigo).sort()).toEqual(['100000CN47', '100000I64M', '100000RI07', '100000ZZ28']);
    expect(electivos.every((electivo) => electivo.area && !electivo.areaConfirmada)).toBe(true);
  });

  it('no incluye nombreArchivoCargado ni el nombre del archivo, y pesa 24 KB o menos', () => {
    expect(store.getState().nombreArchivoCargado).toBe('Plan_de_Estudio_1.xlsx');
    const json = JSON.stringify(buildAIContext(store.getState(), { foco: { tipo: 'curso', id: '100000I62N' }, presupuestoMensual: 900 }));
    expect(json).not.toContain('nombreArchivo');
    expect(json).not.toContain('Plan_de_Estudio');
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(24 * 1024);
  });

  it('con S61T jalado: ventana ciclo-8, fuera de ella, y snapshot', async () => {
    await store.getState().marcarComoJalado('100000S61T');
    const contexto = buildAIContext(store.getState());
    expect(contexto.jalados).toEqual([{
      codigo: '100000S61T', nombre: 'HERRAMIENTAS DE DESARROLLO', ventana: ['ciclo-8'], ubicacionActual: 'ciclo-7', enVentana: false,
    }]);
    expect(contexto.whatIf.some((item) => item.codigo === '100000S61T')).toBe(false);
    expect(contexto).toMatchSnapshot();
  });

  it('el jalado llevado a su ventana queda enVentana', async () => {
    await store.getState().marcarComoJalado('100000S61T');
    await store.getState().agregarJaladosARecuperacion();
    expect(buildAIContext(store.getState()).jalados[0]).toMatchObject({ ubicacionActual: 'ciclo-8', enVentana: true });
  });

  it('con foco en un curso incluye su detalle completo (snapshot)', () => {
    const { foco } = buildAIContext(store.getState(), { foco: { tipo: 'curso', id: '100000I62N' } });
    expect(foco).toMatchObject({
      tipo: 'curso', codigo: '100000I62N', nombre: 'INTELIGENCIA DE NEGOCIOS', ubicacion: 'ciclo-8',
      prerrequisitos: [
        { codigo: '100000S61T', nombre: 'HERRAMIENTAS DE DESARROLLO', estado: 'EN_CURSO' },
        { codigo: '100000SI46', nombre: 'BASE DE DATOS II', estado: 'APROBADO' },
      ],
    });
    expect(foco).toMatchSnapshot();
  });

  it('con foco en un ciclo incluye cursos, carga y escenarios', () => {
    const { foco } = buildAIContext(store.getState(), { foco: { tipo: 'ciclo', id: 'ciclo-8' } });
    expect(foco?.tipo).toBe('ciclo');
    if (foco?.tipo !== 'ciclo') return;
    expect(foco.cursos).toHaveLength(7);
    expect(foco.carga.nivel).toBe('riesgo');
    expect(foco.escenarios).toHaveLength(4);
  });

  it('un foco inexistente queda en null; el plan completo se marca como tal', () => {
    expect(buildAIContext(store.getState(), { foco: { tipo: 'curso', id: 'NO-EXISTE' } }).foco).toBeNull();
    expect(buildAIContext(store.getState(), { foco: { tipo: 'plan' } }).foco).toEqual({ tipo: 'plan' });
  });
});

describe('calcularCarga - fórmula determinista', () => {
  const curso = (codigo: string, horas: number, cambios: Partial<Curso> = {}): Curso => ({
    codigo, nombre: codigo, ciclo: 8, cicloOrigen: 8, tipoPeriodo: 'REGULAR', ubicacion: 'periodo',
    horasSemanales: horas, creditos: horas, tipo: 'OBLIGATORIO', prerrequisitos: [], estado: 'PENDIENTE', ...cambios,
  });
  const sinCadenas = new Map<string, { longitudCadena: number }>();

  it('sin cursos: ok con 0 puntos', () => {
    expect(calcularCarga([], 'REGULAR', 22, sinCadenas)).toMatchObject({ nivel: 'ok', puntos: 0, horas: 0 });
  });

  it('16 h en 4 cursos de 3 h y uno de 4 h: ok', () => {
    const cursos = [curso('A', 3), curso('B', 3), curso('C', 3), curso('D', 3), curso('E', 4)];
    expect(calcularCarga(cursos, 'REGULAR', 22, sinCadenas)).toMatchObject({ nivel: 'ok', puntos: 0, horas: 16 });
  });

  it('20 h con 3 cursos de 4 h: atención (1 por cercanía al tope + 1 por cursos largos)', () => {
    const cursos = [curso('A', 4), curso('B', 4), curso('C', 4), curso('D', 3), curso('E', 3), curso('F', 2)];
    expect(calcularCarga(cursos, 'REGULAR', 22, sinCadenas)).toMatchObject({ nivel: 'atencion', puntos: 2, horas: 20 });
  });

  it('22 h con 2 laboratorios y 3 cadenas largas: riesgo por puntos', () => {
    const cursos = [curso('A', 6, { esLaboratorio: true }), curso('B', 6, { esLaboratorio: true }), curso('C', 6), curso('D', 2), curso('E', 2)];
    const cadenas = new Map([['A', { longitudCadena: 3 }], ['B', { longitudCadena: 4 }], ['C', { longitudCadena: 5 }]]);
    // 22 h: +1 (cerca del tope); 3 cursos >= 4 h: +1; 2 laboratorios: +1; 3 cadenas largas: +1 → 4 puntos.
    expect(calcularCarga(cursos, 'REGULAR', 22, cadenas)).toMatchObject({ nivel: 'riesgo', puntos: 4, laboratorios: 2, cadenasLargas: 3 });
  });

  it('23 h supera la escala: +2', () => {
    const cursos = [curso('A', 3), curso('B', 3), curso('C', 3), curso('D', 3), curso('E', 3), curso('F', 3), curso('G', 3), curso('H', 2)];
    expect(calcularCarga(cursos, 'REGULAR', 22, sinCadenas)).toMatchObject({ nivel: 'atencion', puntos: 2, horas: 23 });
  });

  it('más de 24 h es riesgo aunque tenga pocos puntos', () => {
    const cursos = [curso('A', 3), curso('B', 3), curso('C', 3), curso('D', 3), curso('E', 3), curso('F', 3), curso('G', 3), curso('H', 3), curso('I', 1)];
    expect(calcularCarga(cursos, 'REGULAR', 22, sinCadenas)).toMatchObject({ nivel: 'riesgo', puntos: 3, horas: 25 });
  });

  it('en verano usa las horas efectivas (x2)', () => {
    expect(calcularCarga([curso('A', 4, { tipoPeriodo: 'VERANO' }), curso('B', 3, { tipoPeriodo: 'VERANO' })], 'VERANO', 22, sinCadenas))
      .toMatchObject({ horas: 14, nivel: 'ok' });
  });
});
