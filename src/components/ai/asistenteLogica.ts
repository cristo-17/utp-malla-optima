import type { Curso } from '../../types/academic';
import type { AIFoco } from '../../application/ai/contracts';
import { obtenerPeriodoCurso } from '../../domain/rules/academicPeriodRules';
import { periodoBloqueadoPorCicloActual } from '../../domain/rules/academicContextRules';
import { nombrePeriodoCorto } from '../../domain/rules/jaladoRules';

/** Foco elegido con 📎; `etiqueta` es lo que se muestra en el chip. */
export type FocoUI =
  | { tipo: 'plan'; etiqueta: string }
  | { tipo: 'ciclo'; id: string; etiqueta: string }
  | { tipo: 'curso'; id: string; etiqueta: string };

export const focoParaEnviar = (foco: FocoUI | null): AIFoco | undefined =>
  !foco ? undefined : foco.tipo === 'plan' ? { tipo: 'plan' } : { tipo: foco.tipo, id: foco.id };

export const FOCO_PLAN: FocoUI = { tipo: 'plan', etiqueta: 'Mi plan completo' };

export const PREGUNTAS_RAPIDAS = [
  { emoji: '💰', texto: '¿Me alcanza mi presupuesto?' },
  { emoji: '😰', texto: '¿Estoy sobrecargado?' },
  { emoji: '🔀', texto: '¿Qué pasa si jalo un curso?' },
  { emoji: '🗺️', texto: 'Mi ruta hasta egresar' },
  { emoji: '🎯', texto: '¿Qué electivo me conviene?' },
  { emoji: '💸', texto: '¿Cómo funcionan los descuentos de la UTP?' },
] as const;

/** Entrada de 😊 que no es una pregunta: abre Autogenerar para armar el plan con límites. */
export const ACCION_ARMAR_PLAN = { emoji: '🗓️', texto: 'Armar mi plan con límites' } as const;

export const preguntasPorFoco = (foco: FocoUI | null): string[] => {
  if (!foco) return [];
  if (foco.tipo === 'curso') return ['¿Qué pasa si lo jalo?', '¿Me conviene llevarlo ahora?', '¿Cuánto me cuesta?'];
  if (foco.tipo === 'ciclo') return ['¿Estoy sobrecargado en este ciclo?', '¿Cuánto me cuesta este ciclo?', '¿Qué curso de este ciclo es más importante?'];
  return ['¿Cómo ves mi plan?', 'Mi ruta hasta egresar', '¿Me alcanza mi presupuesto?'];
};

/** Texto comparable de una pregunta: sin tildes, mayúsculas, signos ni espacios repetidos. */
export const normalizarPregunta = (texto: string): string => texto.toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Quita las repetidas (dentro de la lista y respecto de `excluir`) comparando el texto normalizado. */
export const sinRepetidas = (preguntas: string[], excluir: string[] = []): string[] => {
  const vistas = new Set(excluir.map(normalizarPregunta));
  return preguntas.filter((pregunta) => {
    const clave = normalizarPregunta(pregunta);
    if (!clave || vistas.has(clave)) return false;
    vistas.add(clave);
    return true;
  });
};

const claveFoco = (foco: FocoUI | null) => !foco ? '' : foco.tipo === 'plan' ? 'plan' : `${foco.tipo}:${foco.id}`;
export const mismoFoco = (a: FocoUI | null, b: FocoUI | null) => claveFoco(a) === claveFoco(b);

export interface OpcionesAdjuntar {
  periodos: { id: string; etiqueta: string; cursos: number }[];
  cursos: { codigo: string; nombre: string }[];
}

/** Periodos planificados (futuros) y cursos por los que se puede preguntar con 📎. */
export const opcionesAdjuntar = (cursos: Curso[], cicloActual: number | null): OpcionesAdjuntar => {
  const periodos = new Map<string, { id: string; etiqueta: string; cursos: number; orden: number }>();
  for (const curso of cursos) {
    if (curso.estado !== 'PENDIENTE' || curso.ubicacion !== 'periodo') continue;
    const periodo = obtenerPeriodoCurso(curso);
    if (cicloActual && periodoBloqueadoPorCicloActual(periodo, cicloActual)) continue;
    const actual = periodos.get(periodo.id);
    periodos.set(periodo.id, { id: periodo.id, etiqueta: nombrePeriodoCorto(periodo), cursos: (actual?.cursos ?? 0) + 1, orden: periodo.orden });
  }
  return {
    periodos: [...periodos.values()].sort((a, b) => a.orden - b.orden).map(({ id, etiqueta, cursos: total }) => ({ id, etiqueta, cursos: total })),
    cursos: cursos.filter((curso) => curso.estado === 'PENDIENTE' || curso.estado === 'EN_CURSO')
      .map(({ codigo, nombre }) => ({ codigo, nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  };
};

const normalizar = (texto: string) => texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export const filtrarCursos = (cursos: OpcionesAdjuntar['cursos'], busqueda: string) => {
  const termino = normalizar(busqueda.trim());
  return termino ? cursos.filter((curso) => normalizar(`${curso.nombre} ${curso.codigo}`).includes(termino)) : cursos;
};

export interface EstadoFab {
  sinMalla: boolean;
  arrastrando: boolean;
  cursoAMover: string | null;
  panelAbierto: boolean;
  estrategiaAbierta: boolean;
}

/** El botón flotante no debe tapar el arrastre, la barra "Moviendo curso" ni los paneles. */
export const debeOcultarFab = (estado: EstadoFab): boolean =>
  estado.sinMalla || estado.arrastrando || Boolean(estado.cursoAMover) || estado.panelAbierto || estado.estrategiaAbierta;

/** Parte un texto para resaltar los códigos de curso que aparezcan en él. */
export const partirPorCodigos = (texto: string, codigos: string[]): { texto: string; codigo: boolean }[] => {
  const validos = codigos.filter(Boolean);
  if (!validos.length) return [{ texto, codigo: false }];
  const patron = new RegExp(`(${validos.map((codigo) => codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return texto.split(patron).filter(Boolean).map((parte) => ({ texto: parte, codigo: validos.includes(parte) }));
};

/** localStorage dentro de try/catch: en modo privado o con datos bloqueados se sigue sin recordar. */
export const almacen = {
  leer(clave: string): boolean {
    try {
      return window.localStorage.getItem(clave) === '1';
    } catch {
      return false;
    }
  },
  guardar(clave: string): void {
    try {
      window.localStorage.setItem(clave, '1');
    } catch {
      // Sin almacenamiento se vuelve a mostrar en la próxima visita.
    }
  },
};

export const CLAVES_ASISTENTE = {
  saludo: 'mallau.asistente.saludoVisto',
  privacidad: 'mallau.asistente.privacidadAceptada',
  tooltipRapidas: 'mallau.asistente.tooltipRapidasVisto',
} as const;
