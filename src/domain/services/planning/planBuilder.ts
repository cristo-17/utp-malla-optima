import type { Curso, PeriodoAcademico } from '../../../types/academic';
import {
  determinarPeriodoEnCurso, obtenerPeriodoCurso, crearPeriodoRegular, crearPeriodoVerano,
} from '../../rules/academicPeriodRules';
import {
  FACTOR_HORAS_VERANO, LIMITE_CREDITOS_VERANO, LIMITE_HORAS_PLANIFICACION, LIMITE_HORAS_PERIODO, MINIMO_CREDITOS_ELECTIVOS,
  calcularHorasEfectivas, validarLimiteCreditosVerano,
} from '../../rules/planningRules';
import { calcularPrioridadesPendientes } from '../recommendationService';
import { optimizarSemestre } from '../semesterOptimizationService';
import {
  MAXIMO_CICLOS, determinarTotalCiclos, normalizarTotalCiclos, normalizarCiclosExcluidos, obtenerCiclosDisponibles,
} from '../../rules/cycleRules';
import { obtenerAsignacionesConservadas } from '../preservedPlanningAssignments';
import { periodoBloqueadoPorCicloActual, permiteVeranoDespuesDe } from '../../rules/academicContextRules';
import { esJaladoSinReplanificar } from '../../rules/courseRules';
import { esCursoJalado, nombrePeriodoCorto, ventanaDesdeCiclo } from '../../rules/jaladoRules';
import { prerrequisitosCumplidos } from './prerequisiteChecks';
import { horasValidas, motivosNoPlanificado } from './unplannedReasons';
import type {
  CicloPlanificadoResumen, CursoNoPlanificado, ExplicacionPlan, OpcionesPlanificacion, PeriodoPropuesto,
  ResultadoPlanificacionAutomatica,
} from './types';

const ESTADOS_COMPLETADOS = new Set(['APROBADO', 'CONVALIDADO']);
const EPSILON = 1e-9;
/** "Menos de N": el tope efectivo queda apenas debajo de N, así ningún periodo llega a N. */
const MARGEN_ESTRICTO = 1e-6;

const limitePositivo = (valor: number | null | undefined): number | null =>
  typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? valor : null;

const sumarCreditos = (cursos: Curso[]) => cursos.reduce((suma, curso) => suma + curso.creditos, 0);

/**
 * Una pasada del planificador con un conjunto fijo de veranos habilitados (ciclo de referencia de cada verano).
 * Reglas, en orden: los jalados en su ventana (D-015); los obligatorios por prioridad (cadena de prerrequisitos) y
 * ciclo de origen, sin pasar los límites; el periodo se completa con cualquier curso que todavía quepa; los
 * electivos solo hasta el mínimo de créditos; con alcance "hastaEgresar" se agregan ciclos (11, 12…) si hacen falta.
 */
const planificar = (
  cursosEntrada: Curso[], opciones: OpcionesPlanificacion, veranos: ReadonlySet<number>
): Omit<ResultadoPlanificacionAutomatica, 'comparacionSinLimites'> => {
  const alcance = opciones.alcance ?? 'hastaEgresar';
  const soloProximo = alcance === 'proximoPeriodo';
  const conservar = opciones.conservarUbicados ?? true;
  const limiteHoras = limitePositivo(opciones.maxHorasPorPeriodo) ?? LIMITE_HORAS_PLANIFICACION;
  const limiteHorasVerano = limitePositivo(opciones.maxHorasVerano) ?? limiteHoras;
  const limiteCreditos = limitePositivo(opciones.maxCreditosPorPeriodo);
  const limiteCreditosVerano = Math.min(LIMITE_CREDITOS_VERANO, limiteCreditos ?? Infinity);
  const horasEstricto = Boolean(opciones.horasEstricto);
  const creditosEstricto = Boolean(opciones.creditosEstricto && limiteCreditos !== null);
  const efectivo = (limite: number, estricto: boolean) => estricto ? limite - MARGEN_ESTRICTO : limite;

  const originales = new Map(cursosEntrada.map((curso) => [curso.codigo, curso]));
  const cursosBase = cursosEntrada.map((curso) => ({ ...curso }));
  const porCodigo = new Map(cursosBase.map((curso) => [curso.codigo, curso]));
  if (porCodigo.size !== cursosBase.length) throw new Error('La malla contiene códigos de curso duplicados.');
  const actualDetectado = determinarPeriodoEnCurso(cursosBase)?.cicloReferencia ?? 0;
  const cicloActual = opciones.cicloActual && Number.isFinite(opciones.cicloActual)
    ? normalizarTotalCiclos(opciones.cicloActual) : actualDetectado;
  const cicloInicio = cicloActual + 1;
  const periodoInicio = crearPeriodoRegular(cicloInicio);
  const cicloFinal = determinarTotalCiclos(cursosBase, opciones.totalCiclos);
  const ciclosExcluidos = normalizarCiclosExcluidos(opciones.ciclosExcluidos);
  const enCicloExcluido = new Set<string>();
  for (const curso of cursosBase) {
    if (curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' &&
        curso.tipoPeriodo === 'REGULAR' && ciclosExcluidos.includes(curso.ciclo)) {
      curso.ciclo = curso.cicloOrigen;
      curso.ubicacion = 'banco';
      enCicloExcluido.add(curso.codigo);
    }
  }
  // Regla UTP: los jalados van primero, en el PRIMER periodo de su ventana (el verano si
  // existe). Si el verano ya no admite sus créditos, van al ciclo regular de la ventana.
  const ventana = cicloActual > 0 ? ventanaDesdeCiclo(cicloActual, opciones) : [];
  const jalados = ventana.length ? cursosBase.filter(esCursoJalado) : [];
  const destinoJalado = new Map<string, PeriodoAcademico>();
  for (const curso of jalados) {
    const destino = ventana.find((periodo) => periodo.tipo === 'REGULAR' ||
      validarLimiteCreditosVerano([...cursosBase.filter((item) => item !== curso && item.estado === 'PENDIENTE' &&
        item.ubicacion === 'periodo' && obtenerPeriodoCurso(item).id === periodo.id), curso]).valido)!;
    destinoJalado.set(curso.codigo, destino);
    curso.ciclo = destino.cicloReferencia;
    curso.tipoPeriodo = destino.tipo;
    curso.ubicacion = 'periodo';
  }
  const enBloqueCerrado = (curso: Curso) => curso.ubicacion === 'periodo' && cicloActual > 0 &&
    !esJaladoSinReplanificar(curso, cicloActual) && periodoBloqueadoPorCicloActual(obtenerPeriodoCurso(curso), cicloActual);
  const electivoCubierto = (curso: Curso) => curso.tipo === 'ELECTIVO' &&
    (ESTADOS_COMPLETADOS.has(curso.estado) || curso.estado === 'EN_CURSO' || esCursoJalado(curso) ||
      curso.estado === 'PENDIENTE' && enBloqueCerrado(curso));
  const electivos = cursosBase.filter((curso) => curso.tipo === 'ELECTIVO' && curso.estado === 'PENDIENTE' &&
    !esCursoJalado(curso))
    .sort((a, b) => (horasValidas(a) ? a.horasSemanales : Infinity) - (horasValidas(b) ? b.horasSemanales : Infinity) ||
      b.creditos - a.creditos || a.codigo.localeCompare(b.codigo));

  // Con alcance "proximoPeriodo" solo se arma ese periodo: lo ubicado en los demás se conserva siempre. Sin
  // conservar, los veranos de un plan anterior también se vuelven a planificar (los jalados van igual a su ventana).
  const conservacion = {
    regulares: conservar || soloProximo,
    veranos: conservar || soloProximo,
    excepto: soloProximo && !conservar ? periodoInicio.id : undefined,
  };
  const calcularConservados = () =>
    obtenerAsignacionesConservadas(cursosBase, cicloActual, opciones.periodoIngreso, conservacion);
  const conservacionPrevia = conservacion.regulares ? calcularConservados() : null;
  // Solo se recalculan pendientes futuros; el historial y los bloques cerrados se conservan.
  for (const curso of electivos) {
    if (enBloqueCerrado(curso) || conservacionPrevia?.conservados.has(curso.codigo)) continue;
    curso.ciclo = curso.cicloOrigen;
    curso.tipoPeriodo = 'REGULAR';
    curso.ubicacion = 'banco';
  }
  const { conservados, asignaciones } = conservacionPrevia ?? calcularConservados();
  const nuevasAsignaciones = new Map<string, PeriodoAcademico>();
  for (const curso of jalados) {
    conservados.add(curso.codigo);
    asignaciones.set(curso.codigo, destinoJalado.get(curso.codigo)!);
    nuevasAsignaciones.set(curso.codigo, destinoJalado.get(curso.codigo)!);
  }

  // Electivos: solo hasta cubrir el mínimo de créditos, por menos horas y, en empate, más créditos.
  const creditosElectivosCubiertos = sumarCreditos(cursosBase.filter((curso) => electivoCubierto(curso) ||
    curso.tipo === 'ELECTIVO' && curso.estado === 'PENDIENTE' && conservados.has(curso.codigo) && curso.ubicacion === 'periodo'));
  const electivosElegidos: Curso[] = [];
  let creditosElectivosFaltantes = MINIMO_CREDITOS_ELECTIVOS - creditosElectivosCubiertos;
  for (const curso of electivos) {
    if (creditosElectivosFaltantes <= 0) break;
    if (conservados.has(curso.codigo) || enBloqueCerrado(curso)) continue;
    electivosElegidos.push(curso);
    creditosElectivosFaltantes -= curso.creditos;
  }
  const electivosPorUbicar = [...electivosElegidos];

  const pendientes = cursosBase.filter((curso) => curso.estado === 'PENDIENTE' &&
    curso.tipo !== 'ELECTIVO' && !conservados.has(curso.codigo));
  const restantes = new Map(pendientes.map((curso) => [curso.codigo, curso]));
  const ciclos: CicloPlanificadoResumen[] = [];

  // Periodos a planificar, en orden. Con "hastaEgresar" la lista crece (11, 12…) mientras falte algo por ubicar.
  const excluidos = new Set(ciclosExcluidos);
  const lista: PeriodoAcademico[] = [];
  const agregarCiclo = (ciclo: number) => {
    if (!excluidos.has(ciclo)) lista.push(crearPeriodoRegular(ciclo));
    if (veranos.has(ciclo)) lista.push(crearPeriodoVerano(ciclo));
  };
  if (soloProximo) {
    if (!excluidos.has(cicloInicio)) lista.push(periodoInicio);
  } else {
    if (cicloActual > 0 && veranos.has(cicloActual)) lista.push(crearPeriodoVerano(cicloActual));
    obtenerCiclosDisponibles(cicloFinal, ciclosExcluidos).filter((ciclo) => ciclo >= cicloInicio).forEach(agregarCiclo);
  }
  let ultimoCiclo = Math.max(cicloFinal, cicloInicio - 1);
  // El verano de la ventana que no está en la lista solo recibe jalados: se resume antes de los ciclos regulares.
  for (const periodo of ventana.filter((item) => item.tipo === 'VERANO' && !lista.some((otro) => otro.id === item.id))) {
    const carga = cursosBase.filter((curso) => curso.ubicacion === 'periodo' && conservados.has(curso.codigo) &&
      obtenerPeriodoCurso(curso).id === periodo.id);
    const jaladosVerano = carga.filter(esCursoJalado);
    if (!jaladosVerano.length) continue;
    ciclos.push({ ciclo: periodo.cicloReferencia, periodo,
      creditos: sumarCreditos(carga),
      horasEfectivas: calcularHorasEfectivas(carga, 'VERANO'), impacto: 0,
      cursos: jaladosVerano.map((curso) => ({ codigo: curso.codigo, nombre: curso.nombre, creditos: curso.creditos, impacto: 0 })) });
  }

  const cargaUbicadaEn = (periodo: PeriodoAcademico) => cursosBase.filter((curso) => curso.ubicacion === 'periodo' &&
    (curso.estado === 'EN_CURSO' || (curso.estado === 'PENDIENTE' && conservados.has(curso.codigo))) &&
    obtenerPeriodoCurso(curso).id === periodo.id);
  const ultimaOrdenObligatoria = () => cursosBase.reduce((orden, curso) => {
    if (curso.tipo === 'ELECTIVO') return orden;
    const periodo = nuevasAsignaciones.get(curso.codigo) ??
      (curso.ubicacion === 'periodo' && (curso.estado === 'EN_CURSO' || conservados.has(curso.codigo))
        ? obtenerPeriodoCurso(curso) : undefined);
    return periodo ? Math.max(orden, periodo.orden) : orden;
  }, periodoInicio.orden);
  const faltaUbicar = () => restantes.size > 0 || electivosPorUbicar.length > 0;
  // Alcance "proximoPeriodo": cursos que se podían llevar en el periodo pero no entraron por los límites.
  const noCabenEnProximo: Curso[] = [];
  // Periodos de la lista que quedaron sin ninguna carga: se reutilizan, en orden, antes de agregar un ciclo nuevo.
  const vacios: PeriodoAcademico[] = [];
  const reutilizarVacios = () => {
    for (const periodo of [...vacios]) {
      if (!faltaUbicar()) return;
      const esVerano = periodo.tipo === 'VERANO';
      const factor = esVerano ? FACTOR_HORAS_VERANO : 1;
      let horasDisponibles = efectivo(esVerano ? limiteHorasVerano : limiteHoras, horasEstricto) / factor;
      let creditosDisponibles = efectivo(esVerano ? limiteCreditosVerano : limiteCreditos ?? Infinity, creditosEstricto);
      const prioridades = calcularPrioridadesPendientes([...restantes.values()]);
      const seleccionados: Curso[] = [];
      for (const curso of [...restantes.values(), ...electivosPorUbicar]) {
        if (!horasValidas(curso) || curso.horasSemanales > horasDisponibles + EPSILON || curso.creditos > creditosDisponibles + EPSILON ||
            !prerrequisitosCumplidos(curso, periodo, porCodigo, asignaciones)) continue;
        seleccionados.push(curso);
        horasDisponibles -= curso.horasSemanales;
        creditosDisponibles -= curso.creditos;
        nuevasAsignaciones.set(curso.codigo, periodo);
        asignaciones.set(curso.codigo, periodo);
        restantes.delete(curso.codigo);
        if (electivosPorUbicar.includes(curso)) electivosPorUbicar.splice(electivosPorUbicar.indexOf(curso), 1);
      }
      if (!seleccionados.length) continue;
      vacios.splice(vacios.indexOf(periodo), 1);
      ciclos.push({
        ciclo: periodo.cicloReferencia, periodo,
        creditos: sumarCreditos(seleccionados),
        horasEfectivas: calcularHorasEfectivas(seleccionados, periodo.tipo),
        impacto: seleccionados.reduce((suma, curso) => suma + (prioridades.get(curso.codigo)?.impacto ?? 0), 0),
        cursos: seleccionados.map((curso) => ({
          codigo: curso.codigo, nombre: curso.nombre, creditos: curso.creditos, impacto: prioridades.get(curso.codigo)?.impacto ?? 0,
        })),
      });
    }
  };

  for (let indice = 0; ; indice += 1) {
    while (indice >= lista.length && !soloProximo && faltaUbicar() && ultimoCiclo < MAXIMO_CICLOS) {
      reutilizarVacios();
      if (!faltaUbicar()) break;
      ultimoCiclo += 1;
      agregarCiclo(ultimoCiclo);
    }
    if (indice >= lista.length) break;
    const periodo = lista[indice];
    if (!faltaUbicar() && ![...destinoJalado.values()].some((destino) => destino.id === periodo.id)) break;
    const esVerano = periodo.tipo === 'VERANO';
    const cargaConservada = cargaUbicadaEn(periodo);
    if (cargaConservada.some((curso) => !horasValidas(curso))) continue;
    const factor = esVerano ? FACTOR_HORAS_VERANO : 1;
    let horasDisponibles = Math.max(0,
      (efectivo(esVerano ? limiteHorasVerano : limiteHoras, horasEstricto) - calcularHorasEfectivas(cargaConservada, periodo.tipo)) / factor);
    let creditosDisponibles = efectivo(esVerano ? limiteCreditosVerano : limiteCreditos ?? Infinity, creditosEstricto) -
      sumarCreditos(cargaConservada);
    const prioridades = calcularPrioridadesPendientes([...restantes.values()]);
    const disponibles = [...restantes.values()].filter((curso) => horasValidas(curso) &&
      prerrequisitosCumplidos(curso, periodo, porCodigo, asignaciones));
    const grupos = [
      disponibles.filter((curso) => (prioridades.get(curso.codigo)?.impacto ?? 0) > 0)
        .sort((a, b) => a.codigo.localeCompare(b.codigo)),
      disponibles.filter((curso) => (prioridades.get(curso.codigo)?.impacto ?? 0) === 0 && curso.cicloOrigen <= cicloActual)
        .sort((a, b) => a.cicloOrigen - b.cicloOrigen || a.codigo.localeCompare(b.codigo)),
      disponibles.filter((curso) => (prioridades.get(curso.codigo)?.impacto ?? 0) === 0 && curso.cicloOrigen > cicloActual)
        .sort((a, b) => a.cicloOrigen - b.cicloOrigen || a.codigo.localeCompare(b.codigo)),
    ];
    const seleccionados: Curso[] = [];
    for (const grupo of grupos) {
      const seleccion = optimizarSemestre(grupo, horasDisponibles, prioridades, creditosDisponibles);
      seleccionados.push(...seleccion.cursos);
      horasDisponibles -= seleccion.horas;
      creditosDisponibles -= seleccion.creditos;
    }
    // El periodo queda lleno: se agrega, en el mismo orden, cualquier curso disponible que todavía quepa.
    const cabe = (curso: Curso) => curso.horasSemanales <= horasDisponibles + EPSILON && curso.creditos <= creditosDisponibles + EPSILON;
    for (const curso of grupos.flat()) {
      if (seleccionados.includes(curso) || !cabe(curso)) continue;
      seleccionados.push(curso);
      horasDisponibles -= curso.horasSemanales;
      creditosDisponibles -= curso.creditos;
    }
    for (const curso of seleccionados) {
      nuevasAsignaciones.set(curso.codigo, periodo);
      asignaciones.set(curso.codigo, periodo);
      restantes.delete(curso.codigo);
    }
    if (soloProximo) noCabenEnProximo.push(...disponibles.filter((curso) => !seleccionados.includes(curso)));
    // Los electivos van al final de los obligatorios, sin desplazar ninguno.
    if (restantes.size === 0 && electivosPorUbicar.length && periodo.orden >= ultimaOrdenObligatoria()) {
      for (const curso of [...electivosPorUbicar]) {
        if (!horasValidas(curso) || !cabe(curso) || !prerrequisitosCumplidos(curso, periodo, porCodigo, asignaciones)) continue;
        seleccionados.push(curso);
        horasDisponibles -= curso.horasSemanales;
        creditosDisponibles -= curso.creditos;
        nuevasAsignaciones.set(curso.codigo, periodo);
        asignaciones.set(curso.codigo, periodo);
        electivosPorUbicar.splice(electivosPorUbicar.indexOf(curso), 1);
      }
    }
    const jaladosPeriodo = cargaConservada.filter(esCursoJalado);
    if (seleccionados.length === 0 && jaladosPeriodo.length === 0) {
      // Un ciclo agregado que no recibe nada no deja avanzar a los siguientes: se deja de agregar.
      if (!esVerano && periodo.cicloReferencia > cicloFinal) break;
      if (!cargaConservada.length && !soloProximo) vacios.push(periodo);
      continue;
    }
    const cursosPeriodo = [...cargaConservada, ...seleccionados];
    ciclos.push({
      ciclo: periodo.cicloReferencia, periodo,
      creditos: sumarCreditos(cursosPeriodo),
      horasEfectivas: calcularHorasEfectivas(cursosPeriodo, periodo.tipo),
      impacto: seleccionados.reduce((suma, curso) => suma + (prioridades.get(curso.codigo)?.impacto ?? 0), 0),
      cursos: [...jaladosPeriodo, ...seleccionados].map((curso) => ({
        codigo: curso.codigo, nombre: curso.nombre, creditos: curso.creditos,
        impacto: prioridades.get(curso.codigo)?.impacto ?? 0,
      })),
    });
  }
  if (!soloProximo) reutilizarVacios();
  ciclos.sort((a, b) => a.periodo.orden - b.periodo.orden);
  const ultimoPeriodo = lista.at(-1);
  const cicloUltimo = Math.max(cicloFinal, ...lista.filter((periodo) => periodo.tipo === 'REGULAR' &&
    ciclos.some((ciclo) => ciclo.periodo.id === periodo.id)).map((periodo) => periodo.cicloReferencia));

  const cursos = cursosBase.map((curso) => {
    const original = originales.get(curso.codigo)!;
    // Con alcance "proximoPeriodo", lo que está fuera de ese periodo queda como estaba.
    if (soloProximo && !nuevasAsignaciones.has(curso.codigo) && original.ubicacion === 'periodo' &&
        obtenerPeriodoCurso(original).id !== periodoInicio.id && !enCicloExcluido.has(curso.codigo)) return { ...original };
    if (curso.estado !== 'PENDIENTE' || conservados.has(curso.codigo)) return curso;
    const periodo = nuevasAsignaciones.get(curso.codigo);
    return { ...curso, ciclo: periodo?.cicloReferencia ?? curso.cicloOrigen,
      tipoPeriodo: periodo?.tipo ?? 'REGULAR' as const, ubicacion: periodo ? 'periodo' as const : 'banco' as const };
  });
  const noPlanificados: CursoNoPlanificado[] = soloProximo
    ? noCabenEnProximo.map((curso) => ({ codigo: curso.codigo, nombre: curso.nombre,
      motivos: [{ tipo: 'NO_CABE_EN_PERIODO' as const, periodo: periodoInicio, limiteHoras, limiteCreditos }] }))
    : [...restantes.values()].map((curso) => ({
      codigo: curso.codigo, nombre: curso.nombre,
      motivos: motivosNoPlanificado(curso, porCodigo, asignaciones, ultimoPeriodo, cicloUltimo, limiteHoras, limiteCreditos),
    }));
  for (const curso of soloProximo ? [] : electivosPorUbicar) {
    noPlanificados.push({ codigo: curso.codigo, nombre: curso.nombre,
      motivos: restantes.size > 0
        ? [{ tipo: 'ELECTIVO_ESPERA_OBLIGATORIOS' as const }]
        : motivosNoPlanificado(curso, porCodigo, asignaciones, ultimoPeriodo, cicloUltimo, limiteHoras, limiteCreditos) });
  }

  // Cada periodo futuro con carga, tal como queda la malla con la propuesta.
  const porPeriodo = new Map<string, { periodo: PeriodoAcademico; cursos: Curso[] }>();
  for (const curso of cursos) {
    if (curso.ubicacion !== 'periodo' || (curso.estado !== 'PENDIENTE' && curso.estado !== 'EN_CURSO')) continue;
    const periodo = obtenerPeriodoCurso(curso);
    if (cicloActual > 0 && (periodoBloqueadoPorCicloActual(periodo, cicloActual) || esJaladoSinReplanificar(curso, cicloActual))) continue;
    porPeriodo.set(periodo.id, { periodo, cursos: [...(porPeriodo.get(periodo.id)?.cursos ?? []), curso] });
  }
  const periodos: PeriodoPropuesto[] = [...porPeriodo.values()].sort((a, b) => a.periodo.orden - b.periodo.orden)
    .map(({ periodo, cursos: cursosPeriodo }) => ({
      periodo,
      cursos: cursosPeriodo.map((curso) => ({
        codigo: curso.codigo, nombre: curso.nombre, creditos: curso.creditos, horas: curso.horasSemanales,
        jalado: esCursoJalado(curso), conservado: !nuevasAsignaciones.has(curso.codigo),
      })),
      horas: calcularHorasEfectivas(cursosPeriodo, periodo.tipo),
      creditos: sumarCreditos(cursosPeriodo),
    }));
  const ciclosAgregados = periodos.filter(({ periodo }) => periodo.tipo === 'REGULAR' && periodo.cicloReferencia > cicloFinal)
    .map(({ periodo }) => periodo.cicloReferencia);
  const veranosUsados = periodos.filter(({ periodo, cursos: cursosPeriodo }) => periodo.tipo === 'VERANO' &&
    cursosPeriodo.some((curso) => !curso.conservado && !curso.jalado)).map(({ periodo }) => periodo.id);
  const periodoEgreso = periodos.at(-1)?.periodo ?? null;

  const explicacion: ExplicacionPlan[] = [
    { tipo: 'RESUMEN', total: nuevasAsignaciones.size, cicloInicio, cicloFinal: cicloUltimo,
      jaladosEnVerano: [...destinoJalado.values()].filter((destino) => destino.tipo === 'VERANO').length,
      ...(veranosUsados.length ? { conVeranos: true } : {}) },
    { tipo: 'LIMITE', horas: limiteHoras, ...(limiteCreditos !== null ? { creditos: limiteCreditos } : {}),
      ...(horasEstricto || creditosEstricto ? { estricto: true } : {}) },
    { tipo: 'PRIORIDAD_OBLIGATORIOS' },
    { tipo: 'APROBADOS_SIN_CARGA' },
    { tipo: 'REQUISITOS_EXTERNOS' },
  ];
  const ciclosRetirados = ciclosExcluidos.filter((ciclo) => ciclo <= cicloFinal);
  if (ciclosRetirados.length) explicacion.push({ tipo: 'CICLOS_EXCLUIDOS', ciclos: ciclosRetirados });
  if (ciclosAgregados.length) explicacion.push({ tipo: 'CICLOS_AGREGADOS', ciclos: ciclosAgregados });
  if (veranosUsados.length) explicacion.push({ tipo: 'VERANOS_USADOS',
    periodos: veranosUsados.map((id) => nombrePeriodoCorto(periodos.find((item) => item.periodo.id === id)!.periodo)) });
  for (const curso of electivosElegidos) explicacion.push({ tipo: 'ELECTIVO_ELEGIDO', curso });
  if (!electivosElegidos.length && creditosElectivosCubiertos > 0) explicacion.push({ tipo: 'ELECTIVO_CUBIERTO' });
  // Los jalados se fijan en su ventana de recuperación, pero no son asignaciones conservadas del estudiante.
  const totalConservados = conservados.size - jalados.length;
  if (jalados.length) explicacion.push({ tipo: 'JALADOS_PRIMERO', total: jalados.length,
    periodos: [...new Map([...destinoJalado.values()].sort((a, b) => a.orden - b.orden)
      .map((destino) => [destino.id, nombrePeriodoCorto(destino)])).values()] });
  if (totalConservados) explicacion.push({ tipo: 'CONSERVADOS', total: totalConservados });
  if (noPlanificados.length) explicacion.push({ tipo: 'PENDIENTES', total: noPlanificados.length });
  else if (pendientes.length || electivosElegidos.length) explicacion.push({ tipo: 'COMPLETADOS' });

  const cargas = new Map<string, { periodo: PeriodoAcademico; cursos: Curso[] }>();
  cursos.filter((curso) => curso.ubicacion === 'periodo' && (curso.estado === 'PENDIENTE' || curso.estado === 'EN_CURSO'))
    .forEach((curso) => {
      const periodo = obtenerPeriodoCurso(curso);
      const carga = cargas.get(periodo.id) ?? { periodo, cursos: [] };
      carga.cursos.push(curso);
      cargas.set(periodo.id, carga);
    });
  const advertenciasHoras = [...cargas.values()]
    .filter(({ periodo }) => periodo.cicloReferencia > cicloActual || periodo.tipo === 'VERANO' && periodo.cicloReferencia === cicloActual)
    .map(({ periodo, cursos }) => ({ periodo, total: calcularHorasEfectivas(cursos, periodo.tipo), limite: LIMITE_HORAS_PERIODO }))
    .filter(({ total, limite }) => total > limite);
  if (advertenciasHoras.length) explicacion.push({ tipo: 'ADVERTENCIAS_HORAS', horas: LIMITE_HORAS_PERIODO });
  return { cursos, cicloInicio, cicloFinal: cicloUltimo, periodoInicio, limiteHoras,
    totalPlanificados: nuevasAsignaciones.size, totalConservados,
    ciclos, noPlanificados, explicacion, advertenciasHoras,
    alcance, limites: {
      horas: limiteHoras, horasVerano: limiteHorasVerano, creditos: limiteCreditos, creditosVerano: limiteCreditosVerano,
      horasEstricto, creditosEstricto,
    },
    periodos, ciclosAgregados, veranosUsados, periodoEgreso, cicloEgreso: periodoEgreso?.cicloReferencia ?? null };
};

/** Peor egreso primero: más cursos sin ubicar y, en empate, el periodo de egreso más tardío. */
const egresaAntes = (a: ReturnType<typeof planificar>, b: ReturnType<typeof planificar>) =>
  a.noPlanificados.length !== b.noPlanificados.length
    ? a.noPlanificados.length < b.noPlanificados.length
    : (a.periodoEgreso?.orden ?? -1) < (b.periodoEgreso?.orden ?? -1);

/** Veranos del calendario (mes de ingreso) desde el ciclo actual: candidatos para "usarVeranos". */
const veranosDelCalendario = (opciones: OpcionesPlanificacion, cicloActual: number): number[] => {
  const ingreso = opciones.periodoIngreso;
  if (!ingreso) return [];
  return Array.from({ length: MAXIMO_CICLOS }, (_, indice) => indice + 1)
    .filter((ciclo) => ciclo >= Math.max(1, cicloActual) && permiteVeranoDespuesDe(ciclo, ingreso));
};

export const generarPlanificacionAutomatica = (
  cursosEntrada: Curso[], opciones: OpcionesPlanificacion = {}
): ResultadoPlanificacionAutomatica => {
  const sinVeranos = planificar(cursosEntrada, opciones, new Set());
  let elegido = sinVeranos;
  // Los veranos se usan solo si hacen falta: se habilitan desde el más cercano hasta no necesitar ciclos extra.
  if (opciones.usarVeranos && sinVeranos.alcance === 'hastaEgresar' &&
      (sinVeranos.ciclosAgregados.length || sinVeranos.noPlanificados.length)) {
    const candidatos = veranosDelCalendario(opciones, sinVeranos.cicloInicio - 1);
    for (let cantidad = 1; cantidad <= candidatos.length; cantidad += 1) {
      const intento = planificar(cursosEntrada, opciones, new Set(candidatos.slice(0, cantidad)));
      if (egresaAntes(intento, elegido)) elegido = intento;
      if (!intento.ciclosAgregados.length && !intento.noPlanificados.length) break;
    }
  }
  if (elegido.alcance !== 'hastaEgresar') return { ...elegido, comparacionSinLimites: null };
  const conLimites = limitePositivo(opciones.maxHorasPorPeriodo) !== null || limitePositivo(opciones.maxHorasVerano) !== null ||
    limitePositivo(opciones.maxCreditosPorPeriodo) !== null;
  const sinLimites = conLimites
    ? planificar(cursosEntrada, { ...opciones, maxHorasPorPeriodo: null, maxHorasVerano: null, maxCreditosPorPeriodo: null }, new Set())
    : sinVeranos;
  return { ...elegido, comparacionSinLimites: {
    cicloEgreso: sinLimites.cicloEgreso,
    periodoEgreso: sinLimites.periodoEgreso,
    ciclosExtra: Math.max(0, (elegido.cicloEgreso ?? 0) - (sinLimites.cicloEgreso ?? 0)),
  } };
};
