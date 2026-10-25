import type {
  AIAnalisisResponse, AIChatResponse, AIContext, AIEscenarioPeriodo, AIRequest, AIRespuesta, AISeccion, Nivel,
} from './contracts.js';
import { aplicarMontoDelAlumno } from './presupuesto.js';

/**
 * Respuestas simuladas del asistente, armadas con los datos reales del
 * contexto (cursos, montos, carga, what-if, ventana de jalados). Las usan el
 * proxy sin clave de DeepSeek y el cliente local en desarrollo.
 * ai-proxy/src/mockRespuestas.ts es una copia exacta; un test falla si difieren.
 */

const soles = (monto: number) => {
  const [entero, decimales] = Math.abs(monto).toFixed(2).split('.');
  return `${monto < 0 ? '-' : ''}S/ ${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimales}`;
};
const horas = (valor: number) => `${valor} h`;
const periodo = (id: string) => id.replace(/^ciclo-/, 'Ciclo ').replace(/^verano-/, 'Verano ');
const listar = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items.at(-1)}` : items.join('');

/** "en el Ciclo 9" o "en el Verano 8 o en el Ciclo 9"; sin ventana conocida, "en su ventana de recuperación". */
const enVentana = (ventana: string[]) =>
  ventana.length ? `en el ${ventana.map(periodo).join(' o en el ')}` : 'en su ventana de recuperación';

const nombreDe = (contexto: AIContext, codigo: string) =>
  contexto.catalogo.find((curso) => curso.codigo === codigo)?.nombre ?? codigo;
const conCodigo = (contexto: AIContext, codigo: string) => `${nombreDe(contexto, codigo)} (${codigo})`;

const PREGUNTAS_BASE = ['¿Me alcanza mi presupuesto?', '¿Estoy sobrecargado?', '¿Qué electivo me conviene?'];

/** "5 cuotas de S/ 931.43", o en pago único (sin cuota mensual) "la pensión en un solo pago al inicio". */
const formaDePago = (escenario: AIEscenarioPeriodo) => escenario.cuotaMensual === null
  ? 'la pensión en un solo pago al inicio'
  : `${escenario.numeroCuotas} cuotas de ${soles(escenario.cuotaMensual)}`;

/** Diferencia contra el presupuesto ya calculada en CONTEXTO.derivados (el mock tampoco resta). */
const derivadoPresupuesto = (contexto: AIContext, id: string) =>
  contexto.derivados.presupuesto?.find((item) => item.id === id) ?? null;

const frasePresupuesto = (contexto: AIContext, id: string) => {
  const derivado = derivadoPresupuesto(contexto, id);
  const presupuesto = contexto.financiero?.presupuestoMensual;
  if (!derivado || presupuesto === null || presupuesto === undefined) return null;
  return derivado.alcanza
    ? `Tu presupuesto de ${soles(presupuesto)} cubre la cuota y te sobran ${soles(derivado.sobraPorMes)} al mes.`
    : `Tu presupuesto de ${soles(presupuesto)} no cubre la cuota: te faltan ${soles(derivado.faltaPorMes)} al mes (${soles(derivado.faltaPorCiclo)} en el ciclo).`;
};

const seccionFinanciera = (contexto: AIContext): AISeccion | null => {
  const financiero = contexto.financiero;
  const escenarios = financiero?.proximoPeriodo ?? [];
  if (!financiero || !escenarios.length || !contexto.proximoPeriodo) return null;
  const elegido = escenarios.find((item) => item.id === financiero.metodoPagoElegido.id) ?? escenarios[0];
  const mejor = [...escenarios].sort((a, b) => a.total - b.total)[0];
  const derivado = derivadoPresupuesto(contexto, elegido.id);
  const nivel: Nivel = derivado && !derivado.alcanza ? 'riesgo'
    : contexto.proximoPeriodo.horasExceso > 0 ? 'atencion' : 'ok';
  const partes = [
    `En el ${contexto.proximoPeriodo.etiqueta} pagarías ${soles(elegido.total)} (${elegido.nombre}): matrícula de ${soles(elegido.matricula)} y ${formaDePago(elegido)}.`,
  ];
  if (mejor.id !== elegido.id) partes.push(`La opción más barata es ${mejor.nombre}: ${soles(mejor.total)}.`);
  if (contexto.derivados.horas.sobreTopeEscala > 0 && financiero.costoHoraAdicional !== null) {
    partes.push(`Tienes ${horas(contexto.derivados.horas.sobreTopeEscala)} sobre la escala; cada hora adicional cuesta ${soles(financiero.costoHoraAdicional)} por cuota.`);
  }
  partes.push(frasePresupuesto(contexto, elegido.id) ?? 'Si me dices tu presupuesto mensual, te digo si te alcanza.');
  partes.push('Montos referenciales: verifícalos en el portal de la UTP antes de pagar.');
  const acciones = [
    ...(mejor.id !== elegido.id ? [`Evalúa pagar con ${mejor.nombre}.`] : []),
    ...(contexto.proximoPeriodo.horasExceso > 0 ? ['Quita horas para no pagar recargo.'] : []),
    ...(derivado ? [] : ['Ingresa tu presupuesto mensual.']),
  ].slice(0, 3);
  return { tipo: 'financiero', nivel, titulo: 'Costo del próximo periodo', detalle: partes.join(' '), acciones, cursos: [] };
};

/** Costo del próximo periodo en chat: corto (máximo 80 palabras), con la diferencia de derivados. */
const chatFinanciero = (contexto: AIContext): string | null => {
  const financiero = contexto.financiero;
  const escenarios = financiero?.proximoPeriodo ?? [];
  if (!financiero || !escenarios.length || !contexto.proximoPeriodo) return null;
  const elegido = escenarios.find((item) => item.id === financiero.metodoPagoElegido.id) ?? escenarios[0];
  const mejor = [...escenarios].sort((a, b) => a.total - b.total)[0];
  return [
    `En el ${contexto.proximoPeriodo.etiqueta} pagarías ${soles(elegido.total)} (${elegido.nombre}): matrícula de ${soles(elegido.matricula)} y ${formaDePago(elegido)}.`,
    frasePresupuesto(contexto, elegido.id) ?? 'Si me dices tu presupuesto mensual, te digo si te alcanza.',
    ...(mejor.id !== elegido.id ? [`Lo más barato es ${mejor.nombre}: ${soles(mejor.total)}.`] : []),
    'Son montos referenciales: verifícalos en el portal de la UTP.',
  ].join(' ');
};

const seccionCarga = (contexto: AIContext): AISeccion => {
  const { carga, proximoPeriodo } = contexto;
  const pesados = (proximoPeriodo?.cursos ?? []).filter((curso) => curso.horas >= 4).map((curso) => curso.codigo);
  const { sobreTopeEscala, topeEscala } = contexto.derivados.horas;
  const sobreTope = sobreTopeEscala > 0 && topeEscala !== null ? ` Son ${horas(sobreTopeEscala)} sobre el tope de ${horas(topeEscala)} de la escala.` : '';
  const detalle = !proximoPeriodo
    ? 'Aún no tienes cursos planificados para el próximo periodo.'
    : `${proximoPeriodo.etiqueta}: ${horas(carga.horas)} y ${proximoPeriodo.totalCreditos} créditos. ${carga.motivos.join(' ') || 'La carga está dentro de lo recomendado.'}${sobreTope}`;
  // derivados.horasSinCadaCurso: el mock tampoco resta horas.
  const alivio = contexto.derivados.horasSinCadaCurso.find((curso) => curso.quedaBajoTopeEscala);
  const mover = alivio && sobreTopeEscala > 0
    ? `Sin ${alivio.nombre} bajarías a ${horas(alivio.horasSinElCurso)}, dentro del tope.`
    : 'Mueve un curso de 4 h a otro periodo.';
  const acciones = carga.nivel === 'ok'
    ? ['Mantén un horario fijo de estudio.']
    : [mover, 'Reserva tiempo para los cursos largos.', 'Revisa la ruta antes de matricularte.'];
  const titulo = carga.nivel === 'riesgo' ? 'Carga muy alta' : carga.nivel === 'atencion' ? 'Carga exigente' : 'Carga equilibrada';
  return { tipo: 'carga', nivel: carga.nivel, titulo, detalle, acciones: acciones.slice(0, 3), cursos: pesados };
};

const seccionRuta = (contexto: AIContext): AISeccion => {
  const { ruta } = contexto;
  const primeros = ruta.propuesta.slice(0, 2)
    .map((item) => `${periodo(item.periodoId)}: ${item.cursos.length} cursos`).join('; ');
  const pendientes = ruta.noPlanificados.map((codigo) => conCodigo(contexto, codigo));
  const detalle = ruta.cicloFinal
    ? `Con la propuesta del planificador terminarías en el Ciclo ${ruta.cicloFinal} (${ruta.ciclosRestantes} ciclos más). ${primeros}.`
    : 'No quedan cursos por planificar.';
  return {
    tipo: 'ruta',
    nivel: pendientes.length ? 'atencion' : 'ok',
    titulo: 'Tu ruta hasta egresar',
    detalle: pendientes.length ? `${detalle} Quedan sin ubicar: ${listar(pendientes)}.` : detalle,
    acciones: ['Revisa la propuesta en Estrategia.', ...(pendientes.length ? ['Agrega un ciclo para ubicar lo pendiente.'] : [])],
    cursos: [...(ruta.propuesta[0]?.cursos.slice(0, 4) ?? []), ...ruta.noPlanificados].slice(0, 6),
  };
};

const seccionWhatIf = (contexto: AIContext): AISeccion | null => {
  const fuera = contexto.jalados.filter((jalado) => !jalado.enVentana);
  if (contexto.jalados.length) {
    const textos = contexto.jalados.map((jalado) =>
      `${jalado.nombre} (${jalado.codigo}) debe ir en ${listar(jalado.ventana.map(periodo))}${jalado.enVentana ? ' y ya está ahí' : ''}.`);
    return {
      tipo: 'whatIf',
      nivel: fuera.length ? 'riesgo' : 'atencion',
      titulo: fuera.length ? 'Tienes un curso jalado por ubicar' : 'Curso jalado en su ventana',
      detalle: `${textos.join(' ')}${fuera.length ? ' Mientras no esté en su ventana, no puedes matricular otros cursos.' : ''}`,
      acciones: fuera.length ? ['Lleva el jalado a su ventana de recuperación.'] : ['Prioriza aprobar el curso jalado.'],
      cursos: contexto.jalados.map((jalado) => jalado.codigo),
    };
  }
  const critico = [...contexto.whatIf].sort((a, b) => b.cursosBloqueados.length - a.cursosBloqueados.length)[0];
  if (!critico) return null;
  const total = critico.cursosBloqueados.length;
  return {
    tipo: 'whatIf',
    nivel: total >= 3 ? 'atencion' : 'ok',
    titulo: 'Curso que más te conviene asegurar',
    detalle: total
      ? `Si jalas ${conCodigo(contexto, critico.codigo)}, se bloquean ${total} cursos, entre ellos ${listar(critico.cursosBloqueados.slice(0, 3).map((codigo) => nombreDe(contexto, codigo)))}. Tendrías que llevarlo ${enVentana(critico.ventanaSiJala)}.`
      : 'Ningún curso actual bloquea a otros si lo jalas.',
    acciones: total ? [`Dale prioridad a ${nombreDe(contexto, critico.codigo)}.`] : [],
    cursos: [critico.codigo, ...critico.cursosBloqueados.slice(0, 3)],
  };
};

const seccionElectivos = (contexto: AIContext): AISeccion => {
  const { electivos } = contexto.perfil;
  const opciones = contexto.electivos.map((electivo) =>
    `${electivo.nombre} (${electivo.codigo}, ${electivo.creditos} créditos${electivo.area ? `, ${electivo.area}` : ''})`);
  return {
    tipo: 'electivos',
    nivel: electivos.faltantes > 0 ? 'atencion' : 'ok',
    titulo: electivos.faltantes > 0 ? `Te faltan ${electivos.faltantes} créditos electivos` : 'Electivos cubiertos',
    detalle: electivos.faltantes > 0 && opciones.length
      ? `Necesitas ${electivos.minimo} créditos electivos y llevas ${electivos.cubiertos}. Disponibles: ${listar(opciones)}. Las áreas son referenciales.`
      : `Llevas ${electivos.cubiertos} de ${electivos.minimo} créditos electivos.`,
    acciones: electivos.faltantes > 0 ? ['Elige el electivo según tu interés.', 'Prefiere uno de pocas horas si tu ciclo está cargado.'] : [],
    cursos: contexto.electivos.map((electivo) => electivo.codigo),
  };
};

/** Sección de reemplazo cuando no hay datos: el contrato exige las 5 secciones. */
const sinDatosDe = (tipo: 'financiero' | 'whatIf'): AISeccion => tipo === 'financiero'
  ? { tipo, nivel: 'atencion', titulo: 'Costo del próximo periodo', detalle: 'Planifica tus cursos del próximo periodo para ver su costo.', acciones: ['Ubica tus cursos en un ciclo.'], cursos: [] }
  : { tipo, nivel: 'ok', titulo: 'Si jalas un curso', detalle: 'Ningún curso actual bloquea a otros si lo jalas.', acciones: [], cursos: [] };

export const mockAnalisis = (contexto: AIContext): AIAnalisisResponse => {
  // Orden del contrato: carga, financiero, ruta, whatIf, electivos.
  const secciones = [seccionCarga(contexto), seccionFinanciera(contexto) ?? sinDatosDe('financiero'), seccionRuta(contexto),
    seccionWhatIf(contexto) ?? sinDatosDe('whatIf'), seccionElectivos(contexto)];
  const riesgos = secciones.filter((seccion) => seccion.nivel === 'riesgo').map((seccion) => seccion.titulo.toLowerCase());
  const resumen = riesgos.length
    ? `Revisé tu plan. Hay ${riesgos.length === 1 ? 'un punto' : `${riesgos.length} puntos`} de riesgo: ${listar(riesgos)}.`
    : 'Revisé tu plan y se ve ordenado. Te dejo los detalles por tema.';
  return { resumen, secciones, preguntasSugeridas: PREGUNTAS_BASE };
};

type Tema = 'bienestar' | 'identidad' | 'sinDatos' | 'intentos' | 'cachimbo' | 'estadoCurso' | 'creditos'
  | 'financiero' | 'carga' | 'whatIf' | 'ruta' | 'electivos' | 'conviene' | 'fuera';

const normalizar = (texto: string) => texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Palabras del glosario del prompt: la jerga es un espejo, solo se usa si el alumno la usó. */
const JERGA = /\b(bika|trika|tranca|yuca|huecos?|cachimbos?|chamba|matri|cruces?|profes?|full)\b/;
export const usaJerga = (texto: string) => JERGA.test(normalizar(texto));

const detectarTema = (texto: string): Tema => {
  const t = normalizar(texto);
  if (/estres|no puedo mas|dejar la (u|carrera|universidad)|quiero dejar|agobi|ansios/.test(t)) return 'bienestar';
  if (/eres (una |un )?(persona|humano|profe|profesor|docente|real)|hablo con (una persona|alguien)/.test(t)) return 'identidad';
  if (/horario|hueco|cruce|seccion|profe|docente|\bnotas?\b|tranca|yuca|dificil/.test(t)) return 'sinDatos';
  if (/\bbika\b|\btrika\b|(segunda|tercera) vez|(dos|tres|2|3) veces/.test(t)) return 'intentos';
  if (/cachimbo|primer ciclo/.test(t)) return 'cachimbo';
  if (/convalid|\baprobe\b|ya (lo )?lleve|ya (lo )?aprobe/.test(t)) return 'estadoCurso';
  if (/creditos? (me )?faltan|faltan .*creditos|creditos .*egresar/.test(t)) return 'creditos';
  if (/presupuesto|alcanza|cuesta|costo|pagar|pago|cuota|precio|pension|descuento|plata|dinero|matricula|\bbcp\b|bbva|interbank|scotiabank|llegar a \d|al mes|soles|mensual/.test(t)) return 'financiero';
  if (/jal|desaprueb|repruebo/.test(t)) return 'whatIf';
  if (/sobrecarg|carga|cargo|horas|pesado|cansad|chamba|trabaj/.test(t)) return 'carga';
  if (/electivo/.test(t)) return 'electivos';
  if (/ruta|egresar|terminar|acabar|ciclos me faltan|graduar/.test(t)) return 'ruta';
  if (/conviene|llevarlo|ahora|matricul|ciclo|curso|plan/.test(t)) return 'conviene';
  return 'fuera';
};

const respuestaCurso = (contexto: AIContext, tema: Tema): AIChatResponse | null => {
  const foco = contexto.foco;
  if (foco?.tipo !== 'curso') return null;
  const nombre = `${foco.nombre} (${foco.codigo})`;
  const preguntas = ['¿Qué pasa si lo jalo?', '¿Me conviene llevarlo ahora?', '¿Cuánto me cuesta?'];
  if (tema === 'whatIf') {
    const bloqueados = foco.whatIf.cursosBloqueados;
    return {
      texto: bloqueados.length
        ? `Si jalas ${nombre}, se bloquean ${bloqueados.length} cursos: ${listar(bloqueados.map((codigo) => nombreDe(contexto, codigo)))}.\nTendrías que llevarlo ${enVentana(foco.whatIf.ventanaSiJala)} antes de seguir.`
        : `Si jalas ${nombre}, no se bloquea ningún otro curso, pero igual tendrías que llevarlo ${enVentana(foco.whatIf.ventanaSiJala)}.`,
      cursos: [foco.codigo, ...bloqueados], preguntasSugeridas: preguntas.filter((_, indice) => indice !== 0),
    };
  }
  if (tema === 'financiero') {
    const escenarios = contexto.proximoPeriodo?.id === foco.ubicacion ? contexto.financiero?.proximoPeriodo ?? [] : [];
    return {
      texto: escenarios.length
        ? `${nombre} está en el ${periodo(foco.ubicacion)}. Ese periodo cuesta ${soles(escenarios[0].total)} sin descuento.\nEn la escala UTP pagas por horas del periodo, no por curso: este curso suma ${horas(foco.horas)}.`
        : `En la escala UTP pagas por horas del periodo, no por curso. ${nombre} suma ${horas(foco.horas)}; planifícalo en un ciclo para ver el costo.`,
      cursos: [foco.codigo], preguntasSugeridas: preguntas.slice(0, 2),
    };
  }
  return {
    texto: `${nombre} tiene ${foco.creditos} créditos y ${horas(foco.horas)}. Desbloquea ${foco.impacto} cursos y abre una cadena de ${foco.longitudCadena}.\n` +
      (foco.impacto >= 2 ? 'Te conviene llevarlo pronto para no retrasar tu ruta.' : 'No es crítico: puedes acomodarlo según tu carga.'),
    cursos: [foco.codigo, ...foco.habilitaA.slice(0, 3)], preguntasSugeridas: [preguntas[0], preguntas[2]],
  };
};

const desdeSeccion = (seccion: AISeccion | null, preguntas: string[]): AIChatResponse => seccion
  ? { texto: `${seccion.detalle}${seccion.acciones.length ? `\n${seccion.acciones.map((accion) => `• ${accion}`).join('\n')}` : ''}`, cursos: seccion.cursos, preguntasSugeridas: preguntas }
  : { texto: 'No tengo ese dato en tu plan todavía. Planifica tus cursos y vuelve a preguntarme.', cursos: [], preguntasSugeridas: preguntas };

/** Curso del catálogo cuyo nombre aparece en la pregunta, o el curso en foco. */
const cursoMencionado = (contexto: AIContext, pregunta: string) => {
  const t = normalizar(pregunta);
  const porNombre = [...contexto.catalogo].sort((a, b) => b.nombre.length - a.nombre.length)
    .find((curso) => t.includes(normalizar(curso.nombre)));
  if (porNombre) return porNombre;
  // Nombre abreviado de un jalado ("análisis y diseño de sistemas"): sus primeras 5 palabras.
  const abreviado = contexto.jalados.find((jalado) => {
    const palabras = normalizar(jalado.nombre).split(/\s+/);
    return palabras.length > 5 && t.includes(palabras.slice(0, 5).join(' '));
  });
  if (abreviado) return contexto.catalogo.find((curso) => curso.codigo === abreviado.codigo) ?? null;
  const foco = contexto.foco;
  return foco?.tipo === 'curso' ? contexto.catalogo.find((curso) => curso.codigo === foco.codigo) ?? null : null;
};

/** Ventana del curso: la de CONTEXTO.jalados si ya está jalado; si no, la de su what-if. */
const ventanaDe = (contexto: AIContext, codigo: string) =>
  contexto.jalados.find((jalado) => jalado.codigo === codigo)?.ventana
  ?? contexto.whatIf.find((item) => item.codigo === codigo)?.ventanaSiJala
  ?? (contexto.foco?.tipo === 'curso' && contexto.foco.codigo === codigo ? contexto.foco.ventanaRecuperacion : []);

/** La carga solo se menciona si la pregunta trata de eso (prompt, CÓMO HABLAS): aquí se ofrece verla. */
const respuestaBienestar = (): AIChatResponse => ({
  texto: 'Lo que sientes es válido, y no tienes que cargar con todo sin ayuda: busca apoyo en tutoría o en bienestar universitario de la UTP, para eso están.\n' +
    'Cuando quieras, revisamos juntos tu plan con calma y vemos si conviene alivianar el próximo periodo.',
  cursos: [],
  preguntasSugeridas: ['¿Qué curso me conviene dejar para después?', '¿Estoy sobrecargado?'],
});

const respuestaIdentidad = (): AIChatResponse => ({
  texto: 'Soy una IA: el asesor académico de MallaU. No soy una persona ni personal de la UTP, pero te ayudo a ordenar tu plan con los datos que cargaste.',
  cursos: [],
  preguntasSugeridas: PREGUNTAS_BASE,
});

/** Regla 7: MallaU no tiene horarios, secciones, profesores, notas ni dificultad real. */
const respuestaSinDatos = (contexto: AIContext, pregunta: string): AIChatResponse => {
  const t = normalizar(pregunta);
  const falta = /profe|docente/.test(t) ? 'información de los profesores'
    : /\bnotas?\b/.test(t) ? 'tus notas'
      : /tranca|yuca|dificil/.test(t) ? 'datos de la dificultad real de los cursos'
        : 'los horarios ni las secciones';
  const cursos = contexto.proximoPeriodo?.cursos ?? [];
  const masHoras = [...cursos].sort((a, b) => b.horas - a.horas)[0];
  const ofrezco = masHoras
    ? `Lo que sí veo son las horas de cada curso: en el ${contexto.proximoPeriodo!.etiqueta}, ${masHoras.nombre} (${masHoras.codigo}) tiene ${horas(masHoras.horas)}.`
    : 'Lo que sí puedo es decirte qué cursos llevar, en qué orden y cuántas horas suman.';
  return {
    texto: `Eso no lo tengo: MallaU no tiene ${falta}. ${ofrezco} ¿Te ayudo con eso?`,
    cursos: masHoras ? [masHoras.codigo] : [],
    preguntasSugeridas: ['¿Qué cursos llevo el próximo ciclo?', '¿Estoy sobrecargado?'],
  };
};

/** Regla 8: bika o trika solo si el alumno lo dice; la ley se cita sin jerga. */
const respuestaIntentos = (contexto: AIContext, pregunta: string): AIChatResponse => {
  const t = normalizar(pregunta);
  const curso = cursoMencionado(contexto, pregunta);
  const nombre = curso ? `${curso.nombre} (${curso.codigo})` : 'ese curso';
  if (/\btrika\b|tercera vez|(tres|3) veces/.test(t)) {
    return {
      texto: `Sé que es un momento difícil y está bien sentirlo. Según la Ley Universitaria 30220 (art. 102), desaprobar la misma materia por tercera vez lleva a una separación temporal de un año, y una cuarta desaprobación, al retiro definitivo. La UTP puede tener reglas propias, así que habla con tu tutor o con Servicios Académicos antes de la matrícula para saber exactamente cómo aplica en tu caso con ${nombre}.`,
      cursos: curso ? [curso.codigo] : [],
      preguntasSugeridas: ['¿Qué cursos llevo el próximo ciclo?', '¿Estoy sobrecargado?'],
    };
  }
  return {
    texto: `Con ${nombre}, el próximo intento es clave: según la Ley Universitaria 30220 (art. 102), desaprobar la misma materia por tercera vez lleva a una separación temporal de un año.\n` +
      `• Dale prioridad y llévalo ${curso ? enVentana(ventanaDe(contexto, curso.codigo)) : 'en su ventana de recuperación'}.\n` +
      '• Lleva menos carga ese periodo.\n• Pide tutoría o asesoría antes de matricularte.',
    cursos: curso ? [curso.codigo] : [],
    preguntasSugeridas: ['¿Qué curso me conviene dejar para después?', '¿Estoy sobrecargado?'],
  };
};

/** El alumno dice ser de primer ciclo, pero el contexto dice otra cosa: se le hace notar con amabilidad. */
const respuestaCachimbo = (contexto: AIContext, pregunta: string): AIChatResponse | null => {
  const ciclo = contexto.perfil.cicloActual;
  if (ciclo === null || ciclo <= 1) return null;
  const jerga = usaJerga(pregunta);
  return {
    texto: `Veo en tu plan que vas en el Ciclo ${ciclo}, así que ${jerga ? 'ya no serías cachimbo' : 'no estarías en primer ciclo'}. ¿Quizás falta actualizar tu ciclo actual? Revísalo en la configuración y te ayudo con lo que sigue.`,
    cursos: [],
    preguntasSugeridas: ['¿Qué cursos llevo el próximo ciclo?', '🗺️ Mi ruta hasta egresar'],
  };
};

const ESTADOS: Record<string, string> = { APROBADO: 'aprobado', CONVALIDADO: 'convalidado', EN_CURSO: 'en curso', PENDIENTE: 'pendiente' };

/** Estado y créditos de un curso, tal cual están en CONTEXTO.catalogo. */
const respuestaEstadoCurso = (contexto: AIContext, pregunta: string): AIChatResponse => {
  const curso = cursoMencionado(contexto, pregunta);
  if (!curso) {
    return {
      texto: '¿De qué curso me hablas? Dime su nombre como aparece en tu malla y te digo su estado.',
      cursos: [], preguntasSugeridas: ['¿Cuántos créditos me faltan para egresar?'],
    };
  }
  return {
    texto: `Según tu plan, ${curso.nombre} (${curso.codigo}) está ${ESTADOS[curso.estado]}, con ${curso.creditos} créditos.`,
    cursos: [curso.codigo], preguntasSugeridas: ['¿Cuántos créditos me faltan para egresar?', '🗺️ Mi ruta hasta egresar'],
  };
};

/** Créditos para egresar: todo viene de CONTEXTO.derivados.creditos. */
const respuestaCreditos = (contexto: AIContext): AIChatResponse => {
  const { creditos } = contexto.derivados;
  return {
    texto: `Para egresar necesitas ${creditos.paraEgresar} créditos (${creditos.obligatorios} obligatorios y ${creditos.electivosMinimos} de electivos como mínimo). Te faltan ${creditos.faltanParaEgresar}; si apruebas lo que llevas ahora, quedarían ${creditos.faltanSiApruebaEnCurso}, en ${creditos.ciclosRestantes} ciclos más según la propuesta del planificador.`,
    cursos: [], preguntasSugeridas: ['🗺️ Mi ruta hasta egresar', '¿Qué electivo me conviene?'],
  };
};

/**
 * Pago único: todas las pensiones juntas al inicio, nunca como cuota mensual. Montos de CONTEXTO.derivados.pagoUnico;
 * la comparación con el presupuesto es referencial.
 */
const respuestaPagoUnico = (contexto: AIContext): Omit<AIChatResponse, 'preguntasSugeridas'> | null => {
  const unico = contexto.derivados.pagoUnico;
  if (!unico || !contexto.proximoPeriodo) return null;
  const diferencia = unico.diferenciaVsPresupuestoDelCiclo;
  const comparacion = diferencia === null ? ''
    : diferencia >= 0
      ? ` Como comparación referencial, tu presupuesto de los ${contexto.financiero?.proximoPeriodo[0]?.numeroCuotas ?? ''} meses supera esa pensión en ${soles(diferencia)}.`
      : ` Como comparación referencial, tu presupuesto de los ${contexto.financiero?.proximoPeriodo[0]?.numeroCuotas ?? ''} meses queda ${soles(-diferencia)} por debajo de esa pensión.`;
  const mensual = (contexto.financiero?.proximoPeriodo ?? []).filter((item) => item.cuotaMensual !== null)
    .sort((a, b) => a.cuotaMensual! - b.cuotaMensual!)[0];
  return {
    texto: `El pago único no es mensual: pagas toda la pensión del ${contexto.proximoPeriodo.etiqueta} de una vez, ${soles(unico.pensionAlInicio)} al inicio, más la matrícula de ${soles(unico.matricula)} (${soles(unico.totalCiclo)} en total). Te ahorras ${soles(unico.ahorroVsSinDescuento)} frente a pagar sin descuento.${comparacion}` +
      (mensual ? `\nSi prefieres pagar mes a mes, la cuota más baja es ${soles(mensual.cuotaMensual!)} (${mensual.nombre}).` : ''),
    cursos: [],
  };
};

/**
 * Regla 3 con un jalado fuera de su ventana: va primero; los demás cursos del periodo quedan bloqueados hasta
 * agregarlo; horas y costos con el jalado incluido, de CONTEXTO.derivados.proximoPeriodoConJalados.
 */
const jaladoPrimero = (contexto: AIContext): Omit<AIChatResponse, 'preguntasSugeridas'> | null => {
  const conJalados = contexto.derivados.proximoPeriodoConJalados;
  const jalado = conJalados && contexto.jalados.find((item) => conJalados.jalados.includes(item.codigo));
  if (!conJalados || !jalado) return null;
  const bloqueados = contexto.derivados.planificadosBloqueadosPorJalado;
  const sinDescuento = conJalados.escenarios.find((escenario) => escenario.id === 'sin_descuento');
  const sobre = conJalados.superaTopeEscala && contexto.carga.topeEscala !== null
    ? `, ${horas(conJalados.horasSobreTopeEscala)} sobre el tope de ${horas(contexto.carga.topeEscala)}` : '';
  return {
    texto: `Primero va ${jalado.nombre} (${jalado.codigo}), que está jalado: tiene que ir ${enVentana(jalado.ventana)}.` +
      (bloqueados.length ? ` Hasta que lo agregues, los otros ${bloqueados.length} cursos de ese periodo quedan bloqueados.` : '') +
      `\nCon él, el ${periodo(conJalados.periodoId)} sumaría ${horas(conJalados.horas)}${sobre}` +
      `${sinDescuento ? ` y la cuota sin descuento sería ${soles(sinDescuento.cuotaMensual)}` : ''}. Te conviene llevar menos cursos ese periodo.`,
    cursos: [jalado.codigo, ...bloqueados.slice(0, 3).map((curso) => curso.codigo)],
  };
};

/** Método de pago nombrado en la pregunta ("con BCP", "con pago único"), o null. */
const metodoMencionado = (pregunta: string) => {
  const t = normalizar(pregunta);
  if (/\bbcp\b|bbva/.test(t)) return 'bcp_bbva';
  if (/interbank|scotiabank/.test(t)) return 'interbank_scotiabank';
  if (/pago unico/.test(t)) return 'pago_unico';
  if (/sin descuento/.test(t)) return 'sin_descuento';
  return null;
};

/** Regla de la propuesta con límites: cuántos cursos van en cada periodo, ciclos o veranos extra y el botón. */
const respuestaPropuesta = (contexto: AIContext): AIChatResponse | null => {
  const propuesta = contexto.propuestaConLimites;
  if (!propuesta) return null;
  const { limites } = propuesta;
  const pedido = limites.agregarCiclo ? `con un ciclo más, hasta ${horas(limites.horasAplicadas)} por ciclo`
    : limites.maxCuotaMensual !== null ? `con ${soles(limites.maxCuotaMensual)} al mes, hasta ${horas(limites.horasAplicadas)} por ciclo`
      : limites.maxCreditosPorPeriodo !== null ? `con hasta ${limites.maxCreditosPorPeriodo} créditos por ciclo`
        : `con hasta ${horas(limites.horasAplicadas)} por ciclo`;
  const periodos = propuesta.periodos.map((item) => `${item.etiqueta}: ${item.numeroCursos} cursos (${horas(item.horas)})`);
  const extra = [
    ...(propuesta.ciclosAgregados.length ? [`Necesitas ${propuesta.ciclosAgregados.length === 1 ? '1 ciclo más' : `${propuesta.ciclosAgregados.length} ciclos más`}.`] : []),
    ...propuesta.veranosUsados.map((id) => `Se usa el ${periodo(id)}.`),
  ];
  return {
    texto: periodos.length
      ? `Así queda tu plan ${pedido}: ${periodos.join('; ')}.${extra.length ? ` ${extra.join(' ')}` : ''}
` +
        'Es una propuesta: si te convence, aplícala con el botón «Aplicar a mi malla».'
      : 'Con esos límites no queda ningún curso por ubicar. Puedes probar otros en Autogenerar.',
    cursos: [], preguntasSugeridas: ['¿Me alcanza mi presupuesto?', '¿Estoy sobrecargado?'],
  };
};

export const mockChat = (contexto: AIContext, pregunta: string): AIChatResponse => {
  const tema = detectarTema(pregunta);
  if (tema === 'bienestar') return respuestaBienestar();
  if (tema === 'identidad') return respuestaIdentidad();
  const conPropuesta = respuestaPropuesta(contexto);
  if (conPropuesta) return conPropuesta;
  if (tema === 'sinDatos') return respuestaSinDatos(contexto, pregunta);
  if (tema === 'intentos') return respuestaIntentos(contexto, pregunta);
  if (tema === 'cachimbo') {
    const incoherente = respuestaCachimbo(contexto, pregunta);
    if (incoherente) return incoherente;
  }
  if (tema === 'estadoCurso') return respuestaEstadoCurso(contexto, pregunta);
  if (tema === 'creditos') return respuestaCreditos(contexto);
  const jalado = cursoMencionado(contexto, pregunta);
  const comoJalado = jalado && contexto.jalados.find((item) => item.codigo === jalado.codigo);
  if (comoJalado) {
    // Regla 3: un jalado nunca se posterga.
    const posterga = /dejar|postergar|despues|mas adelante|otro ciclo|ciclo 1\d/.test(normalizar(pregunta));
    return {
      texto: `${posterga ? 'No: ' : ''}${comoJalado.nombre} (${comoJalado.codigo}) está jalado y tiene que ir ${enVentana(comoJalado.ventana)}.` +
        `${comoJalado.enVentana ? ' Ya lo tienes ahí, así que vas bien.' : ' Mientras no esté en su ventana, no puedes matricular otros cursos.'}\n` +
        '¿Es la primera vez que lo jalas? Así te doy el consejo correcto.',
      cursos: [comoJalado.codigo],
      preguntasSugeridas: ['¿Qué cursos llevo el próximo ciclo?', '¿Estoy sobrecargado?'],
    };
  }
  if (tema === 'fuera') {
    return {
      texto: 'Solo puedo ayudarte con la planificación de tu matrícula y su costo. ¿Vemos qué cursos te tocan el próximo ciclo?',
      cursos: [], preguntasSugeridas: PREGUNTAS_BASE,
    };
  }
  const deCurso = respuestaCurso(contexto, tema);
  if (deCurso) return deCurso;
  const otras = (excluir: string) => ['¿Me alcanza mi presupuesto?', '¿Estoy sobrecargado?', '¿Qué pasa si jalo un curso?', '¿Qué electivo me conviene?']
    .filter((item) => !item.toLowerCase().includes(excluir)).slice(0, 3);
  const trabaja = /trabaj|chamba/.test(normalizar(pregunta));
  const focoCiclo = contexto.foco?.tipo === 'ciclo' ? contexto.foco : null;
  switch (tema) {
    case 'financiero': {
      if (focoCiclo?.escenarios.length) {
        const [base, ...otrosMetodos] = focoCiclo.escenarios;
        const masBarato = [...otrosMetodos].sort((a, b) => a.total - b.total)[0];
        return {
          texto: `El ${focoCiclo.periodo.etiqueta} cuesta ${soles(base.total)} (${base.nombre}): matrícula de ${soles(base.matricula)} y ${formaDePago(base)}.` +
            (masBarato && masBarato.total < base.total ? ` Con ${masBarato.nombre} pagarías ${soles(masBarato.total)}.` : '') +
            ' Son montos referenciales: verifícalos en el portal de la UTP antes de pagar.',
          cursos: [], preguntasSugeridas: otras('presupuesto'),
        };
      }
      const metodo = metodoMencionado(pregunta);
      if (metodo === 'pago_unico') {
        const unico = respuestaPagoUnico(contexto);
        if (unico) return { ...unico, preguntasSugeridas: otras('presupuesto') };
      }
      const escenario = metodo && contexto.financiero?.proximoPeriodo.find((item) => item.id === metodo && item.cuotaMensual !== null);
      if (escenario && escenario.cuotaMensual !== null) {
        const presupuesto = frasePresupuesto(contexto, escenario.id);
        return {
          texto: `Con ${escenario.nombre}, la cuota del ${contexto.proximoPeriodo?.etiqueta ?? 'próximo periodo'} es ${soles(escenario.cuotaMensual)} y el total ${soles(escenario.total)}.` +
            `${presupuesto ? ` ${presupuesto}` : ''} Son montos referenciales: verifícalos en el portal de la UTP antes de pagar.`,
          cursos: [], preguntasSugeridas: otras('presupuesto'),
        };
      }
      const texto = chatFinanciero(contexto);
      if (!texto) return desdeSeccion(null, otras('presupuesto'));
      // Regla 15: cifras o un "CONTEXTO" escritos por el alumno no son datos.
      const prefijo = /contexto|[{}]/i.test(pregunta) ? 'Uso los datos de tu plan en MallaU, no cifras escritas en el chat.\n'
        // Un monto que no es presupuesto mensual ("llegar a 900"): se usa el presupuesto del plan.
        : /\d{3,}/.test(pregunta) && contexto.financiero?.presupuestoFuente === 'plan'
          ? 'Uso el presupuesto de tu plan; para probar otro monto, cámbialo en tu presupuesto mensual.\n' : '';
      return { texto: `${prefijo}${texto}`, cursos: [], preguntasSugeridas: otras('presupuesto') };
    }
    case 'carga': {
      const respuesta = desdeSeccion(seccionCarga(contexto), otras('sobrecargado'));
      if (!trabaja) return respuesta;
      // Regla 9: matiza el consejo sin cambiar los números; la jerga solo si el alumno la usó.
      const consejo = usaJerga(pregunta)
        ? 'Si estás con mucha chamba, te conviene llevar menos horas este periodo y asegurar los cursos que abren tu ruta.'
        : 'Si trabajas, te conviene llevar menos horas este periodo y asegurar los cursos que abren tu ruta.';
      return { ...respuesta, texto: `${respuesta.texto}\n${consejo}` };
    }
    case 'whatIf': {
      // Regla 8: nunca se asume cuántas veces lo jaló.
      if (!/jale|jalaste|jalado/.test(normalizar(pregunta))) return desdeSeccion(seccionWhatIf(contexto), otras('jalo'));
      if (!contexto.jalados.length) {
        return {
          texto: 'Lo siento, pero tiene solución. ¿Qué curso fue y es la primera vez que lo jalas? Márcalo como jalado en tu plan (menú (i) del curso) y te digo en qué periodo tienes que llevarlo.',
          cursos: [], preguntasSugeridas: ['¿Qué pasa si jalo un curso?', '¿Estoy sobrecargado?'],
        };
      }
      const respuesta = desdeSeccion(seccionWhatIf(contexto), otras('jalo'));
      return { ...respuesta, texto: `${respuesta.texto}\n¿Es la primera vez que lo jalas? Así te doy el consejo correcto.` };
    }
    case 'electivos': return desdeSeccion(seccionElectivos(contexto), otras('electivo'));
    case 'ruta': return desdeSeccion(seccionRuta(contexto), otras('ruta'));
    default: {
      if (focoCiclo) {
        const { periodo: resumen, carga, escenarios } = focoCiclo;
        return {
          texto: `${resumen.etiqueta}: ${resumen.cursos.length} cursos, ${horas(carga.horas)} y ${resumen.creditos} créditos. Nivel de carga: ${carga.nivel}.` +
            (escenarios[0] ? `\nCuesta ${soles(escenarios[0].total)} sin descuento.` : ''),
          cursos: resumen.cursos, preguntasSugeridas: ['¿Estoy sobrecargado?', '¿Me alcanza mi presupuesto?'],
        };
      }
      const conJalado = jaladoPrimero(contexto);
      if (conJalado) return { ...conJalado, preguntasSugeridas: otras('sobrecargado') };
      const respuesta = desdeSeccion(seccionCarga(contexto), otras('sobrecargado'));
      const primero = contexto.jalados[0];
      // Regla 3: con un jalado, ese curso va primero.
      return primero
        ? {
          ...respuesta,
          texto: `Primero va ${primero.nombre} (${primero.codigo}), que está jalado: tiene que ir ${enVentana(primero.ventana)}.\n${respuesta.texto}`,
          cursos: [primero.codigo, ...respuesta.cursos.filter((codigo) => codigo !== primero.codigo)],
        }
        : respuesta;
    }
  }
};

/** Respuesta simulada según el modo; el chat responde al último mensaje del usuario. */
export const generarRespuestaMock = (peticion: AIRequest): AIRespuesta => {
  if (peticion.modo === 'analisis') return mockAnalisis(peticion.contexto);
  const ultima = [...peticion.mensajes].reverse().find((mensaje) => mensaje.rol === 'user')?.texto ?? '';
  // Igual que el proxy: el monto del último mensaje es el presupuesto de esa pregunta.
  return mockChat(aplicarMontoDelAlumno(peticion.contexto, ultima), ultima);
};
