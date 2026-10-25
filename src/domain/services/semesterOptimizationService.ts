import type { Curso } from '../../types/academic';
import { calcularPrioridadesPendientes, type PrioridadPendiente } from './recommendationService';

export interface CursoOptimizado {
  cursos: Curso[];
  creditos: number;
  horas: number;
  impacto: number;
}

interface OpcionDP extends CursoOptimizado {
  longitud: number;
}

const ESCALA_HORAS = 1000;
const esMejorOpcion = (candidata: OpcionDP, actual?: OpcionDP): boolean => {
  if (!actual) return true;
  if (candidata.impacto !== actual.impacto) return candidata.impacto > actual.impacto;
  if (candidata.longitud !== actual.longitud) return candidata.longitud > actual.longitud;
  if (candidata.cursos.length !== actual.cursos.length) return candidata.cursos.length > actual.cursos.length;
  return candidata.horas > actual.horas;
};

/**
 * Mochila por horas. Con maxCreditos finito, los créditos también limitan (y el estado de la mochila
 * los incluye); si no, solo se suman para el resumen.
 */
export const optimizarSemestre = (
  cursosDisponibles: Curso[],
  maxHoras: number,
  prioridades: ReadonlyMap<string, PrioridadPendiente> = calcularPrioridadesPendientes(cursosDisponibles),
  maxCreditos = Infinity
): CursoOptimizado => {
  const vacio: OpcionDP = { cursos: [], creditos: 0, horas: 0, impacto: 0, longitud: 0 };
  if (!Number.isFinite(maxHoras) || maxHoras <= 0 || maxCreditos < 0) return vacio;

  const limite = Math.floor(maxHoras * ESCALA_HORAS);
  const conCreditos = Number.isFinite(maxCreditos);
  const clave = (peso: number, creditos: number) => conCreditos ? `${peso}|${creditos}` : `${peso}`;
  const dp = new Map<string, OpcionDP & { peso: number }>([[clave(0, 0), { ...vacio, peso: 0 }]]);
  for (const curso of cursosDisponibles) {
    if (!Number.isFinite(curso.horasSemanales) || curso.horasSemanales <= 0) continue;
    const peso = Math.ceil(curso.horasSemanales * ESCALA_HORAS - 1e-9);
    const prioridad = prioridades.get(curso.codigo);
    for (const opcion of [...dp.values()]) {
      const nuevoPeso = opcion.peso + peso;
      const horas = opcion.horas + curso.horasSemanales;
      const creditos = opcion.creditos + curso.creditos;
      if (nuevoPeso > limite || horas > maxHoras || creditos > maxCreditos) continue;

      const candidata = {
        cursos: [...opcion.cursos, curso],
        creditos,
        horas,
        impacto: opcion.impacto + (prioridad?.impacto ?? 0),
        longitud: opcion.longitud + (prioridad?.longitudCadena ?? 1),
        peso: nuevoPeso,
      };
      const llave = clave(nuevoPeso, creditos);
      if (esMejorOpcion(candidata, dp.get(llave))) dp.set(llave, candidata);
    }
  }

  let mejor = vacio;
  for (const opcion of dp.values()) if (esMejorOpcion(opcion, mejor)) mejor = opcion;
  return { cursos: mejor.cursos, creditos: mejor.creditos, horas: mejor.horas, impacto: mejor.impacto };
};
