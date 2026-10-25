import { errorSecciones, type AIContext, type AIRespuesta } from './contracts.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

/**
 * Chequeos de una respuesta contra CONTEXTO. Los usa el filtro de salida del proxy (antes de devolver cada
 * respuesta real) y la evaluación (scripts/evaluacion/chequeos.ts). Nunca registran contenido: solo el
 * nombre del chequeo que falló.
 */

export const normalizar = (texto: string) => texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Todo el texto visible de la respuesta (sin las preguntas sugeridas). */
export const textoDe = (respuesta: AIRespuesta): string => 'texto' in respuesta
  ? respuesta.texto
  : [respuesta.resumen, ...respuesta.secciones.flatMap((seccion) => [seccion.titulo, seccion.detalle, ...seccion.acciones])].join('\n');

/** "S/ 4,705.86", "S/4705.86", "S/. 900" → número. */
export const montosEn = (texto: string): number[] =>
  [...texto.matchAll(/S\/\.?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)]
    .map((m) => Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`));

/** Todos los números del contexto, en valor absoluto (una diferencia negativa se dice "faltan S/ x"). */
export const numerosDe = (valor: unknown): number[] => typeof valor === 'number' ? [Math.abs(valor)]
  : Array.isArray(valor) ? valor.flatMap(numerosDe)
    : valor && typeof valor === 'object' ? Object.values(valor).flatMap(numerosDe) : [];

/** Números de los campos cuyo nombre cumple `clave` (por ejemplo, todo lo que sea créditos). */
export const numerosPorClave = (valor: unknown, clave: RegExp, dentro = false): number[] => typeof valor === 'number' ? (dentro ? [Math.abs(valor)] : [])
  : Array.isArray(valor) ? valor.flatMap((item) => numerosPorClave(item, clave, dentro))
    : valor && typeof valor === 'object'
      ? Object.entries(valor).flatMap(([nombre, item]) => numerosPorClave(item, clave, dentro || clave.test(nombre))) : [];

export const numerosDelTexto = (texto: string) => [...texto.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));

export const codigosEn = (texto: string): string[] => [...new Set(texto.match(/\b\d{6}[A-Z0-9]{4}\b/g) ?? [])];

/** Tolerancia de 0.01 (más un margen por la representación en coma flotante). */
export const cerca = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 1e-9;

export const DELIMITADORES = ['<<CONTEXTO_MALLAU>>', '<<FIN_CONTEXTO_MALLAU>>'];

/** Marcas que solo están en el prompt: si aparecen, lo reveló. */
const MARCAS_PROMPT = [
  'GLOSARIO ESTUDIANTIL', 'REGLAS (obligatorias)', 'EJEMPLOS DE TONO', 'CODIGO-EJEMPLO', 'CÓMO HABLAS',
  'La jerga es un espejo', 'Responde SIEMPRE con un único objeto JSON', 'ESQUEMA JSON', 'EXCLUSIVAMENTE los datos del objeto CONTEXTO',
  'CONTEXTO_MALLAU',
].map(normalizar);

/** Líneas de la GUÍA DE MALLAU: el asistente las repite al explicar cómo usar la app. */
const LINEAS_GUIA = new Set((SYSTEM_PROMPT.split('GUÍA DE MALLAU')[1] ?? '').split('REGLAS (obligatorias)')[0].split('\n')
  .filter((linea) => linea.startsWith('- ')));

/**
 * Tiras de 15 palabras de las reglas. Sin la 8 (bika y trika), la 12 (costos referenciales) ni la GUÍA DE MALLAU:
 * el asistente debe repetir esas frases al alumno.
 */
const TIRAS_PROMPT = (() => {
  const reglas = SYSTEM_PROMPT.split('EJEMPLOS DE TONO')[0].split('\n')
    .filter((linea) => !/^(8|12)\.|^\s+- (Bika|Trika)/.test(linea) && !LINEAS_GUIA.has(linea)).join(' ');
  const palabras = normalizar(reglas).split(/[^a-z0-9ñ]+/).filter(Boolean);
  const tiras = new Set<string>();
  for (let i = 0; i + 15 <= palabras.length; i += 1) tiras.add(palabras.slice(i, i + 15).join(' '));
  return tiras;
})();

export const revelaPrompt = (texto: string): boolean => {
  const t = normalizar(texto);
  if (MARCAS_PROMPT.some((marca) => t.includes(marca))) return true;
  const palabras = t.split(/[^a-z0-9ñ]+/).filter(Boolean);
  for (let i = 0; i + 15 <= palabras.length; i += 1) if (TIRAS_PROMPT.has(palabras.slice(i, i + 15).join(' '))) return true;
  return false;
};

// ==========================================
// Atributos de curso (créditos, horas y estado)
// ==========================================

export interface AtributosCurso {
  codigo: string;
  nombre: string;
  creditos: number;
  /** null si CONTEXTO no trae sus horas (el catálogo no las tiene). */
  horas: number | null;
  estado: string;
  jalado: boolean;
}

/** Créditos y estado del catálogo; horas de donde CONTEXTO las tenga (próximo periodo, electivos o foco). */
export const atributosDeCursos = (contexto: AIContext): AtributosCurso[] => {
  const horas = new Map<string, number>();
  for (const curso of [...(contexto.proximoPeriodo?.cursos ?? []), ...contexto.electivos, ...contexto.derivados.cursosProximoPeriodo]) {
    horas.set(curso.codigo, curso.horas);
  }
  if (contexto.foco?.tipo === 'curso') horas.set(contexto.foco.codigo, contexto.foco.horas);
  if (contexto.foco?.tipo === 'ciclo') for (const curso of contexto.foco.cursos) horas.set(curso.codigo, curso.horas);
  const jalados = new Set(contexto.jalados.map((jalado) => jalado.codigo));
  return contexto.catalogo.map((curso) => ({
    codigo: curso.codigo, nombre: curso.nombre, creditos: curso.creditos, horas: horas.get(curso.codigo) ?? null,
    estado: curso.estado, jalado: jalados.has(curso.codigo),
  }));
};

interface Mencion { curso: AtributosCurso; inicio: number; fin: number }

const esLetra = (caracter: string | undefined) => caracter !== undefined && /[a-z0-9ñ]/.test(caracter);

/** Menciones de cursos por código o nombre completo, la más larga primero (CÁLCULO II antes que CÁLCULO I). */
const mencionesDe = (t: string, cursos: AtributosCurso[]): Mencion[] => {
  const ocupado = new Array<boolean>(t.length).fill(false);
  const menciones: Mencion[] = [];
  const marcas = cursos.flatMap((curso) => [normalizar(curso.codigo), normalizar(curso.nombre)].map((marca) => ({ curso, marca })))
    .sort((a, b) => b.marca.length - a.marca.length);
  for (const { curso, marca } of marcas) {
    for (let desde = t.indexOf(marca); desde >= 0; desde = t.indexOf(marca, desde + 1)) {
      const fin = desde + marca.length;
      if (esLetra(t[desde - 1]) || esLetra(t[fin]) || ocupado.slice(desde, fin).some(Boolean)) continue;
      ocupado.fill(true, desde, fin);
      menciones.push({ curso, inicio: desde, fin });
    }
  }
  return menciones.sort((a, b) => a.inicio - b.inicio);
};

/** Cuánto texto después de un curso se considera "junto a" él. */
const VENTANA_ATRIBUTO = 60;
/**
 * Fin de lo que se dice del curso: fin de frase, el paso a un total del periodo o a un límite, o lo que pasaría
 * con el periodo sin el curso ("sin X bajarías a 21 h": esas horas son del periodo, derivados.horasSinCadaCurso).
 */
const FIN_DEL_CURSO = /[.;!?](\s|$)|\n|\b(el|tu|ese|este|del|al) (periodo|ciclo|verano|plan)\b|\b(en total|suma[ns]?|total|tope|recomendad[oa]s?|escala|limite)\b|\b(baja[ns]?|bajarias?|bajando|queda[ns]?|quedarias?|quedando|sube[ns]?|subirias?|pasa[ns]?|pasarias?|deja[ns]?|dejarias?|dejaria)\b/;

const ESTADOS: { patron: RegExp; acepta: (curso: AtributosCurso) => boolean }[] = [
  { patron: /\b(desaprobad[oa]|jalad[oa])\b/, acepta: (curso) => curso.jalado },
  { patron: /\b(?<!des)aprobad[oa]\b/, acepta: (curso) => curso.estado === 'APROBADO' || curso.estado === 'CONVALIDADO' },
  { patron: /\bconvalidad[oa]\b/, acepta: (curso) => curso.estado === 'CONVALIDADO' },
  { patron: /\ben curso\b|\blo (estas )?llevando\b/, acepta: (curso) => curso.estado === 'EN_CURSO' },
  { patron: /\bpendiente\b/, acepta: (curso) => curso.estado === 'PENDIENTE' },
];

/** "no está aprobado", "no figura como convalidado": la negación no afirma el estado. */
const negado = (texto: string, posicion: number) => /\bno\s+(\S+\s+){0,2}$/.test(texto.slice(Math.max(0, posicion - 30), posicion));

export interface AtributoIncorrecto {
  codigo: string;
  nombre: string;
  atributo: 'creditos' | 'horas' | 'estado';
  dicho: string;
  enContexto: string;
}

/**
 * Créditos, horas o estado dichos justo después de un curso (hasta el fin de la frase, el siguiente curso, un
 * total del periodo o 60 caracteres) que no coinciden con CONTEXTO. Horas de un curso cuyo CONTEXTO no las trae también cuentan.
 */
export const atributosIncorrectos = (texto: string, contexto: AIContext): AtributoIncorrecto[] => {
  const t = normalizar(texto);
  const menciones = mencionesDe(t, atributosDeCursos(contexto));
  const incorrectos: AtributoIncorrecto[] = [];
  const agregar = (curso: AtributosCurso, atributo: AtributoIncorrecto['atributo'], dicho: string, enContexto: string) => {
    if (!incorrectos.some((item) => item.codigo === curso.codigo && item.atributo === atributo && item.dicho === dicho)) {
      incorrectos.push({ codigo: curso.codigo, nombre: curso.nombre, atributo, dicho, enContexto });
    }
  };
  menciones.forEach((mencion, indice) => {
    const siguiente = menciones.slice(indice + 1).find((otra) => otra.curso.codigo !== mencion.curso.codigo)?.inicio ?? t.length;
    let tramo = t.slice(mencion.fin, Math.min(siguiente, mencion.fin + VENTANA_ATRIBUTO));
    const corte = tramo.search(FIN_DEL_CURSO);
    if (corte >= 0) tramo = tramo.slice(0, corte);
    const { curso } = mencion;
    for (const m of tramo.matchAll(/(\d+(?:[.,]\d+)?)\s*(creditos?|cr\b)/g)) {
      const valor = Number(m[1].replace(',', '.'));
      if (valor !== curso.creditos) agregar(curso, 'creditos', `${m[1]} créditos`, `${curso.creditos} créditos`);
    }
    for (const m of tramo.matchAll(/(\d+(?:[.,]\d+)?)\s*(h\b|horas?\b)/g)) {
      const valor = Number(m[1].replace(',', '.'));
      if (curso.horas === null) agregar(curso, 'horas', `${m[1]} h`, 'sin horas en CONTEXTO');
      else if (valor !== curso.horas) agregar(curso, 'horas', `${m[1]} h`, `${curso.horas} h`);
    }
    for (const { patron, acepta } of ESTADOS) {
      const m = tramo.match(patron);
      if (m && m.index !== undefined && !negado(tramo, m.index) && !acepta(curso)) agregar(curso, 'estado', m[0], curso.estado);
    }
  });
  return incorrectos;
};

// ==========================================
// Planes citados (propuestaConLimites y rutaSugerida)
// ==========================================

interface FuentePeriodo { cursos: Set<string>; numeroCursos: Set<number>; horas: Set<number>; creditos: Set<number> }

/**
 * Lo que CONTEXTO dice de cada periodo: la propuesta con límites, la ruta sugerida y la malla del alumno (periodos
 * planificados, el próximo periodo con sus jalados y el foco). Un plan citado solo puede usar estos datos.
 */
const fuentesPorPeriodo = (contexto: AIContext) => {
  const fuentes = new Map<string, FuentePeriodo>();
  const agregar = (id: string, datos: { cursos?: string[]; horas?: number; creditos?: number }) => {
    const fuente = fuentes.get(id) ?? { cursos: new Set(), numeroCursos: new Set(), horas: new Set(), creditos: new Set() };
    datos.cursos?.forEach((codigo) => fuente.cursos.add(codigo));
    if (datos.cursos) fuente.numeroCursos.add(datos.cursos.length);
    if (datos.horas !== undefined) fuente.horas.add(datos.horas);
    if (datos.creditos !== undefined) fuente.creditos.add(datos.creditos);
    fuentes.set(id, fuente);
  };
  contexto.propuestaConLimites?.periodos.forEach((periodo) => agregar(periodo.periodoId, periodo));
  contexto.rutaSugerida.propuesta.forEach((periodo) => agregar(periodo.periodoId, periodo));
  contexto.periodosPlanificados.forEach((periodo) => agregar(periodo.id, periodo));
  // Del próximo periodo, además: sus restas ya calculadas (sobre el tope, sin cada curso) y la carga.
  const { derivados, carga, proximoPeriodo } = contexto;
  const conJalados = derivados.proximoPeriodoConJalados;
  if (proximoPeriodo) {
    const fuente = fuentes.get(proximoPeriodo.id) ?? { cursos: new Set(), numeroCursos: new Set(), horas: new Set(), creditos: new Set() };
    [...numerosDe(derivados.horas), carga.horas, conJalados?.horasSobreTopeEscala ?? 0, conJalados?.horasSobreRecomendadas ?? 0,
      ...derivados.horasSinCadaCurso.map((item) => item.horasSinElCurso)].forEach((valor) => fuente.horas.add(valor));
    fuentes.set(proximoPeriodo.id, fuente);
  }
  if (conJalados) agregar(conJalados.periodoId, { cursos: [...(contexto.proximoPeriodo?.cursos.map((curso) => curso.codigo) ?? []), ...conJalados.jalados], horas: conJalados.horas, creditos: conJalados.creditos });
  if (contexto.foco?.tipo === 'ciclo') agregar(contexto.foco.periodo.id, contexto.foco.periodo);
  return fuentes;
};

/** Periodos donde CONTEXTO ubica cada curso: su lugar en la malla, en las propuestas y en una ventana de recuperación. */
const periodosDeCursos = (contexto: AIContext, fuentes: Map<string, FuentePeriodo>) => {
  const periodos = new Map<string, Set<string>>();
  const agregar = (codigo: string, id: string) => periodos.set(codigo, (periodos.get(codigo) ?? new Set()).add(id));
  contexto.catalogo.forEach((curso) => agregar(curso.codigo, curso.ubicacion));
  fuentes.forEach((fuente, id) => fuente.cursos.forEach((codigo) => agregar(codigo, id)));
  contexto.jalados.forEach((jalado) => jalado.ventana.forEach((id) => agregar(jalado.codigo, id)));
  contexto.whatIf.forEach((item) => {
    item.ventanaSiJala.forEach((id) => agregar(item.codigo, id));
    item.planificadosInvalidos.forEach((invalido) => agregar(invalido.codigo, invalido.periodoId));
  });
  const foco = contexto.foco;
  if (foco?.tipo === 'curso') [...foco.whatIf.ventanaSiJala, ...foco.ventanaRecuperacion].forEach((id) => agregar(foco.codigo, id));
  return periodos;
};

/** Topes y totales que se pueden citar junto a cualquier periodo ("el tope de 22 h", "tu límite de 20 h"). */
const numerosGenerales = (contexto: AIContext) => {
  const { limites, carga, derivados, propuestaConLimites, descuentos, perfil } = contexto;
  const horas = [limites.horasMaximasPlanificacion, limites.horasRecomendadasPeriodo, limites.topeEscalaPension, carga.topeEscala,
    carga.limiteRecomendado, derivados.horas.topeEscala, derivados.horas.recomendadas, descuentos?.horasSinRecargo,
    propuestaConLimites?.limites.maxHorasPorPeriodo, propuestaConLimites?.limites.horasAplicadas, propuestaConLimites?.limites.horasPorCuota];
  const creditos = [limites.creditosMaximosVerano, limites.creditosMinimosElectivos, propuestaConLimites?.limites.maxCreditosPorPeriodo,
    propuestaConLimites?.limites.creditosAplicados, ...numerosDe(derivados.creditos), derivados.creditosElectivosFaltantes,
    ...numerosDe(perfil.creditos), ...numerosDe(perfil.electivos)];
  const definidos = (valores: (number | null | undefined)[]) => valores.filter((valor): valor is number => typeof valor === 'number');
  return { horas: definidos(horas), creditos: definidos(creditos) };
};

/** Relaciones entre cursos: ahí un curso se nombra junto a un periodo que no es el suyo. */
const HABLA_DE_RELACION = /prerrequisito|requisito|habilita|desbloquea|bloquea|depende|abre/;
const PERIODO_EN_TEXTO = /\b(ciclo|verano)\s+(\d{1,2})\b/g;

export interface PlanNoVerificado { periodo: string; detalle: string }

/**
 * Cursos y cifras de un plan citado que no salen de CONTEXTO. Se revisa cada frase que nombra UN solo periodo
 * ("Ciclo 9: 6 cursos, 20 h", "en el Ciclo 9 llevas X y Y"): sus cursos deben estar en ese periodo en alguna fuente
 * (propuesta con límites, ruta sugerida, la malla o una ventana de recuperación) y sus "N cursos", "N h" y
 * "N créditos", ser los de ese periodo, un tope o los de un curso de la frase. También "N ciclos más".
 */
export const planNoVerificado = (texto: string, contexto: AIContext): PlanNoVerificado[] => {
  const fuentes = fuentesPorPeriodo(contexto);
  const periodosDe = periodosDeCursos(contexto, fuentes);
  const generales = numerosGenerales(contexto);
  const cursos = atributosDeCursos(contexto);
  const problemas: PlanNoVerificado[] = [];
  const agregar = (periodo: string, detalle: string) => {
    if (!problemas.some((problema) => problema.detalle === detalle)) problemas.push({ periodo, detalle });
  };
  const propuesta = contexto.propuestaConLimites;
  for (const frase of normalizar(texto).split(/(?<=[.;!?])\s+|\n|;\s*/)) {
    const mencionados = [...new Set([...frase.matchAll(PERIODO_EN_TEXTO)].map((m) => `${m[1]}-${Number(m[2])}`))];
    if (propuesta) {
      for (const m of frase.matchAll(/\b(\d+)\s+ciclos?\s+(mas|extra|adicional(?:es)?)\b/g)) {
        const permitidos = [propuesta.ciclosAgregados.length, propuesta.ciclosExtraVsSinLimites, propuesta.limites.agregarCiclo ? 1 : null];
        if (!permitidos.includes(Number(m[1]))) agregar('', `Dijiste ${m[1]} ciclos más; en la propuesta: ${propuesta.ciclosAgregados.length}.`);
      }
    }
    if (mencionados.length !== 1) continue;
    const [id] = mencionados;
    const fuente = fuentes.get(id);
    if (!fuente) continue;
    const etiqueta = id.replace('ciclo-', 'Ciclo ').replace('verano-', 'Verano ');
    const enFrase = mencionesDe(frase, cursos);
    if (!HABLA_DE_RELACION.test(frase)) {
      for (const { curso } of enFrase) {
        if (!periodosDe.get(curso.codigo)?.has(id)) agregar(id, `Pusiste ${curso.nombre} (${curso.codigo}) en el ${etiqueta}, pero CONTEXTO no lo ubica ahí.`);
      }
    }
    // Las horas de cualquier curso del periodo valen ("5 cursos de 4 h o más", corrida 2026-10-25-1246).
    const deCursos = [...enFrase.map(({ curso }) => curso), ...cursos.filter((curso) => fuente.cursos.has(curso.codigo))];
    const revisar = (patron: RegExp, permitidos: number[], unidad: string, esParte?: (resto: string, valor: number) => boolean) => {
      for (const m of frase.matchAll(patron)) {
        const valor = Number(m[1].replace(',', '.'));
        if (esParte?.(frase.slice((m.index ?? 0) + m[0].length), valor)) continue;
        if (!permitidos.some((numero) => cerca(numero, valor))) agregar(id, `Dijiste ${m[1]} ${unidad} para el ${etiqueta}, que no sale de la propuesta ni de la ruta sugerida.`);
      }
    };
    // "5 cursos de 4 h o más", "2 cursos con laboratorio": una parte del periodo, no su total.
    const maximoCursos = Math.max(0, ...fuente.numeroCursos);
    revisar(/(\d+)\s*(?:cursos|materias)\b/g, [...fuente.numeroCursos], 'cursos',
      (resto, valor) => /^\s+(de|con|que|del|sin)\b/.test(resto) && valor <= maximoCursos);
    revisar(/(\d+(?:[.,]\d+)?)\s*(?:h\b|horas?\b)/g,
      [...fuente.horas, ...generales.horas, ...deCursos.flatMap((curso) => curso.horas === null ? [] : [curso.horas])], 'h');
    revisar(/(\d+(?:[.,]\d+)?)\s*(?:creditos?\b|cr\b)/g, [...fuente.creditos, ...generales.creditos, ...deCursos.map((curso) => curso.creditos)], 'créditos');
  }
  return problemas;
};

// ==========================================
// Filtro de salida
// ==========================================

export type ChequeoSalida = 'monto' | 'codigo' | 'atributo-curso' | 'delimitador' | 'prompt' | 'secciones' | 'nombre-interno' | 'plan';

export interface ProblemaSalida {
  chequeo: ChequeoSalida;
  /** Para el mensaje de corrección al modelo; nunca va al log. */
  detalle: string;
}

/** Todas las claves de un objeto, a cualquier profundidad (los nombres de campo del contexto). */
const clavesDe = (valor: unknown, claves = new Set<string>()): Set<string> => {
  if (Array.isArray(valor)) for (const item of valor) clavesDe(item, claves);
  else if (valor && typeof valor === 'object') {
    for (const [clave, item] of Object.entries(valor)) {
      claves.add(clave);
      clavesDe(item, claves);
    }
  }
  return claves;
};

/**
 * Nombres internos en el texto: "CONTEXTO", "derivados", "perfil.", "proximoPeriodo" y cualquier palabra con forma de
 * campo (camelCase o con punto) que sea una clave del contexto ("CONTEXTO.derivados.horasSinCadaCurso").
 */
export const nombresInternos = (texto: string, contexto: AIContext): string[] => {
  const claves = clavesDe(contexto);
  const encontrados = [
    ...(texto.match(/\bCONTEXTO\b|\bderivados\b|\bperfil\.|\bproximoPeriodo\b/gi) ?? []).filter((nombre) => nombre !== 'contexto'),
    ...(texto.match(/\b[a-z]+(?:[A-Z][a-zA-Z]*)+\b/g) ?? []).filter((palabra) => claves.has(palabra)),
    ...(texto.match(/\b[a-zA-Z]+(?:\.[a-zA-Z]+)+\b/g) ?? []).filter((palabra) => palabra.split('.').some((parte) => claves.has(parte))),
  ];
  return [...new Set(encontrados)];
};

/** El alumno señaló un error: ahí "tienes razón" sí responde a algo que dijo. */
const ALUMNO_SENALA_ERROR = /error|equivoca|\bmal\b|no es asi|incorrect|confundiste|corrige|no es cierto/;
/** "Tienes razón, corrijo", "me confundí", "corrijo:" al inicio: le habla al mensaje de corrección, no al alumno. */
const RESPUESTA_A_CORRECCION = /^\s*(tienes razon[,.:;]?\s*(me confundi|corrijo)|me confundi\b|corrijo\s*:)/;

/** Primeras palabras visibles de la respuesta (el texto del chat o el resumen del análisis). */
const inicioDe = (respuesta: AIRespuesta) => normalizar('texto' in respuesta ? respuesta.texto : respuesta.resumen);

export const hablaACorreccion = (respuesta: AIRespuesta, mensajesAlumno: string[]): boolean =>
  RESPUESTA_A_CORRECCION.test(inicioDe(respuesta)) && !ALUMNO_SENALA_ERROR.test(normalizar(mensajesAlumno.at(-1) ?? ''));

const soles = (monto: number) => `S/ ${monto.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** Lo que el filtro exige a cada respuesta real antes de devolverla. */
export const verificarSalida = (respuesta: AIRespuesta, contexto: AIContext, mensajesAlumno: string[] = []): ProblemaSalida[] => {
  const texto = textoDe(respuesta);
  const problemas: ProblemaSalida[] = [];
  if ('secciones' in respuesta) {
    const error = errorSecciones(respuesta.secciones.map((seccion) => seccion.tipo));
    if (error) problemas.push({ chequeo: 'secciones', detalle: error });
  }
  // El monto que escribió el alumno ya está en el contexto (aplicarMontoDelAlumno): no hay excepción por el mensaje.
  const permitidos = numerosDe(contexto);
  for (const monto of [...new Set(montosEn(texto))]) {
    if (!permitidos.some((numero) => cerca(numero, monto))) problemas.push({ chequeo: 'monto', detalle: `Usaste ${soles(monto)}, que no está en CONTEXTO.` });
  }
  const catalogo = new Set(contexto.catalogo.map((curso) => curso.codigo));
  const cursos = 'texto' in respuesta ? respuesta.cursos : respuesta.secciones.flatMap((seccion) => seccion.cursos);
  for (const codigo of [...new Set([...codigosEn(texto), ...cursos])]) {
    if (!catalogo.has(codigo)) problemas.push({ chequeo: 'codigo', detalle: `Mencionaste el código ${codigo}, que no está en CONTEXTO.` });
  }
  for (const item of atributosIncorrectos(texto, contexto)) {
    problemas.push({
      chequeo: 'atributo-curso',
      detalle: `Dijiste ${item.dicho} para ${item.nombre} (${item.codigo}); en CONTEXTO: ${item.enContexto}.`,
    });
  }
  for (const item of planNoVerificado(texto, contexto)) problemas.push({ chequeo: 'plan', detalle: item.detalle });
  const internos = nombresInternos(texto, contexto);
  if (internos.length) {
    problemas.push({ chequeo: 'nombre-interno', detalle: `Tu respuesta menciona nombres internos (${internos.join(', ')}); el alumno no los conoce.` });
  }
  if (hablaACorreccion(respuesta, mensajesAlumno)) {
    problemas.push({ chequeo: 'nombre-interno', detalle: 'Tu respuesta le habla a una corrección: el alumno no señaló ningún error.' });
  }
  if (DELIMITADORES.some((delimitador) => texto.includes(delimitador))) {
    problemas.push({ chequeo: 'delimitador', detalle: 'Tu respuesta incluye los delimitadores del contexto.' });
  } else if (revelaPrompt(texto)) {
    problemas.push({ chequeo: 'prompt', detalle: 'Tu respuesta reproduce partes de tus instrucciones.' });
  }
  return problemas;
};

/** Mensaje del sistema para la única regeneración: el error concreto y la instrucción de corregir. */
export const mensajeCorreccion = (problemas: ProblemaSalida[]) =>
  `${[...new Set(problemas.map((problema) => problema.detalle))].join(' ')} Corrige usando solo CONTEXTO. ${FIN_CORRECCION}`;

/** Cierre del mensaje de corrección: sin él, la respuesta regenerada le contestaba a la corrección (F-036). */
export const FIN_CORRECCION = 'Escribe de nuevo tu respuesta para el alumno, como si fuera la primera: no menciones esta corrección, ni CONTEXTO, ni nombres de campos.';
