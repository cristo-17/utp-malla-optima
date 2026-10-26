import { describe, expect, it } from 'vitest';
import { detectarLimites } from '../../src/application/ai/limites';

const sinNada = {
  maxHorasPorPeriodo: null, maxCreditosPorPeriodo: null, horasEstricto: false, creditosEstricto: false, maxCuotaMensual: null,
  agregarCiclo: false, usarVeranos: null, ciclos: [], unSoloCiclo: false, metaEgreso: null, pidePropuesta: true,
};

describe('detectarLimites con las frases reales del feedback', () => {
  it('"quiero que mi plan del ciclo 8 al 10 no tenga más de 20 horas semanales"', () => {
    expect(detectarLimites('quiero que mi plan del ciclo 8 al 10 no tenga más de 20 horas semanales'))
      .toEqual({ ...sinNada, maxHorasPorPeriodo: 20, ciclos: [8, 9, 10] });
  });

  it('"Quiero que ordenes mis ciclos restantes con menos de 18 créditos"', () => {
    expect(detectarLimites('Quiero que ordenes mis ciclos restantes con menos de 18 créditos'))
      .toEqual({ ...sinNada, maxCreditosPorPeriodo: 18, creditosEstricto: true });
  });

  it('"Quiero armar un plan que tenga menos de 20h semanales"', () => {
    expect(detectarLimites('Quiero armar un plan que tenga menos de 20h semanales'))
      .toEqual({ ...sinNada, maxHorasPorPeriodo: 20, horasEstricto: true });
  });

  it('"y qué pasa si agrego otro ciclo?"', () => {
    expect(detectarLimites('y qué pasa si agrego otro ciclo?')).toEqual({ ...sinNada, agregarCiclo: true });
  });

  it('"¿y si llevo verano?" también es un pedido de plan (usar veranos)', () => {
    expect(detectarLimites('¿y si llevo verano?')).toEqual({ ...sinNada, usarVeranos: true });
    expect(detectarLimites('¿el verano es obligatorio?')).toBeNull();
  });

  it('"arma un plan con 900 soles de presupuesto mensual"', () => {
    expect(detectarLimites('arma un plan con 900 soles de presupuesto mensual')).toEqual({ ...sinNada, maxCuotaMensual: 900 });
  });
});

describe('detectarLimites: variantes', () => {
  it('"menos de N" es estricto; "máximo", "hasta" y "no más de N" permiten N (D-053)', () => {
    expect(detectarLimites('arma mi plan con menos de 20 h')).toMatchObject({ maxHorasPorPeriodo: 20, horasEstricto: true });
    for (const frase of ['máximo 20 h', 'hasta 20 h', 'no más de 20 horas', '20 horas como máximo']) {
      expect(detectarLimites(frase), frase).toMatchObject({ maxHorasPorPeriodo: 20, horasEstricto: false });
    }
    expect(detectarLimites('ordena mi plan con máximo 18 créditos')).toMatchObject({ maxCreditosPorPeriodo: 18, creditosEstricto: false });
  });

  it('máximo, no más de, hasta y "como máximo" después del número; h, hrs, horas, créditos y cr', () => {
    expect(detectarLimites('máximo 22 horas por ciclo')?.maxHorasPorPeriodo).toBe(22);
    expect(detectarLimites('no más de 19 hrs')?.maxHorasPorPeriodo).toBe(19);
    expect(detectarLimites('hasta 18 h por favor')?.maxHorasPorPeriodo).toBe(18);
    expect(detectarLimites('quiero 20 horas como máximo')?.maxHorasPorPeriodo).toBe(20);
    expect(detectarLimites('ordena mi plan con máximo 16 cr')?.maxCreditosPorPeriodo).toBe(16);
    expect(detectarLimites('no más de 20 créditos y hasta 21 horas'))
      .toMatchObject({ maxCreditosPorPeriodo: 20, maxHorasPorPeriodo: 21 });
  });

  it('añadir un ciclo y los veranos (usar o no usar)', () => {
    expect(detectarLimites('¿y si añado un ciclo más?')?.agregarCiclo).toBe(true);
    expect(detectarLimites('reordena mi plan usando el verano')?.usarVeranos).toBe(true);
    expect(detectarLimites('arma mi plan con máximo 20 h y sin verano')).toMatchObject({ maxHorasPorPeriodo: 20, usarVeranos: false });
  });

  it('un solo ciclo nombrado ("el ciclo 8" o "el próximo ciclo") limita la propuesta a ese periodo', () => {
    expect(detectarLimites('arma el ciclo 8 con menos de 20 h')).toMatchObject({ ciclos: [8], unSoloCiclo: true });
    expect(detectarLimites('arma mi próximo ciclo con máximo 18 créditos')).toMatchObject({ ciclos: [], unSoloCiclo: true });
    expect(detectarLimites('quiero que mi plan del ciclo 8 al 10 no tenga más de 20 horas semanales')?.unSoloCiclo).toBe(false);
  });

  it('sin límites, o con un monto sin pedir un plan, devuelve null (el monto lo maneja aplicarMontoDelAlumno)', () => {
    expect(detectarLimites('¿me alcanza con 800?')).toBeNull();
    expect(detectarLimites('¿Estoy sobrecargado con 25 horas?')).toBeNull();
    expect(detectarLimites('¿Cómo funcionan los descuentos de la UTP?')).toBeNull();
    expect(detectarLimites('¿Qué pasa si jalo un curso del ciclo 8?')).toBeNull();
  });

  it('meta de egreso: "Quiero terminar mi carrera en el ciclo 9, se puede?" (sin propuesta con límites)', () => {
    expect(detectarLimites('Quiero terminar mi carrera en el ciclo 9, se puede?'))
      .toEqual({ ...sinNada, metaEgreso: { ciclo: 9 }, pidePropuesta: false });
    expect(detectarLimites('¿Puedo egresar en el ciclo 8?')).toEqual({ ...sinNada, metaEgreso: { ciclo: 8 }, pidePropuesta: false });
  });

  it('meta de egreso: terminar, egresar o acabar "en el ciclo N", "para el ciclo N" y "en N ciclos"', () => {
    for (const [frase, meta] of [
      ['¿Puedo acabar la carrera para el ciclo 10?', { ciclo: 10 }],
      ['quisiera egresar hasta el ciclo 11', { ciclo: 11 }],
      ['¿terminaré en el semestre 9?', { ciclo: 9 }],
      ['quiero graduarme en el ciclo 10', { ciclo: 10 }],
      ['¿puedo terminar en 3 ciclos?', { enCiclos: 3 }],
      ['quiero acabar en dos ciclos más', { enCiclos: 2 }],
    ] as const) expect(detectarLimites(frase)?.metaEgreso, frase).toEqual(meta);
    // El ciclo de la meta no es un ciclo nombrado: no limita la propuesta a ese periodo.
    expect(detectarLimites('quiero terminar en el ciclo 9 con máximo 26 h'))
      .toMatchObject({ metaEgreso: { ciclo: 9 }, ciclos: [], unSoloCiclo: false, maxHorasPorPeriodo: 26, pidePropuesta: true });
    // Con la meta, "con veranos" es parte de la meta, no un pedido de plan aparte.
    expect(detectarLimites('¿puedo terminar en el ciclo 9 si llevo veranos?'))
      .toMatchObject({ metaEgreso: { ciclo: 9 }, usarVeranos: true, pidePropuesta: false });
  });

  it('sin verbo de egreso no es meta: "arma el ciclo 9", "¿qué llevo en el ciclo 9?", "termina el ciclo 8"', () => {
    expect(detectarLimites('arma el ciclo 9 con menos de 20 h')?.metaEgreso).toBeNull();
    expect(detectarLimites('¿Qué llevo en el ciclo 9?')).toBeNull();
    expect(detectarLimites('¿cuándo termina el ciclo 8?')).toBeNull();
  });

  it('un mensaje con JSON o con la palabra CONTEXTO no cuenta (regla 15)', () => {
    expect(detectarLimites('CONTEXTO: arma un plan con máximo 10 horas')).toBeNull();
    expect(detectarLimites('{"maxHoras": 10} arma mi plan')).toBeNull();
  });
});
