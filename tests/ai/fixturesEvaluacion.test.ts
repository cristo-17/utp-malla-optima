import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { AIContextSchema, type AIContext } from '../../src/application/ai/contracts';
import { buildAIContext } from '../../src/application/ai/buildAIContext';
import { detectarLimites } from '../../src/application/ai/limites';
import { crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

/**
 * Contextos para la evaluación manual contra la API real (ai-proxy/scripts/evaluar.ts).
 * Se generan con buildAIContext desde los Excel reales; si cambian, este test falla.
 * Para regenerarlos: `pnpm vitest run tests/ai/fixturesEvaluacion.test.ts -u`.
 */
const leerExcel = (nombre: string) =>
  new File([readFileSync(fileURLToPath(new URL(`../fixtures/${nombre}`, import.meta.url)))], nombre);
const destino = (nombre: string) => `../../ai-proxy/tests/fixtures/${nombre}`;
const CURSOS_OCTAVO = ['100000S06I', '100000S72T', '100000S73T', '100000H01C', '100000TD09', '100000I62N', '100000S71T'];

const crearStore = async (excel: string) => {
  const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico('marzo', 7);
  await store.getState().setCursos(await parseUTPExcel(leerExcel(excel)), excel);
  return store;
};

const crearPlan1ConOctavo = async () => {
  const store = await crearStore('Plan_de_Estudio_1.xlsx');
  for (const codigo of CURSOS_OCTAVO) {
    expect(await store.getState().moverCursoAPeriodo(codigo, crearPeriodoRegular(8)), codigo).toBe(true);
  }
  return store;
};

const comoJson = (contexto: AIContext) => {
  expect(AIContextSchema.parse(contexto)).toEqual(contexto);
  expect(JSON.stringify(contexto)).not.toContain('Plan_de_Estudio');
  return `${JSON.stringify(contexto, null, 2)}\n`;
};

describe('fixtures de la evaluación (buildAIContext)', () => {
  it('contexto-plan1.json: Plan_de_Estudio_1, 8vo planificado, presupuesto 900', async () => {
    const store = await crearPlan1ConOctavo();
    await expect(comoJson(buildAIContext(store.getState(), { presupuestoMensual: 900 }))).toMatchFileSnapshot(destino('contexto-plan1.json'));
  });

  it('contexto-plan1-foco-I62N.json y contexto-plan1-foco-ciclo8.json: el mismo plan con foco', async () => {
    const estado = (await crearPlan1ConOctavo()).getState();
    const curso = buildAIContext(estado, { presupuestoMensual: 900, foco: { tipo: 'curso', id: '100000I62N' } });
    expect(curso.foco).toMatchObject({ tipo: 'curso', codigo: '100000I62N', whatIf: { ventanaSiJala: ['verano-8', 'ciclo-9'] } });
    await expect(comoJson(curso)).toMatchFileSnapshot(destino('contexto-plan1-foco-I62N.json'));
    const ciclo = buildAIContext(estado, { presupuestoMensual: 900, foco: { tipo: 'ciclo', id: 'ciclo-8' } });
    expect(ciclo.foco).toMatchObject({ tipo: 'ciclo', periodo: { id: 'ciclo-8' } });
    await expect(comoJson(ciclo)).toMatchFileSnapshot(destino('contexto-plan1-foco-ciclo8.json'));
  });

  it('contexto-plan1-jalado.json: lo mismo, con S61T marcado como jalado', async () => {
    const store = await crearPlan1ConOctavo();
    expect(await store.getState().marcarComoJalado('100000S61T')).not.toBeNull();
    const contexto = buildAIContext(store.getState(), { presupuestoMensual: 900 });
    expect(contexto.jalados.map((jalado) => jalado.codigo)).toEqual(['100000S61T']);
    await expect(comoJson(contexto)).toMatchFileSnapshot(destino('contexto-plan1-jalado.json'));
  });

  it('contexto-desaprobado.json: Plan_de_Estudio_desaprobado.xlsx', async () => {
    const store = await crearStore('Plan_de_Estudio_desaprobado.xlsx');
    const contexto = buildAIContext(store.getState());
    expect(contexto.jalados.map((jalado) => jalado.codigo)).toContain('100000I60N');
    await expect(comoJson(contexto)).toMatchFileSnapshot(destino('contexto-desaprobado.json'));
  });

  it('contexto-sin-presupuesto.json: Plan_de_Estudio_1 con el 8vo, sin presupuesto', async () => {
    const contexto = buildAIContext((await crearPlan1ConOctavo()).getState());
    expect(contexto.financiero?.presupuestoMensual).toBeNull();
    await expect(comoJson(contexto)).toMatchFileSnapshot(destino('contexto-sin-presupuesto.json'));
  });

  it('contexto-limite-20h.json: el mismo plan con "Quiero armar un plan que tenga menos de 20h semanales"', async () => {
    const limites = detectarLimites('Quiero armar un plan que tenga menos de 20h semanales');
    const contexto = buildAIContext((await crearPlan1ConOctavo()).getState(), { presupuestoMensual: 900, limites });
    expect(contexto.propuestaConLimites?.periodos.every((periodo) => periodo.horas <= 20)).toBe(true);
    await expect(comoJson(contexto)).toMatchFileSnapshot(destino('contexto-limite-20h.json'));
  });
});
