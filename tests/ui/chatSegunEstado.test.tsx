import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { AutogenerarModal } from '../../src/components/AutogenerarModal';
import { AsistentePanel, type AccionesPanel } from '../../src/components/ai/AsistentePanel';
import { AsistenteMensajes } from '../../src/components/ai/AsistenteMensajes';
import { opcionesAdjuntar } from '../../src/components/ai/asistenteLogica';
import { crearControladorAsistente, historialParaEnviar } from '../../src/components/ai/controladorAsistente';
import { crearPeriodoRegular } from '../../src/domain/rules/academicPeriodRules';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { MockAIClient } from '../../src/infrastructure/ai/HttpAIClient';
import { avisoDePropuesta, cicloVacioProximo, textoPlanAplicado } from '../../src/presentation/messages/autogenerarMessages';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import { useAcademicStore } from '../../src/store/useAcademicStore';
import type { AcademicStore } from '../../src/store/types';
import { crearContextoMinimo } from '../helpers/aiContexto';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const leer = (nombre: string) => new File([readFileSync(fileURLToPath(new URL(`../fixtures/${nombre}`, import.meta.url)))], nombre);
const crearVacio = async () => {
  const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico('marzo', 7);
  return store;
};
const crearStore = async () => {
  const store = await crearVacio();
  await store.getState().setCursos(await parseUTPExcel(leer('Plan_de_Estudio_1.xlsx')));
  return store;
};
type Store = Awaited<ReturnType<typeof crearStore>>;

const sinAccion = () => undefined;
const acciones: AccionesPanel = {
  onCerrar: sinAccion, onNuevaConversacion: sinAccion, onAceptarPrivacidad: sinAccion, onCancelarPrivacidad: sinAccion,
  onAnalizar: sinAccion, onPresupuesto: sinAccion, onPreguntar: sinAccion, onReintentar: sinAccion,
  onAlternarPanel: sinAccion, onCerrarPanel: sinAccion, onElegirFoco: sinAccion, onQuitarFoco: sinAccion,
};

/** La bienvenida que muestra el panel con el estado actual de la malla (lo mismo que calcula Asistente). */
const bienvenida = (store: Store) => {
  const { cursos, cicloActual } = store.getState();
  const html = renderToStaticMarkup(<AsistentePanel {...acciones} enLinea nombres={new Map()} opciones={opcionesAdjuntar(cursos, cicloActual)}
    estado={{ mensajes: [], enviando: false, privacidadAceptada: true, foco: null, focoEnviado: false, panel: null, presupuesto: '' }}
    mostrarTooltipRapidas={false} sinMalla={cursos.length === 0} cicloVacio={cicloVacioProximo(cursos, cicloActual)}
    onAutogenerar={sinAccion} onSubirExcel={sinAccion} onArmarAMano={sinAccion} />);
  if (html.includes('Sube tu Excel')) return 'sinMalla';
  if (html.includes('está vacío')) return 'vacio';
  return html.includes('Analizar mi plan') ? 'conCursos' : '?';
};

describe('chat: una sola acción según el estado (transiciones)', () => {
  it('sin malla → al importar el Excel, ciclo vacío', async () => {
    const store = await crearVacio();
    expect(bienvenida(store)).toBe('sinMalla');
    await store.getState().setCursos(await parseUTPExcel(leer('Plan_de_Estudio_1.xlsx')));
    expect(bienvenida(store)).toBe('vacio');
  });

  it('vacío → aplicar: con cursos; Deshacer: vuelve la tarjeta; aplicar y Limpiar plan: también vuelve', async () => {
    const store = await crearStore();
    expect(bienvenida(store)).toBe('vacio');
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima({ alcance: 'proximoPeriodo' }));
    expect(bienvenida(store)).toBe('conCursos');
    await store.getState().deshacerPlanificacion();
    expect(bienvenida(store)).toBe('vacio');
    await store.getState().aplicarPlanificacionOptima(store.getState().previsualizarPlanificacionOptima());
    expect(bienvenida(store)).toBe('conCursos');
    await store.getState().reiniciarPlanificacion();
    expect(bienvenida(store)).toBe('vacio');
  });

  it('arrastrar un curso al próximo ciclo también pasa a "con cursos"', async () => {
    const store = await crearStore();
    await store.getState().moverCursoAPeriodo('100000S71T', crearPeriodoRegular(8));
    expect(bienvenida(store)).toBe('conCursos');
  });
});

describe('chat: el mensaje de la app al aplicar desde el chat', () => {
  it('"Listo, armé tu Ciclo N: X cursos, Y h. ¿Lo analizo?" con los datos de la propuesta aplicada', async () => {
    const store = await crearStore();
    const propuesta = store.getState().previsualizarPlanificacionOptima({ alcance: 'proximoPeriodo', maxHorasPorPeriodo: 20 });
    expect(avisoDePropuesta(propuesta)).toEqual({ ciclo: 8, cursos: 5, horas: 19 });
    expect(textoPlanAplicado({ ciclo: 8, cursos: 5, horas: 19 })).toBe('Listo, armé tu Ciclo 8: 5 cursos, 19 h. ¿Lo analizo?');
  });

  it('es de la app: se muestra con Analizar mi plan, no va en el historial de la IA y se quita al deshacer', () => {
    const controlador = crearControladorAsistente({
      cliente: new MockAIClient({ esperaMs: 0 }), obtenerContexto: () => crearContextoMinimo(), privacidadAceptada: true,
    });
    controlador.agregarMensajeApp('Listo, armé tu Ciclo 8: 5 cursos, 19 h. ¿Lo analizo?');
    const { mensajes } = controlador.obtener();
    expect(historialParaEnviar(mensajes)).toEqual([]);
    const html = renderToStaticMarkup(<AsistenteMensajes mensajes={mensajes} nombres={new Map()} enviando={false} deshabilitado={false}
      onPreguntar={sinAccion} onReintentar={sinAccion} onAnalizar={sinAccion} />);
    expect(html).toContain('Listo, armé tu Ciclo 8: 5 cursos, 19 h. ¿Lo analizo?');
    expect(html).toContain('Analizar mi plan');
    controlador.quitarMensajesApp();
    expect(controlador.obtener().mensajes).toEqual([]);
  });

  it('abrir Autogenerar desde el chat marca el origen; desde la barra, no', () => {
    const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
    store.getState().abrirAutogenerar({ alcance: 'proximoPeriodo' }, 'chat');
    expect(store.getState().autogenerar).toEqual({ inicial: { alcance: 'proximoPeriodo' }, origen: 'chat' });
    store.getState().abrirAutogenerar();
    expect(store.getState().autogenerar).toEqual({ inicial: {} });
  });
});

describe('presupuesto compartido entre Autogenerar y Analizar mi plan', () => {
  const sembrar = (estado: Partial<AcademicStore>) => {
    Object.assign(useAcademicStore.getInitialState(), estado);
    useAcademicStore.setState(estado);
  };

  it('Autogenerar parte del presupuesto del chat; una propuesta con su propio monto (o sin monto) no lo pisa', async () => {
    const { cursos, tarifario, disciplinaActiva, cicloActual, periodoIngreso, totalCiclos, ciclosExcluidos, metodoPago } = (await crearStore()).getState();
    sembrar({ cursos, tarifario, disciplinaActiva, cicloActual, periodoIngreso, totalCiclos, ciclosExcluidos, metodoPago,
      presupuestoMensual: '800', autogenerar: { inicial: {} } });
    expect(renderToStaticMarkup(<AutogenerarModal />)).toContain('value="800"');
    sembrar({ autogenerar: { inicial: { maxCuotaMensual: null, maxHorasPorPeriodo: 20 } } });
    expect(renderToStaticMarkup(<AutogenerarModal />)).not.toContain('value="800"');
    sembrar({ autogenerar: null, presupuestoMensual: '' });
  });

  it('el store guarda un solo valor para los dos campos', () => {
    const store = createAcademicStore(crearRepositoriosEnMemoria().repos);
    store.getState().setPresupuestoMensual('900');
    expect(store.getState().presupuestoMensual).toBe('900');
  });
});
