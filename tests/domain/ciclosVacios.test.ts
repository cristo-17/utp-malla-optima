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
});
