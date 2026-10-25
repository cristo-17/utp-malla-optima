import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { AutogenerarModal } from '../../src/components/AutogenerarModal';
import { PrerequisitoToast } from '../../src/components/PrerequisitoToast';
import { AsistentePanel, type AccionesPanel } from '../../src/components/ai/AsistentePanel';
import { opcionesAdjuntar } from '../../src/components/ai/asistenteLogica';
import { crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { cicloVacioProximo } from '../../src/presentation/messages/autogenerarMessages';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { useAcademicStore } from '../../src/store/useAcademicStore';
import type { AcademicStore } from '../../src/store/types';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const leer = (nombre: string) => new File(
  [readFileSync(fileURLToPath(new URL(`../fixtures/${nombre}`, import.meta.url)))], nombre);

const crearStore = async () => {
  const memoria = crearRepositoriosEnMemoria();
  const store = createAcademicStore(memoria.repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico('marzo', 7);
  await store.getState().setCursos(await parseUTPExcel(leer('Plan_de_Estudio_1.xlsx')));
  return { store, memoria };
};

/** En render de servidor zustand lee getInitialState(): se siembra también ahí. */
const sembrar = (estado: Partial<AcademicStore>) => {
  Object.assign(useAcademicStore.getInitialState(), estado);
  useAcademicStore.setState(estado);
};

const estadoDe = (store: Awaited<ReturnType<typeof crearStore>>['store']): Partial<AcademicStore> => {
  const { cursos, tarifario, disciplinaActiva, cicloActual, periodoIngreso, totalCiclos, ciclosExcluidos, metodoPago, pagoUnicoPorPeriodo } = store.getState();
  return { cursos, tarifario, disciplinaActiva, cicloActual, periodoIngreso, totalCiclos, ciclosExcluidos, metodoPago, pagoUnicoPorPeriodo };
};

describe('Autogenerar - aplicar y deshacer', () => {
  it('aplicar ubica la propuesta, deja el toast con Deshacer y Deshacer restaura el estado anterior exacto', async () => {
    const { store, memoria } = await crearStore();
    expect(await store.getState().moverCursoAPeriodo('100000S71T', crearPeriodoRegular(9))).toBe(true);
    const antes = structuredClone(store.getState().cursos);
    const persistidosAntes = structuredClone([...memoria.cursosPersistidos.values()]);
    expect(store.getState().totalCiclos).toBe(10);

    const propuesta = store.getState().previsualizarPlanificacionOptima({ maxHorasPorPeriodo: 20 });
    await store.getState().aplicarPlanificacionOptima(propuesta);
    const despues = store.getState();
    expect(despues.totalCiclos).toBe(11);
    expect(despues.cursos.filter((curso) => curso.ubicacion === 'periodo' && curso.ciclo === 8 && curso.estado === 'PENDIENTE'))
      .toHaveLength(5);
    expect(despues.notificacionMovimiento).toMatchObject({ tipo: 'PLAN_APLICADO', deshacerPlan: true });
    expect(despues.notificacionMovimiento?.mensaje).toContain(`${propuesta.totalPlanificados} cursos ubicados`);

    expect(await store.getState().deshacerPlanificacion()).toBe(true);
    expect(store.getState().cursos).toEqual(antes);
    expect(store.getState().totalCiclos).toBe(10);
    expect([...memoria.cursosPersistidos.values()]).toEqual(persistidosAntes);
    expect(store.getState().notificacionMovimiento).toBeNull();
    // Solo se deshace una vez.
    expect(await store.getState().deshacerPlanificacion()).toBe(false);
  });

  it('el toast de la propuesta aplicada muestra Deshacer', async () => {
    const { store } = await crearStore();
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima());
    sembrar({ notificacionMovimiento: store.getState().notificacionMovimiento });
    const html = renderToStaticMarkup(<PrerequisitoToast />);
    expect(html).toContain('Propuesta aplicada');
    expect(html).toContain('Deshacer');
    sembrar({ notificacionMovimiento: null });
  });

  it('aplicar no toca la malla si cambió desde la vista previa', async () => {
    const { store } = await crearStore();
    const propuesta = store.getState().previsualizarPlanificacionOptima();
    await expect(store.getState().aplicarPlanificacionOptima({ ...propuesta, cursos: propuesta.cursos.slice(1) }))
      .rejects.toThrow('La malla cambió');
    expect(store.getState().planAnterior).toBeNull();
  });
});

describe('Autogenerar - modal y vista previa', () => {
  it('Próximo ciclo con 20 h: campos, vista previa del Ciclo 8 (19 h), lo que no entró y los botones', async () => {
    const { store } = await crearStore();
    sembrar({ ...estadoDe(store), autogenerar: { inicial: { alcance: 'proximoPeriodo', maxHorasPorPeriodo: 20 } } });
    const html = renderToStaticMarkup(<AutogenerarModal />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Arma tu plan con tus límites');
    for (const texto of ['Próximo ciclo (Ciclo 8)', 'Hasta egresar', 'Máximo de horas por ciclo', 'Máximo de créditos',
      'Presupuesto mensual (S/)', 'Usar veranos', 'Conservar lo que ya ubiqué', 'Aplicar a mi malla', 'Cancelar']) {
      expect(html, texto).toContain(texto);
    }
    expect(html).toContain('value="20"');
    expect(html).toContain('Ciclo 8<span>5 cursos · 19 h · 17 cr · S/ 815.00/mes</span>');
    expect(html).toContain('No entraron en el Ciclo 8');
    expect(html).not.toContain('Ciclo 9<span>');
    sembrar({ autogenerar: null });
  });

  it('Hasta egresar con 20 h avisa "Necesitas 1 ciclo más"; con veranos, "Se usa el Verano 8"', async () => {
    const { store } = await crearStore();
    sembrar({ ...estadoDe(store), autogenerar: { inicial: { alcance: 'hastaEgresar', maxHorasPorPeriodo: 20 } } });
    expect(renderToStaticMarkup(<AutogenerarModal />)).toContain('Necesitas 1 ciclo más (Ciclo 11).');
    sembrar({ autogenerar: { inicial: { alcance: 'hastaEgresar', maxHorasPorPeriodo: 20, usarVeranos: true } } });
    const html = renderToStaticMarkup(<AutogenerarModal />);
    expect(html).toContain('Se usa el Verano 8.');
    expect(html).not.toContain('Necesitas 1 ciclo más');
    sembrar({ autogenerar: null });
  });

  it('con presupuesto dice cuántas horas paga: S/ 800 → 15 h', async () => {
    const { store } = await crearStore();
    sembrar({ ...estadoDe(store), autogenerar: { inicial: { maxCuotaMensual: 800 } } });
    expect(renderToStaticMarkup(<AutogenerarModal />)).toContain('Con S/ 800.00 al mes (Sin descuento) pagas hasta 15 h por ciclo.');
    sembrar({ autogenerar: null });
  });

  it('cerrado no renderiza nada', () => {
    sembrar({ autogenerar: null });
    expect(renderToStaticMarkup(<AutogenerarModal />)).toBe('');
  });

  it('en celular es pantalla completa y solo usa los tokens de color (modo oscuro por theme.css)', () => {
    const css = readFileSync(fileURLToPath(new URL('../../src/styles/autogenerar.css', import.meta.url)), 'utf8');
    const celular = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(celular).toMatch(/\.autogen-modal \{[^}]*width: 100vw; height: 100dvh;/);
    expect(css).toContain('background: var(--bg-surface)');
    expect(readFileSync(fileURLToPath(new URL('../../src/styles/globals.css', import.meta.url)), 'utf8'))
      .toContain("@import './autogenerar.css';");
  });
});

describe('Asistente - tarjeta del periodo vacío', () => {
  const sinAccion = () => undefined;
  const acciones: AccionesPanel = {
    onCerrar: sinAccion, onNuevaConversacion: sinAccion, onAceptarPrivacidad: sinAccion, onCancelarPrivacidad: sinAccion,
    onAnalizar: sinAccion, onPresupuesto: sinAccion, onPreguntar: sinAccion, onReintentar: sinAccion,
    onAlternarPanel: sinAccion, onCerrarPanel: sinAccion, onElegirFoco: sinAccion, onQuitarFoco: sinAccion,
  };
  const estado = { mensajes: [], enviando: false, privacidadAceptada: true, foco: null, focoEnviado: false, panel: null, presupuesto: '' };
  const render = (cicloVacio: number | null) => renderToStaticMarkup(<AsistentePanel {...acciones} estado={estado} enLinea
    nombres={new Map()} opciones={opcionesAdjuntar([], 7)} mostrarTooltipRapidas={false} cicloVacio={cicloVacio}
    onAutogenerar={sinAccion} />);

  it('con el Ciclo 8 vacío la tarjeta "¿Lo armo?" con Autogenerar va antes de "Analizar mi plan"', () => {
    const html = render(8);
    expect(html).toContain('Tu Ciclo 8 está vacío. ¿Lo armo?');
    expect(html).toContain('Autogenerar');
    expect(html.indexOf('Tu Ciclo 8 está vacío')).toBeLessThan(html.indexOf('Analizar mi plan'));
  });

  it('con el próximo ciclo armado no aparece y "Analizar mi plan" sigue disponible', () => {
    const html = render(null);
    expect(html).not.toContain('está vacío');
    expect(html).toContain('Analizar mi plan');
  });

  it('cicloVacioProximo: el Excel recién importado tiene el Ciclo 8 vacío; al ubicar un curso deja de estarlo', async () => {
    const { store } = await crearStore();
    expect(cicloVacioProximo(store.getState().cursos, 7)).toBe(8);
    await store.getState().moverCursoAPeriodo('100000S71T', crearPeriodoRegular(8));
    expect(cicloVacioProximo(store.getState().cursos, 7)).toBeNull();
    expect(cicloVacioProximo(store.getState().cursos, null)).toBeNull();
  });
});

describe('😊 "Armar mi plan con límites"', () => {
  it('es un botón de acción (abre Autogenerar), distinto de las preguntas', async () => {
    const { PanelRapidas } = await import('../../src/components/ai/AsistenteEntrada');
    const html = renderToStaticMarkup(<PanelRapidas onElegir={() => undefined} onArmarPlan={() => undefined} />);
    expect(html).toContain('ia-chip ia-chip-accion');
    expect(html).toContain('Armar mi plan con límites');
  });
});

describe('Autogenerar - lo ya ubicado que pasa el límite', () => {
  it('con "Conservar" avisa que el Ciclo 8 ubicado (25 h) pasa las 20 h; sin conservar, lo reordena y no avisa', async () => {
    const { store } = await crearStore();
    for (const codigo of ['100000S06I', '100000S72T', '100000S73T', '100000H01C', '100000TD09', '100000I62N', '100000S71T']) {
      await store.getState().moverCursoAPeriodo(codigo, crearPeriodoRegular(8));
    }
    sembrar({ ...estadoDe(store), autogenerar: { inicial: { alcance: 'hastaEgresar', maxHorasPorPeriodo: 20 } } });
    expect(renderToStaticMarkup(<AutogenerarModal />))
      .toContain('El Ciclo 8 que ya ubicaste pasa tu límite (25 h): desmarca «Conservar lo que ya ubiqué» para reordenarlo.');
    sembrar({ autogenerar: { inicial: { alcance: 'hastaEgresar', maxHorasPorPeriodo: 20, conservarUbicados: false } } });
    const html = renderToStaticMarkup(<AutogenerarModal />);
    expect(html).not.toContain('que ya ubicaste pasa tu límite');
    expect(html).toContain('Ciclo 8<span>5 cursos · 19 h');
    sembrar({ autogenerar: null });
  });
});
