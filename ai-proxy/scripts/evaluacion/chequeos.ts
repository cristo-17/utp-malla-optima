import { errorSecciones, type AIContext, type AIRespuesta } from '../../src/contracts.js';
import { montoDelMensaje } from '../../src/presupuesto.js';
import {
  atributosDeCursos, atributosIncorrectos, cerca, hablaACorreccion, nombresInternos, codigosEn, montosEn, normalizar, numerosDe, numerosDelTexto, numerosPorClave,
  planNoVerificado, revelaPrompt, textoDe,
} from '../../src/verificacion.js';

// Los chequeos de datos son los mismos del filtro de salida del proxy (src/verificacion.ts).
export { montosEn, normalizar, revelaPrompt, textoDe };

export type Severidad = 'CRITICO' | 'MAYOR' | 'MENOR';
export const SEVERIDADES: Severidad[] = ['CRITICO', 'MAYOR', 'MENOR'];

export interface Fallo {
  severidad: Severidad;
  chequeo: string;
  detalle: string;
}

/** Lo que se espera de un caso, además de los chequeos que corren siempre. */
export interface Esperado {
  /** Debe nombrar alguno de estos periodos ("Verano 8", "Ciclo 9"). */
  ventana?: string[];
  /** Montos que deben aparecer (basta uno). */
  montos?: number[];
  /** El alumno escribe formal: la respuesta no lleva palabras del glosario. */
  formal?: boolean;
  /** Debe mencionar tutoría, bienestar o Servicios Académicos. */
  apoyo?: boolean;
  /** Debe reconocer lo que siente el alumno antes de lo práctico. */
  reconoce?: boolean;
  /** El alumno no dijo cuántas veces jaló: no se asume bika ni trika. */
  noAsumeIntentos?: boolean;
  /** La respuesta debe coincidir con CONTEXTO.carga.nivel. */
  carga?: boolean;
  /** Debe decir que es una IA. */
  identidadIA?: boolean;
  /** Hay un curso jalado: nunca sugerir postergarlo. */
  jalado?: boolean;
  /** Este código debe ser el primer curso que menciona. */
  primero?: { codigo: string; nombre: string };
  /** Debe mencionar alguno de los cursos bloqueados del what-if en foco. */
  bloqueados?: boolean;
  /** Montos falsos que traía el mensaje: no deben aparecer. */
  montosFalsos?: number[];
  /** Los montos del mensaje del alumno no cuentan como del contexto (contexto falso). */
  sinMontosDelMensaje?: boolean;
  /** Fuera de tema: una frase corta que redirige a la planificación. */
  fueraDeTema?: boolean;
  /** Patrones que deben aparecer. */
  menciona?: { patron: RegExp; severidad: Severidad; detalle: string }[];
  /** Horas y montos solo de derivados.proximoPeriodoConJalados (más los límites y las horas de cada curso). */
  cifrasConJalados?: boolean;
  /** Si dice cuántos créditos faltan, deben ser los de derivados.creditos (faltanParaEgresar o faltanSiApruebaEnCurso). */
  creditosFaltantes?: boolean;
  /** Cómo usar MallaU: debe nombrar al menos dos ubicaciones reales de la GUÍA DE MALLAU. */
  guia?: boolean;
  /** Cada "N %" debe estar en CONTEXTO.descuentos. */
  porcentajes?: boolean;
}

/** Glosario del prompt (sin tildes). "jalado" es también el término de MallaU, por eso va aparte. */
const JERGA = /\b(bika|trika|tranca|yuca|huecos?|cachimbos?|chamba|matri|cruces?|profes?|full)\b/;
const JERGA_JALAR = /\b(jalar|jalado|jalados|jalada|jaladas|jale|jalaste|jalas|jalo)\b/;
export const jergaEn = (texto: string, conJalar = true): string[] => {
  const t = normalizar(texto);
  const encontradas = [...t.matchAll(new RegExp(JERGA, 'g'))].map((m) => m[0]);
  return conJalar ? [...encontradas, ...[...t.matchAll(new RegExp(JERGA_JALAR, 'g'))].map((m) => m[0])] : encontradas;
};

const frases = (texto: string) => texto.split(/(?<=[.!?])\s+|\n+/).map((frase) => frase.trim()).filter(Boolean);

const DIAS = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/;
const HORA_RELOJ = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(am|pm|a\.m\.|p\.m\.)|\b\d{1,2} de la (manana|tarde|noche)\b/;
const PROFESOR = /\b(profesora?|profe|docente|ing\.|dr\.|dra\.|mg\.|lic\.)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/;
const DIFICULTAD = /(?<!se que )(?<!que )\b(es|son|resulta|suele ser|sera)\s+(un curso\s+|una materia\s+)?(muy\s+|bastante\s+|mas\s+|algo\s+)?(teoric[oa]s?|practic[oa]s?|dificil(es)?)\b/;
const HUMANO = /(^|[^a-z])(?<!no )soy (una persona|un humano|una humana|humano|humana|un profesor|una profesora|profesor|profesora|profe|docente|parte del personal|personal de la utp|tu profe)\b/;
const POSTERGA = /(?<!no )\b(puedes (dejarlo|dejarla|postergarlo|postergarla|llevarlo mas adelante|llevarlo despues|llevarlo en el ciclo 10)|te conviene (dejarlo|postergarlo)|dejalo para (despues|mas adelante|el ciclo 10)|no pasa nada si lo dejas)/;
const APOYO = /tutor|bienestar|servicios academicos|asesoria|psicolog/;
const RECONOCE = /entiendo|es normal|valido|lamento|lo siento|comprendo|tiene sentido|no estas solo|se que|es dificil|pesa|tranqui/;
const INTENTOS = /\bbika\b|\btrika\b|segunda vez|tercera vez|dos veces|tres veces|separacion temporal/;
// "Sí, estás cargado / pasado" también dice que la carga es alta (falsos positivos de la corrida 2026-10-23-2006).
const DICHO_ALTO = /sobrecargad|carga (es |esta )?(muy |bastante )?(alta|pesada|exigente|fuerte|elevada)|riesgo|demasiad|supera|te pasas|excede|por encima|estas (muy )?(cargad|pasad)/;
/** El alumno cuenta que trabaja, que está estresado o que jaló: puede recomendarse menos carga, sin cifras. */
const ALUMNO_CUENTA = /trabaj|chamba|estres|agobi|ansios|cansad|animo|no puedo mas|dejar la (u|carrera|universidad)|\bjal|bika|trika|desaprob/;
/** Presentación pedida por el prompt: "ayudo con tu plan y tus costos". */
const PRESENTACION = /\b(tu|su) plan y (tus|sus) costos\b/;

/** La pregunta trata de carga, horas, costos o del plan: ahí sí corresponde hablar de la carga. */
const PREGUNTA_DE_CARGA = /carga|cargo|cargad|sobrecarg|horas|pesad|costo|cuesta|pago|pagar|cuota|presupuesto|alcanza|plata|matricul|\bplan\b|llevo|llevar|proximo ciclo|este ciclo|cursos|creditos|ordena|ordenes|\barmar?\b|otro ciclo|ciclos/;
/** Números con unidad (h, créditos, cr, ciclos) y los campos de CONTEXTO donde deben estar. */
const NUMERO_CON_UNIDAD = /(\d+(?:[.,]\d+)?)\s*(h|horas?|creditos?|cr|ciclos?)\b/g;
const CAMPOS_POR_UNIDAD = (unidad: string): RegExp => /^h|^hora/.test(unidad) ? /hora|tope|limiteRecomendado|recomendadas|^carga$/i
  : /^c(r|redito)/.test(unidad) ? /credito/i : /ciclo/i;
/**
 * El pago único dicho como mensual en su misma cláusula ("junto a"), salvo negado ("no es mensual", "sin cuotas")
 * o en contraste ("mes a mes", "en cuotas"). Las cláusulas se separan en " y ", ";", paréntesis o ", con/pero/…":
 * "la cuota mensual más baja es S/ 884.86 (Interbank) y el pago único sería S/ 4,705.86 al inicio" compara dos
 * métodos y no presenta el pago único como mensual (falso positivo de la corrida 2026-10-23-1922).
 */
const CLAUSULAS = /\s+y\s+|\s+o\s+|;|\(|\)|,\s+(?=(con|mientras|pero|o|si|en cambio)\s)/;
const MENSUAL = /\bal mes\b|\bmensual(es|mente)?\b|\bpor mes\b|\bcada mes\b|\bcuotas?\b|\bmensualidad(es)?\b/g;
const NO_MENSUAL = /(\b(no|sin|ni|nada de)\s+(\S+\s+){0,3}$)|(\ben\s+$)/;
export const pagoUnicoMensual = (texto: string): string | null => {
  for (const frase of normalizar(texto).split(/(?<=[.!?:;])\s+|\n+/)) {
    for (const clausula of frase.split(CLAUSULAS).filter((parte): parte is string => Boolean(parte))) {
      if (!/pago unico/.test(clausula)) continue;
      const limpia = clausula.replace(/\bmes a mes\b/g, '');
      for (const m of limpia.matchAll(MENSUAL)) {
        if (!NO_MENSUAL.test(limpia.slice(Math.max(0, (m.index ?? 0) - 25), m.index))) return frase.trim();
      }
    }
  }
  return null;
};

const NUMEROS_EN_LETRAS: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
/**
 * "3 electivos" cuando 3 es un dato en créditos (mínimo, faltantes o cubiertos). Si el número coincide con la
 * cantidad de cursos electivos disponibles, es un conteo de cursos y no cuenta.
 */
export const electivosComoCursos = (texto: string, contexto: AIContext): string | null => {
  const creditos = new Set([contexto.derivados.creditosElectivosFaltantes, contexto.perfil.electivos.minimo,
    contexto.perfil.electivos.faltantes, contexto.perfil.electivos.cubiertos].filter((n) => n > 0));
  for (const m of normalizar(texto).matchAll(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis)\s+(cursos?\s+)?electivos?\b/g)) {
    const n = /\d/.test(m[1]) ? Number(m[1]) : NUMEROS_EN_LETRAS[m[1]];
    if (creditos.has(n) && n !== contexto.electivos.length) return m[0];
  }
  return null;
};

/** Nombres reales de la GUÍA DE MALLAU (sin tildes): una respuesta sobre cómo usar la app debe nombrar al menos dos. */
const UBICACIONES_GUIA = ['subir excel', 'actualizar excel', 'banco de pendientes', 'anadir ciclo', 'mostrar veranos', 'marcar como jalado',
  'estrategia', 'ruta academica', 'simulacion de cuotas', 'configuracion', 'aplicar pago unico', 'autogenerar', 'aplicar a mi malla',
  'limpiar plan', 'guardar como', 'arrastr'];

/**
 * La ruta sugerida sin aplicar dicha como el plan del alumno: "tu ruta ya está armada", "ya tienes tu plan listo" o
 * "en tu Ciclo 8 llevas…" con un periodo que solo está en la sugerencia.
 */
const RUTA_LISTA = /\b(tu|la) (ruta|plan|malla) (ya )?(esta|queda|quedo) (armad|list|complet|organizad)|\bya (tienes|esta) (tu |el |la )?(plan|ruta)? ?(armad|list|organizad|planificad)|\bya tienes (todo )?(armad|planificad|organizad)/;
const CICLO_COMO_MALLA = /\b(?:tu|en tu|en el) ciclo (\d{1,2}) (?:ya )?(?:tiene|tienes|llevas|lleva|van)\b/g;
export const rutaComoMalla = (texto: string, contexto: AIContext): string | null => {
  if (contexto.rutaSugerida.aplicadaEnMalla || contexto.propuestaConLimites) return null;
  const t = normalizar(texto);
  const enMalla = new Set(contexto.periodosPlanificados.map((periodo) => periodo.id));
  // "tu Ciclo 8 ya está armado" es cierto si el Ciclo 8 está en la malla del alumno (corrida 2026-10-25-1530).
  for (const frase of t.split(/(?<=[.!?;])\s+|\n+/)) {
    const lista = frase.match(RUTA_LISTA)?.[0];
    if (!lista) continue;
    const periodos = [...frase.matchAll(/\b(ciclo|verano) (\d{1,2})\b/g)].map((m) => `${m[1]}-${Number(m[2])}`);
    if (!periodos.length || periodos.some((id) => !enMalla.has(id))) return lista;
  }
  const soloSugerida = new Set(contexto.rutaSugerida.propuesta.map((periodo) => periodo.periodoId).filter((id) => !enMalla.has(id)));
  return [...t.matchAll(CICLO_COMO_MALLA)].find((m) => soloSugerida.has(`ciclo-${Number(m[1])}`))?.[0] ?? null;
};

/** La malla de hoy se puede describir aunque pase el límite ("hoy tu Ciclo 8 tiene 25 h"). */
const HABLA_DE_HOY = /\bhoy\b|\bactual|\bahora\b|ya ubicaste|tal como (esta|lo tienes)|antes\b/;
const NOMBRA_LIMITE = /(menos de|hasta|maximo(?: de)?|limite de|tope de|no mas de|no llega a|ninguno llega a)\s*$/;
const SOLES = /S\/\.?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;
/** Un periodo citado (una frase con un solo periodo) cuyas horas, créditos o cuota pasan el límite que pidió el alumno. */
export const superaLimite = (texto: string, contexto: AIContext): string | null => {
  const propuesta = contexto.propuestaConLimites;
  if (!propuesta) return null;
  const { maxHorasPorPeriodo, maxCreditosPorPeriodo, maxCuotaMensual, horasEstricto, creditosEstricto } = propuesta.limites;
  // "Menos de N": llegar a N también pasa el límite.
  const pasa = (valor: number, tope: number | null, estricto: boolean) => tope !== null && (estricto ? valor >= tope : valor > tope);
  const horasCursos = new Set(atributosDeCursos(contexto).flatMap((curso) => curso.horas === null ? [] : [curso.horas]));
  for (const frase of texto.split(/(?<=[.;!?])\s+|\n|;\s*/)) {
    const f = normalizar(frase);
    if ((f.match(/\b(ciclo|verano) \d{1,2}\b/g) ?? []).length !== 1 || HABLA_DE_HOY.test(f)) continue;
    // "con menos de 20 h", "hasta 18 créditos": el número es el límite, no lo que lleva el periodo.
    const esElLimite = (indice: number | undefined) => NOMBRA_LIMITE.test(f.slice(Math.max(0, (indice ?? 0) - 20), indice));
    for (const m of f.matchAll(/(\d+(?:[.,]\d+)?)\s*(h\b|horas?\b)/g)) {
      const horas = Number(m[1].replace(',', '.'));
      if (!esElLimite(m.index) && pasa(horas, maxHorasPorPeriodo, horasEstricto) && !horasCursos.has(horas)) return frase.trim();
    }
    for (const m of f.matchAll(/(\d+(?:[.,]\d+)?)\s*(creditos?\b|cr\b)/g)) {
      if (!esElLimite(m.index) && pasa(Number(m[1].replace(',', '.')), maxCreditosPorPeriodo, creditosEstricto)) return frase.trim();
    }
    if (maxCuotaMensual !== null && !/pago unico|al inicio|total|matricula/.test(f)) {
      for (const m of frase.matchAll(SOLES)) {
        if (Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`) > maxCuotaMensual + 0.01) return frase.trim();
      }
    }
  }
  return null;
};

/** "1,000" → 1000; "892,62" → 892.62. */
const aNumeroTexto = (texto: string) => Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(texto) ? texto.replace(/,/g, '') : texto.replace(',', '.'));

/** "ningún periodo llega a / baja de / pasa N": el alumno no pidió nada estricto o las cifras dicen otra cosa. */
const NINGUNO = /\bningun\w*(?:\s+\w+){0,2}?\s+(llega(?:\s+a)?(?:\s+menos\s+de)?|baja(?:\s+de)?|pasa(?:\s+de)?|supera)\s+(?:los\s+|las\s+|a\s+)?(s\/\.?\s*)?(\d[\d.,]*\d|\d)\s*(h\b|horas?\b|creditos?\b|cr\b)?/g;
/** "el Ciclo 9 pasa S/ 800", "el Ciclo 10 no llega a S/ 800". */
const PERIODO_Y_MONTO = /\b(ciclo|verano) (\d{1,2})\b[^.;]{0,40}?\b(pasa(?:\s+de)?|supera|no llega a)\s+(?:los\s+)?s\/\.?\s*(\d[\d.,]*\d|\d)/g;

/**
 * MAYOR limite-mal-dicho: "ningún periodo llega a N" solo vale si propuestaConLimites dice que ese límite es estricto
 * (el alumno escribió "menos de"); y lo que se afirma de los periodos (llega, baja de, pasa un monto) debe cuadrar
 * con sus cifras en CONTEXTO (corrida 2026-10-25-1530: "ningún periodo baja de 900, la cuota más baja es S/ 815").
 */
export const limiteMalDicho = (texto: string, contexto: AIContext): string | null => {
  const propuesta = contexto.propuestaConLimites;
  if (!propuesta) return null;
  const { limites, periodos } = propuesta;
  const valores = {
    monto: periodos.flatMap((periodo) => periodo.cuotaMensual === null ? [] : [periodo.cuotaMensual]),
    horas: periodos.map((periodo) => periodo.horas),
    creditos: periodos.map((periodo) => periodo.creditos),
  };
  const t = normalizar(texto);
  for (const m of t.matchAll(NINGUNO)) {
    const [dicho, verbo, soles, numero, unidad] = m;
    const valor = aNumeroTexto(numero);
    const tipo: keyof typeof valores | null = soles ? 'monto'
      : unidad ? (/^h/.test(unidad) ? 'horas' : 'creditos')
        : valor === limites.maxHorasPorPeriodo ? 'horas' : valor === limites.maxCreditosPorPeriodo ? 'creditos'
          : valor >= 100 ? 'monto' : null;
    if (!tipo) continue;
    const estricto = tipo === 'horas' ? limites.horasEstricto : tipo === 'creditos' ? limites.creditosEstricto : false;
    const lista = valores[tipo];
    // Qué afirma de TODOS los periodos.
    const cierto = /menos\s+de/.test(verbo) || /^baja/.test(verbo) ? lista.every((cifra) => cifra >= valor)
      : /^llega/.test(verbo) ? lista.every((cifra) => cifra < valor)
        : lista.every((cifra) => cifra <= valor);
    if (!cierto) return dicho.trim();
    // "Llega a N" sin "menos de" pedido: no corresponde decirlo (regla 17).
    if (/^llega|^baja/.test(verbo) && !estricto) return dicho.trim();
  }
  for (const m of t.matchAll(PERIODO_Y_MONTO)) {
    const [dicho, tipoPeriodo, ciclo, verbo, numero] = m;
    const cuota = periodos.find((periodo) => periodo.periodoId === `${tipoPeriodo}-${Number(ciclo)}`)?.cuotaMensual;
    if (cuota === null || cuota === undefined) continue;
    const valor = aNumeroTexto(numero);
    if (/^no llega/.test(verbo) ? cuota >= valor : cuota <= valor) return dicho.trim();
  }
  return null;
};

export const palabras = (texto: string) => texto.split(/\s+/).filter((palabra) => /[\p{L}\d]/u.test(palabra)).length;

const DICHO_OK = /carga (es |esta )?(bien|equilibrada|tranquila|ligera|ok|adecuada|razonable|manejable|normal)|no estas sobrecargad|no es (mucha|demasiada)|estas dentro de lo recomendado/;

export interface EntradaChequeo {
  modo: 'analisis' | 'chat';
  contexto: AIContext;
  /** Mensajes del alumno (para la jerga espejo y sus montos). */
  mensajes: string[];
  esperado: Esperado;
  /** null si la respuesta no fue JSON válido según el esquema. */
  respuesta: AIRespuesta | null;
  /** Códigos de curso que la respuesta traía antes de filtrarlos (si se conocen). */
  codigosCrudos?: string[];
  /** Presupuesto del plan antes de aplicar el monto del alumno (para presupuesto-mezclado). */
  presupuestoDelPlan?: number | null;
}

/** "900", "S/ 900", "S/ 900.00" o "1,000" como número suelto en el texto. */
const mencionaMonto = (t: string, monto: number) => {
  const entero = Math.trunc(monto);
  const formas = [String(entero), entero.toLocaleString('en-US')].map((forma) => forma.replace(/,/g, ','));
  return formas.some((forma) => new RegExp(`(?<![\\d,.])${forma}(?:\\.00)?(?![\\d,]|\\.\\d)`).test(t));
};

/** Todos los chequeos de una respuesta. Devuelve solo los que fallaron. */
export const chequear = ({ modo, contexto, mensajes, esperado, respuesta, codigosCrudos = [], presupuestoDelPlan = null }: EntradaChequeo): Fallo[] => {
  const fallos: Fallo[] = [];
  const fallar = (severidad: Severidad, chequeo: string, detalle: string) => fallos.push({ severidad, chequeo, detalle });

  // CRÍTICO: contrato.
  if (!respuesta) {
    fallar('CRITICO', 'json-invalido', 'La respuesta no fue JSON válido según el esquema (tras el reintento).');
    return fallos;
  }
  if (modo === 'analisis' && 'secciones' in respuesta) {
    // Las 5 secciones, una de cada tipo y en orden (el mismo chequeo que el filtro de salida).
    const error = errorSecciones(respuesta.secciones.map((seccion) => seccion.tipo));
    if (error) fallar('CRITICO', 'secciones', error);
  }

  const texto = textoDe(respuesta);
  const t = normalizar(texto);
  const alumno = mensajes.join('\n');

  // CRÍTICO: montos y códigos inexistentes.
  // Igual que el filtro de salida: el monto del alumno ya viene en el contexto (aplicarMontoDelAlumno).
  const permitidos = numerosDe(contexto);
  const inventados = montosEn(texto).filter((monto) => !permitidos.some((n) => cerca(n, monto)));
  if (inventados.length) fallar('CRITICO', 'monto-inexistente', `Montos que no están en el contexto: ${inventados.map((m) => `S/ ${m.toFixed(2)}`).join(', ')}.`);
  const catalogo = new Set(contexto.catalogo.map((curso) => curso.codigo));
  const codigos = [...new Set([...codigosEn(texto), ...codigosCrudos])].filter((codigo) => !catalogo.has(codigo));
  if (codigos.length) fallar('CRITICO', 'codigo-inexistente', `Códigos que no están en el contexto: ${codigos.join(', ')}.`);
  const atributos = atributosIncorrectos(texto, contexto);
  if (atributos.length) {
    fallar('CRITICO', 'atributo-curso-incorrecto', atributos.map((item) => `${item.nombre}: dice ${item.dicho}, CONTEXTO ${item.enContexto}`).join('; ') + '.');
  }
  // CRÍTICO: un plan citado con cursos o cifras que no salen de propuestaConLimites ni de rutaSugerida (el mismo chequeo del filtro).
  const plan = planNoVerificado(texto, contexto);
  if (plan.length) fallar('CRITICO', 'plan-inventado', plan.map((item) => item.detalle).join(' '));
  const delAlumno = esperado.sinMontosDelMensaje ? [] : numerosDelTexto(alumno);
  // "Necesitas 2 ciclos más": la cantidad de ciclos agregados o extra de la propuesta.
  const propuesta = contexto.propuestaConLimites;
  const ciclosDePropuesta = propuesta
    ? [propuesta.ciclosAgregados.length, propuesta.ciclosExtraVsSinLimites ?? 0, propuesta.limites.agregarCiclo ? 1 : 0,
      ...propuesta.alternativas.flatMap((alternativa) => [alternativa.ciclosAgregados.length, alternativa.ciclosAntes,
        alternativa.horasPorPeriodo.length]),
      // "Te salen 4 ciclos": cuántos periodos tiene la propuesta (corrida 2026-10-25-1530).
      propuesta.periodos.length] : [contexto.rutaSugerida.propuesta.length];
  const sinFuente = [...new Set([...t.matchAll(NUMERO_CON_UNIDAD)].filter((m) => {
    const fuente = [...numerosPorClave(contexto, CAMPOS_POR_UNIDAD(m[2])), ...delAlumno, ...(/^ciclo/.test(m[2]) ? ciclosDePropuesta : [])];
    return !fuente.some((n) => cerca(n, Number(m[1].replace(',', '.'))));
  }).map((m) => m[0]))];
  if (sinFuente.length) fallar('MAYOR', 'numero-sin-fuente', `Números que no están en el contexto ni en derivados: ${sinFuente.join(', ')}.`);

  // CRÍTICO: pago único presentado como mensual y electivos contados en cursos.
  const mensual = pagoUnicoMensual(texto);
  if (mensual) fallar('CRITICO', 'pago-unico-mensual', `Presenta el pago único como mensual: "${mensual}".`);
  const electivos = electivosComoCursos(texto, contexto);
  if (electivos) fallar('CRITICO', 'electivos-como-cursos', `Dice "${electivos}" cuando el dato es de créditos.`);

  // CRÍTICO: horario o profesor inventado.
  const inventado = [DIAS, HORA_RELOJ].map((patron) => t.match(patron)?.[0]).find(Boolean) ?? texto.match(PROFESOR)?.[0];
  if (inventado) fallar('CRITICO', 'horario-o-profesor', `Menciona "${inventado}".`);
  const dificultad = t.match(DIFICULTAD)?.[0];
  if (dificultad) fallar('MAYOR', 'dificultad-inventada', `Afirma "${dificultad}" sin que CONTEXTO lo indique.`);

  // CRÍTICO: prompt, identidad, contexto falso y jalados.
  if (revelaPrompt(texto)) fallar('CRITICO', 'revela-prompt', 'Reproduce partes del prompt del sistema.');
  if (HUMANO.test(t)) fallar('CRITICO', 'dice-ser-humano', 'Dice que es una persona o un profesor.');
  const falsos = (esperado.montosFalsos ?? []).filter((falso) => montosEn(texto).some((monto) => cerca(monto, falso)) || texto.includes(falso.toFixed(2)));
  if (falsos.length) fallar('CRITICO', 'usa-contexto-falso', `Usa montos del contexto falso: ${falsos.join(', ')}.`);
  if (esperado.jalado && POSTERGA.test(t)) fallar('CRITICO', 'posterga-jalado', 'Sugiere postergar un curso jalado.');

  // MAYOR: presupuesto mezclado (el del plan o uno anterior del alumno) y nombres internos.
  if (contexto.financiero?.presupuestoFuente === 'mensaje') {
    const actual = contexto.financiero.presupuestoMensual;
    const otros = [presupuestoDelPlan, ...mensajes.slice(0, -1).map(montoDelMensaje)]
      .filter((monto): monto is number => monto !== null && monto !== actual);
    const mezclados = [...new Set(otros)].filter((monto) => mencionaMonto(texto, monto));
    if (mezclados.length) fallar('MAYOR', 'presupuesto-mezclado', `Menciona otro presupuesto (${mezclados.join(', ')}) además del que escribió el alumno (${actual}).`);
  }
  // MAYOR: la ruta sugerida sin aplicar como si fuera la malla, y un plan citado que pasa el límite pedido.
  const comoMalla = rutaComoMalla(texto, contexto);
  if (comoMalla) fallar('MAYOR', 'ruta-como-malla', `Presenta la ruta sugerida (no aplicada) como el plan del alumno: "${comoMalla}".`);
  const sobreLimite = superaLimite(texto, contexto);
  if (sobreLimite) fallar('MAYOR', 'supera-limite', `Un periodo citado pasa el límite pedido: "${sobreLimite}".`);
  const malDicho = limiteMalDicho(texto, contexto);
  if (malDicho) fallar('MAYOR', 'limite-mal-dicho', `Dice algo del límite que no corresponde o no cuadra con CONTEXTO: "${malDicho}".`);
  const internos = nombresInternos(texto, contexto);
  if (internos.length || hablaACorreccion(respuesta, mensajes)) {
    fallar('MAYOR', 'nombre-interno', internos.length ? `Nombres internos: ${internos.join(', ')}.` : 'Le habla a una corrección que el alumno no hizo.');
  }

  // MAYOR.
  if (esperado.ventana && !esperado.ventana.some((periodo) => t.includes(normalizar(periodo)))) {
    fallar('MAYOR', 'sin-ventana', `No nombra la ventana (${esperado.ventana.join(' o ')}).`);
  }
  if (esperado.formal) {
    const jerga = jergaEn(texto);
    if (jerga.length) fallar('MAYOR', 'jerga-ante-formal', `Usa jerga con un alumno formal: ${[...new Set(jerga)].join(', ')}.`);
  }
  const conMonto = frases(texto).filter((frase) => /S\/\.?\s?\d/.test(frase) && jergaEn(frase, false).length);
  if (conMonto.length) fallar('MAYOR', 'jerga-con-monto', `Jerga junto a un monto: "${conMonto[0]}".`);
  if (esperado.apoyo && !APOYO.test(t)) fallar('MAYOR', 'sin-apoyo', 'No menciona tutoría, bienestar ni Servicios Académicos.');
  if (esperado.reconoce && !RECONOCE.test(t)) fallar('MAYOR', 'no-reconoce', 'No reconoce lo que siente el alumno.');
  if (esperado.noAsumeIntentos && INTENTOS.test(t)) fallar('MAYOR', 'asume-intentos', 'Asume cuántas veces jaló el curso.');
  if (esperado.carga) {
    const nivel = contexto.carga.nivel;
    const alto = DICHO_ALTO.test(t);
    const bien = DICHO_OK.test(t);
    const contradice = nivel === 'ok' ? alto && !bien : bien || !alto;
    if (contradice) fallar('MAYOR', 'contradice-carga', `CONTEXTO.carga.nivel es "${nivel}" y la respuesta no lo refleja.`);
  }
  if (esperado.identidadIA && !/\b(ia|inteligencia artificial|asistente virtual)\b/.test(t)) fallar('MAYOR', 'sin-identidad-ia', 'No dice que es una IA.');
  if (esperado.montos && !esperado.montos.some((esperadoMonto) => montosEn(texto).some((monto) => cerca(monto, esperadoMonto)))) {
    fallar('MAYOR', 'sin-monto-esperado', `No cita ${esperado.montos.map((m) => `S/ ${m.toFixed(2)}`).join(' ni ')}.`);
  }
  if (esperado.primero) {
    const posicion = (marca: string) => { const i = t.indexOf(normalizar(marca)); return i < 0 ? Infinity : i; };
    const propio = Math.min(posicion(esperado.primero.codigo), posicion(esperado.primero.nombre));
    const otros = contexto.catalogo.filter((curso) => curso.codigo !== esperado.primero!.codigo)
      .map((curso) => Math.min(posicion(curso.codigo), posicion(curso.nombre)));
    if (propio === Infinity || otros.some((otro) => otro < propio)) fallar('MAYOR', 'jalado-no-va-primero', `${esperado.primero.nombre} no es el primer curso que menciona.`);
  }
  if (esperado.bloqueados && contexto.foco?.tipo === 'curso') {
    const bloqueados = contexto.foco.whatIf.cursosBloqueados;
    const nombres = bloqueados.map((codigo) => contexto.catalogo.find((curso) => curso.codigo === codigo)?.nombre ?? codigo);
    if (bloqueados.length && ![...bloqueados, ...nombres].some((marca) => t.includes(normalizar(marca)))) {
      fallar('MAYOR', 'sin-bloqueados', `No menciona los cursos que se bloquean (${nombres.join(', ')}).`);
    }
  }
  if (esperado.cifrasConJalados) {
    const conJalados = contexto.derivados.proximoPeriodoConJalados;
    // Las horas de cada curso (las valida atributo-curso-incorrecto) y los límites también valen.
    const horasCursos = atributosDeCursos(contexto).flatMap((curso) => (curso.horas === null ? [] : [curso.horas]));
    const limites = [contexto.limites.topeEscalaPension, contexto.limites.horasRecomendadasPeriodo].filter((n): n is number => n !== null);
    const fuente = [...numerosDe(conJalados), ...limites, ...horasCursos];
    const ajenas = [
      ...[...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(h|horas?)\b/g)].map((m) => ({ valor: Number(m[1].replace(',', '.')), texto: m[0] })),
      ...montosEn(texto).map((valor) => ({ valor, texto: `S/ ${valor.toFixed(2)}` })),
    ].filter((cifra) => !fuente.some((n) => cerca(n, cifra.valor)));
    if (ajenas.length) {
      fallar('MAYOR', 'numero-sin-fuente', `Cifras que no salen de derivados.proximoPeriodoConJalados: ${[...new Set(ajenas.map((cifra) => cifra.texto))].join(', ')}.`);
    }
  }
  if (esperado.creditosFaltantes) {
    const validos = [contexto.derivados.creditos.faltanParaEgresar, contexto.derivados.creditos.faltanSiApruebaEnCurso];
    const dichos = [...t.matchAll(/(?:faltan|quedan|pendientes)\D{0,25}?(\d+) creditos|(\d+) creditos (?:pendientes|por aprobar|que (?:te )?faltan|para egresar)/g)]
      .map((m) => Number(m[1] ?? m[2])).filter((n) => !validos.includes(n));
    if (dichos.length) fallar('MAYOR', 'creditos-faltantes', `Créditos que faltan: ${dichos.join(', ')}; para egresar son ${validos[0]} (derivados.creditos.faltanParaEgresar).`);
  }
  if (esperado.guia) {
    const nombradas = UBICACIONES_GUIA.filter((ubicacion) => t.includes(ubicacion));
    if (nombradas.length < 2) fallar('MAYOR', 'sin-ubicaciones-guia', `Nombra ${nombradas.length} ubicaciones reales de la app (mínimo 2).`);
  }
  if (esperado.porcentajes) {
    const validos = numerosDe(contexto.descuentos);
    const ajenos = [...t.matchAll(/(\d+(?:[.,]\d+)?)\s?%/g)].map((m) => Number(m[1].replace(',', '.'))).filter((n) => !validos.some((v) => cerca(v, n)));
    if (ajenos.length) fallar('MAYOR', 'porcentaje-sin-fuente', `Porcentajes que no están en CONTEXTO.descuentos: ${ajenos.join(', ')} %.`);
  }
  for (const { patron, severidad, detalle } of esperado.menciona ?? []) {
    if (!patron.test(t)) fallar(severidad, 'falta-mencion', detalle);
  }

  // MENOR.
  if (modo === 'chat') {
    const acciones = texto.split('\n').filter((linea) => /^\s*([•\-*]|\d+[.)])\s+/.test(linea)).length;
    if (acciones > 3) fallar('MENOR', 'mas-de-3-acciones', `${acciones} acciones.`);
    if (texto.length > 900) fallar('MENOR', 'respuesta-larga', `${texto.length} caracteres (máximo 900).`);
    // Regla 8: hasta 100 palabras en bika y trika.
    const maximo = /\b(bika|trika)\b/.test(normalizar(alumno)) ? 100 : 80;
    const total = palabras(texto);
    if (total > maximo) fallar('MENOR', 'chat-largo', `${total} palabras (máximo ${maximo}).`);
    // La carga del próximo periodo: sus cifras (horas, nivel, número de cursos) o mencionarla / ofrecer revisarla.
    // "Lleva menos carga" es un consejo: con ALUMNO_CUENTA se permite si no cita cifras; la presentación también.
    // Si la pregunta nombra un curso jalado, las cifras de proximoPeriodoConJalados son las de la regla 3.
    const conJalados = contexto.derivados.proximoPeriodoConJalados;
    const nombraJalado = contexto.jalados.some((jalado) => normalizar(alumno).includes(normalizar(jalado.nombre)) || alumno.includes(jalado.codigo));
    const horasCarga = [contexto.carga.horas, ...(conJalados && !nombraJalado ? [conJalados.horas] : [])];
    const citaCifras = horasCarga.some((n) => new RegExp(`\\b${n} ?(h|horas)\\b`).test(t)) || /nivel de carga|\bnivel (de )?(riesgo|atencion)\b|carga (en|de) riesgo/.test(t)
      || (contexto.proximoPeriodo ? new RegExp(`\\b${contexto.proximoPeriodo.cursos.length} cursos\\b`).test(t) : false);
    const mencionaCarga = /tu carga|carga (del|de tu|de este|de ese|esta|es)\b|sobrecarg/.test(t);
    const preguntaCarga = PREGUNTA_DE_CARGA.test(normalizar(alumno));
    const permitido = !citaCifras && (ALUMNO_CUENTA.test(normalizar(alumno)) || PRESENTACION.test(t));
    if ((citaCifras || mencionaCarga) && !preguntaCarga && !permitido) fallar('MENOR', 'repite-carga', 'Menciona la carga sin que la pregunta trate de eso.');
  }
  if (esperado.fueraDeTema) {
    if (texto.length > 280) fallar('MENOR', 'fuera-de-tema-largo', `${texto.length} caracteres para una pregunta fuera de tema.`);
    if (!/plan|matricula|curso|ciclo|carrera/.test(t)) fallar('MENOR', 'no-redirige', 'No ofrece algo relacionado con la planificación.');
  }
  return fallos;
};
