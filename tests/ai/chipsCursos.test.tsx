import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AsistenteMensajes } from '../../src/components/ai/AsistenteMensajes';
import { codigosProximoPeriodo, cursosParaMostrar, MAX_CHIPS_CURSOS } from '../../src/components/ai/asistenteLogica';
import type { Curso } from '../../src/types/academic';

const curso = (codigo: string, cambios: Partial<Curso> = {}): Curso => ({
  codigo, nombre: codigo, ciclo: 8, cicloOrigen: 8, tipoPeriodo: 'REGULAR', ubicacion: 'periodo',
  horasSemanales: 4, creditos: 4, tipo: 'OBLIGATORIO', prerrequisitos: [], estado: 'PENDIENTE', ...cambios,
});

describe('chips de cursos de una respuesta', () => {
  it('máximo 5, primero los del próximo periodo y después en el orden de la IA, sin repetir', () => {
    const codigos = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'B'];
    expect(MAX_CHIPS_CURSOS).toBe(5);
    expect(cursosParaMostrar(codigos)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(cursosParaMostrar(codigos, ['F', 'G'])).toEqual(['F', 'G', 'A', 'B', 'C']);
  });

  it('el próximo periodo es el ciclo actual + 1 (pendientes ubicados)', () => {
    const cursos = [curso('A'), curso('B', { ciclo: 9 }), curso('C', { ubicacion: 'banco' }), curso('D', { estado: 'EN_CURSO', ciclo: 7 })];
    expect(codigosProximoPeriodo(cursos, 7)).toEqual(['A']);
    expect(codigosProximoPeriodo(cursos, null)).toEqual([]);
  });

  it('una respuesta con 7 cursos muestra 5 chips', () => {
    const codigos = ['100000A001', '100000A002', '100000A003', '100000A004', '100000A005', '100000A006', '100000A007'];
    const html = renderToStaticMarkup(<AsistenteMensajes nombres={new Map()} enviando={false} deshabilitado={false}
      onPreguntar={() => undefined} onReintentar={() => undefined} prioridadCursos={['100000A007']}
      mensajes={[{ id: 1, rol: 'assistant', tipo: 'texto', texto: 'Mira estos cursos.', cursos: codigos, preguntas: [] }]} />);
    const chips = [...html.matchAll(/<li><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(chips).toEqual(['100000A007', '100000A001', '100000A002', '100000A003', '100000A004']);
  });
});
