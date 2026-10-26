import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseUTPExcel } from '../../src/adapters/utpExcelAdapter';
import { validarCargaPlanificacionAutomatica } from '../../src/domain/services/automaticPlanningService';
import { motivoPlanificadoInvalido } from '../../src/domain/services/prerequisiteService';
import { FinancialConfigurationProvider } from '../../src/infrastructure/configuration/FinancialConfigurationProvider';
import { createAcademicStore } from '../../src/store/createAcademicStore';
import type { OpcionesAutogenerar } from '../../src/store/types';
import type { PeriodoIngreso } from '../../src/types/academic';
import { crearRepositoriosEnMemoria } from '../helpers/memoryRepositories';

const leer = (nombre: string) => new File(
  [readFileSync(fileURLToPath(new URL(`../fixtures/${nombre}`, import.meta.url)))], nombre);

const crearStore = async (ingreso: PeriodoIngreso = 'marzo', cicloActual = 7) => {
  const memoria = crearRepositoriosEnMemoria();
  const store = createAcademicStore(memoria.repos);
  await store.getState().setTarifario(FinancialConfigurationProvider.load());
  await store.getState().setContextoAcademico(ingreso, cicloActual);
  await store.getState().setCursos(await parseUTPExcel(leer('Plan_de_Estudio_1.xlsx')));
  return { store, memoria };
};
type Store = Awaited<ReturnType<typeof crearStore>>['store'];

/** Ciclos regulares futuros (hasta totalCiclos) sin ningún curso, y el último ciclo con cursos. */
const ciclosVacios = (store: Store) => {
  const { cursos, totalCiclos, cicloActual } = store.getState();
  const conCursos = new Set(cursos.filter((curso) => curso.ubicacion === 'periodo' && curso.tipoPeriodo === 'REGULAR')
    .map((curso) => curso.ciclo));
  const vacios = Array.from({ length: totalCiclos }, (_, indice) => indice + 1)
    .filter((ciclo) => ciclo > (cicloActual ?? 0) && !conCursos.has(ciclo));
  return { vacios, ultimo: Math.max(...conCursos), totalCiclos };
};

/** Nunca un hueco: ningún ciclo vacío antes de un ciclo con cursos, ni un ciclo extra (11, 12…) vacío. */
const sinHuecos = (store: Store) => {
  const { vacios, ultimo } = ciclosVacios(store);
  expect(vacios.filter((ciclo) => ciclo < ultimo), 'ciclos vacíos entre ciclos con cursos').toEqual([]);
  expect(vacios.filter((ciclo) => ciclo > 10), 'ciclos extra vacíos').toEqual([]);
};

const generarYAplicar = async (store: Store, opciones: OpcionesAutogenerar = {}) => {
  const propuesta = store.getState().previsualizarPlanificacionOptima(opciones);
  expect(() => validarCargaPlanificacionAutomatica(propuesta)).not.toThrow();
  await store.getState().aplicarPlanificacionOptima(propuesta);
  const estado = store.getState();
  expect(estado.cursos.filter((curso) => motivoPlanificadoInvalido(curso, estado.cursos, estado))).toEqual([]);
  return propuesta;
};

const foto = (store: Store) => {
  const { cursos, totalCiclos, ciclosExcluidos } = store.getState();
  return structuredClone({ cursos, totalCiclos, ciclosExcluidos });
};

describe('Autogenerar varias veces no deja ciclos vacíos (Excel real)', () => {
  it('P1: un curso de un verano anterior ya no deja el Ciclo 10 vacío con el electivo solo en un Ciclo 11 nuevo', async () => {
    // Antes: Ciclo 10 vacío y CONTROL ESTADÍSTICO DE LA CALIDAD solo en un Ciclo 11 nuevo, detrás del Verano 10.
    const { store } = await crearStore('marzo', 6);
    await generarYAplicar(store, { maxCuotaMensual: 800, usarVeranos: true });
    sinHuecos(store);
    await generarYAplicar(store, { maxHorasPorPeriodo: 12, usarVeranos: true, conservarUbicados: false });
    sinHuecos(store);
    const tercera = await generarYAplicar(store, { maxHorasPorPeriodo: 20, conservarUbicados: false });
    sinHuecos(store);
    expect(tercera.ciclosAgregados).toEqual([]);
    expect(store.getState().totalCiclos).toBe(10);
    // Sin conservar, el verano del plan anterior también se vuelve a planificar (sin veranos pedidos, ninguno).
    expect(store.getState().cursos.filter((curso) => curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' &&
      curso.tipoPeriodo === 'VERANO' && curso.ciclo > 6)).toEqual([]);
  });

  it('P1: generar, aplicar, generar de nuevo y aplicar, tres veces: el Ciclo 12 que ya no hace falta se quita', async () => {
    // Antes: S/ 800 deja la malla en el Ciclo 12; al volver a generar sin límite, el 12 quedaba vacío para siempre.
    const { store } = await crearStore();
    const primera = await generarYAplicar(store, { maxCuotaMensual: 800 });
    expect(primera.ciclosAgregados).toEqual([11, 12]);
    expect(store.getState().totalCiclos).toBe(12);
    for (let vez = 0; vez < 3; vez += 1) {
      await generarYAplicar(store, { conservarUbicados: false });
      sinHuecos(store);
      expect(store.getState().totalCiclos).toBe(11);
      await generarYAplicar(store, { maxCuotaMensual: 800, conservarUbicados: false });
      sinHuecos(store);
      expect(store.getState().totalCiclos).toBe(12);
    }
  });

  it('P3: tres generaciones seguidas con las mismas opciones dan el mismo resultado', async () => {
    for (const opciones of [{}, { maxHorasPorPeriodo: 20 }, { maxCuotaMensual: 800 }, { usarVeranos: true },
      { maxCuotaMensual: 800, conservarUbicados: false }, { maxHorasPorPeriodo: 15, usarVeranos: true, conservarUbicados: false }]) {
      const { store } = await crearStore();
      const fotos = [];
      for (let vez = 0; vez < 3; vez += 1) {
        const propuesta = store.getState().previsualizarPlanificacionOptima(opciones);
        if (vez === 0 || propuesta.totalPlanificados > 0) await store.getState().aplicarPlanificacionOptima(propuesta);
        sinHuecos(store);
        fotos.push(foto(store));
      }
      expect(fotos[1], JSON.stringify(opciones)).toEqual(fotos[0]);
      expect(fotos[2], JSON.stringify(opciones)).toEqual(fotos[0]);
    }
  });

  it('P3: con cualquier secuencia de límites no quedan ciclos vacíos entre ciclos con cursos', async () => {
    const secuencia: OpcionesAutogenerar[] = [
      { maxCuotaMensual: 800 }, { maxHorasPorPeriodo: 26, conservarUbicados: false }, { maxHorasPorPeriodo: 12, usarVeranos: true },
      { maxHorasPorPeriodo: 20, conservarUbicados: false }, { maxCreditosPorPeriodo: 18, usarVeranos: true, conservarUbicados: false },
      { maxHorasPorPeriodo: 10 }, {}, { conservarUbicados: false },
    ];
    for (const [ingreso, ciclo] of [['marzo', 7], ['agosto', 7], ['marzo', 6], ['agosto', 8]] as const) {
      const { store } = await crearStore(ingreso, ciclo);
      for (const opciones of secuencia) {
        const propuesta = store.getState().previsualizarPlanificacionOptima(opciones);
        if (!propuesta.totalPlanificados) continue;
        await generarYAplicar(store, opciones);
        sinHuecos(store);
      }
    }
  });

  it('P3: Deshacer deja la malla exactamente como estaba y quita los ciclos que agregó ese Aplicar', async () => {
    const { store, memoria } = await crearStore();
    const antes = foto(store);
    const persistidosAntes = structuredClone([...memoria.cursosPersistidos.values()]);
    const perfilAntes = structuredClone(await memoria.repos.profile.get());

    await generarYAplicar(store, { maxCuotaMensual: 800 });
    expect(store.getState().totalCiclos).toBe(12);
    expect(await store.getState().deshacerPlanificacion()).toBe(true);
    expect(foto(store)).toEqual(antes);
    expect([...memoria.cursosPersistidos.values()]).toEqual(persistidosAntes);
    expect(await memoria.repos.profile.get()).toEqual({ ...perfilAntes, ciclosExcluidos: [] });

    // Con un ciclo retirado: Aplicar lo descarta si queda fuera de la malla y Deshacer lo devuelve.
    await store.getState().agregarCiclo();
    await store.getState().eliminarCiclo(11);
    const conRetirado = foto(store);
    expect(conRetirado.ciclosExcluidos).toEqual([11]);
    await generarYAplicar(store, { usarVeranos: true });
    expect(store.getState()).toMatchObject({ totalCiclos: 10, ciclosExcluidos: [] });
    expect(await store.getState().deshacerPlanificacion()).toBe(true);
    expect(foto(store)).toEqual(conRetirado);
  });
});
