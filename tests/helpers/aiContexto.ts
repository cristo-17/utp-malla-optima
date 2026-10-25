import type { AIContext } from '../../src/application/ai/contracts';

/** Contexto mínimo y válido para probar contratos y UI sin cargar el Excel. */
export const crearContextoMinimo = (cambios: Partial<AIContext> = {}): AIContext => ({
  version: 1,
  perfil: {
    periodoIngreso: 'marzo', cicloActual: 7, totalCiclos: 10, disciplina: 'Ingeniería y Arquitectura',
    creditos: { aprobados: 120, enCurso: 19, pendientesEnMalla: 60 },
    electivos: { cubiertos: 0, minimo: 3, faltantes: 3 },
  },
  catalogo: [
    { codigo: '100000I62N', nombre: 'INTELIGENCIA DE NEGOCIOS', estado: 'PENDIENTE', tipo: 'OBLIGATORIO', creditos: 4, ubicacion: 'ciclo-8' },
    { codigo: '100000S61T', nombre: 'HERRAMIENTAS DE DESARROLLO', estado: 'EN_CURSO', tipo: 'OBLIGATORIO', creditos: 3, ubicacion: 'ciclo-7' },
    { codigo: '100000I64M', nombre: 'CALIDAD DE SOFTWARE', estado: 'PENDIENTE', tipo: 'ELECTIVO', creditos: 3, ubicacion: 'banco' },
  ],
  periodosPlanificados: [{ id: 'ciclo-8', etiqueta: 'Ciclo 8', cursos: ['100000I62N'], horas: 4, creditos: 4 }],
  proximoPeriodo: {
    id: 'ciclo-8', etiqueta: 'Ciclo 8', totalHoras: 4, totalCreditos: 4, horasExceso: 0,
    cursos: [{
      codigo: '100000I62N', nombre: 'INTELIGENCIA DE NEGOCIOS', creditos: 4, horas: 4, tipo: 'OBLIGATORIO',
      impacto: 2, longitudCadena: 2, esLaboratorio: false, jalado: false,
    }],
  },
  jalados: [],
  financiero: {
    moneda: 'PEN', referencia: 'Tarifario 2026 (referencial)',
    metodoPagoElegido: { id: 'sin_descuento', nombre: 'Sin descuento' },
    costoHoraAdicional: 38.81, presupuestoMensual: null, presupuestoFuente: null,
    proximoPeriodo: [{
      id: 'sin_descuento', nombre: 'Sin descuento', matricula: 398, numeroCuotas: 5,
      cuotaMensual: 407.5, total: 2435.5, diferenciaPresupuesto: null,
    }],
    planCompleto: [{ id: 'sin_descuento', nombre: 'Sin descuento', total: 2435.5 }],
  },
  carga: {
    nivel: 'ok', puntos: 0, horas: 4, topeEscala: 22, limiteRecomendado: 24,
    cursos4HorasOMas: 1, laboratorios: 0, cadenasLargas: 0, motivos: [],
  },
  whatIf: [{ codigo: '100000S61T', origen: 'EN_CURSO', cursosBloqueados: ['100000I62N'], planificadosInvalidos: [], ventanaSiJala: ['ciclo-8'] }],
  rutaSugerida: {
    propuesta: [{ periodoId: 'ciclo-8', cursos: ['100000I62N'] }], ciclosRestantes: 1, cicloFinal: 8, noPlanificados: [], aplicadaEnMalla: true,
  },
  electivos: [{
    codigo: '100000I64M', nombre: 'CALIDAD DE SOFTWARE', creditos: 3, horas: 3,
    area: 'Ingeniería de software', areaConfirmada: false, ubicacion: 'banco',
  }],
  limites: {
    creditosMinimos: 12, creditosMaximos: 40, horasRecomendadasPeriodo: 24, horasMaximasPlanificacion: 22,
    creditosMaximosVerano: 11, creditosMinimosElectivos: 3, factorHorasVerano: 2, topeEscalaPension: 22,
  },
  foco: null,
  derivados: {
    horas: { proximoPeriodo: 4, topeEscala: 22, sobreTopeEscala: 0, margenTopeEscala: 18, recomendadas: 24, sobreRecomendadas: 0, margenRecomendadas: 20 },
    presupuesto: null,
    pagoUnico: null,
    horasSinCadaCurso: [{ codigo: '100000I62N', nombre: 'INTELIGENCIA DE NEGOCIOS', horasSinElCurso: 0, quedaBajoTopeEscala: true }],
    creditosElectivosFaltantes: 3,
    creditos: {
      totalMalla: 10, obligatorios: 7, electivosMinimos: 3, paraEgresar: 10, aprobadosQueCuentan: 0, enCurso: 3,
      faltanParaEgresar: 10, faltanSiApruebaEnCurso: 7, ciclosRestantes: 1,
    },
    cursosProximoPeriodo: [{
      codigo: '100000I62N', nombre: 'INTELIGENCIA DE NEGOCIOS', creditos: 4, horas: 4, estado: 'PENDIENTE',
      jalado: false, sePuedeMover: true, bloquearia: [],
    }],
    proximoPeriodoConJalados: null,
    planificadosBloqueadosPorJalado: [],
  },
  propuestaConLimites: null,
  ...cambios,
});
