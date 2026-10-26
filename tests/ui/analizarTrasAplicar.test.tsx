import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import type { AIRequest } from '../../src/application/ai/contracts';
import { buildAIContext } from '../../src/application/ai/buildAIContext';
import { PrerequisitoToast } from '../../src/components/PrerequisitoToast';
import { crearControladorAsistente } from '../../src/components/ai/controladorAsistente';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import type { AIClient } from '../../src/infrastructure/ai/HttpAIClient';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { useAcademicStore } from '../../src/store/useAcademicStore';
import type { AcademicStore } from '../../src/store/types';
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

/** En render de servidor zustand lee getInitialState(): se siembra también ahí. */
const sembrar = (estado: Partial<AcademicStore>) => {
  Object.assign(useAcademicStore.getInitialState(), estado);
  useAcademicStore.setState(estado);
};

const clienteFalso = () => {
  const peticiones: AIRequest[] = [];
  const cliente: AIClient = {
    esMock: true,
    enviar: vi.fn(async (peticion: AIRequest) => {
      peticiones.push(peticion);
      return { ok: true as const, respuesta: { texto: 'ok', cursos: [], preguntasSugeridas: [] } };
    }),
  };
  return { cliente, peticiones };
};

describe('Después de aplicar desde Autogenerar, analizar con el asistente (Q1)', () => {
  it('el toast dice "Listo, apliqué tu plan" y trae "Analizar con el asistente" y Deshacer', async () => {
    const store = await crearStore();
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima(), { ofrecerAnalisis: true });
    expect(store.getState().notificacionMovimiento).toMatchObject({ tipo: 'PLAN_APLICADO', deshacerPlan: true, analizarConAsistente: true });
    sembrar({ notificacionMovimiento: store.getState().notificacionMovimiento });
    const html = renderToStaticMarkup(<PrerequisitoToast />);
    expect(html).toContain('Listo, apliqué tu plan');
    expect(html).toContain('Analizar con el asistente');
    expect(html).toContain('Deshacer');
    sembrar({ notificacionMovimiento: null });
  });

  it('aplicado desde el chat (o sin el modal), el toast no repite el análisis: lo ofrece el mensaje de la app', async () => {
    const store = await crearStore();
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima());
    sembrar({ notificacionMovimiento: store.getState().notificacionMovimiento });
    const html = renderToStaticMarkup(<PrerequisitoToast />);
    expect(html).toContain('Propuesta aplicada');
    expect(html).not.toContain('Analizar con el asistente');
    sembrar({ notificacionMovimiento: null });
  });

  it('el botón pide el análisis al asistente y cierra el toast; el asistente lo atiende una vez', async () => {
    const store = await crearStore();
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima(), { ofrecerAnalisis: true });
    store.getState().pedirAnalisisIA();
    expect(store.getState()).toMatchObject({ analisisPedido: true, notificacionMovimiento: null });
    store.getState().atenderAnalisisIA();
    expect(store.getState().analisisPedido).toBe(false);
  });

  it('lanza el análisis con el presupuesto compartido (el mismo de Autogenerar)', async () => {
    const store = await crearStore();
    store.getState().setPresupuestoMensual('800');
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima({ maxCuotaMensual: 800 }), { ofrecerAnalisis: true });
    const { cliente, peticiones } = clienteFalso();
    const controlador = crearControladorAsistente({
      cliente, privacidadAceptada: true, obtenerContexto: (opciones) => buildAIContext(store.getState(), opciones),
    });
    controlador.setPresupuesto(store.getState().presupuestoMensual);
    await controlador.pedirAnalisis();
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0].modo).toBe('analisis');
    expect(peticiones[0].contexto.financiero?.presupuestoMensual).toBe(800);
    // El análisis es de la malla ya aplicada: el Ciclo 8 tiene cursos.
    expect(peticiones[0].contexto.proximoPeriodo?.cursos.length).toBeGreaterThan(0);
  });

  it('sin el aviso de privacidad aceptado, el análisis sale al aceptarlo (y no si lo cancela)', async () => {
    const { cliente, peticiones } = clienteFalso();
    const store = await crearStore();
    const controlador = crearControladorAsistente({ cliente, obtenerContexto: (opciones) => buildAIContext(store.getState(), opciones) });
    await controlador.pedirAnalisis();
    expect(peticiones).toHaveLength(0);
    controlador.aceptarPrivacidad();
    await vi.waitFor(() => expect(peticiones).toHaveLength(1));
    expect(peticiones[0].modo).toBe('analisis');

    const otro = clienteFalso();
    const cancelado = crearControladorAsistente({ cliente: otro.cliente, obtenerContexto: (opciones) => buildAIContext(store.getState(), opciones) });
    await cancelado.pedirAnalisis();
    cancelado.cancelarAnalisisPendiente();
    cancelado.aceptarPrivacidad();
    expect(otro.peticiones).toHaveLength(0);
  });
});
