import { z } from 'zod';

/**
 * Contratos del asistente IA, compartidos entre el frontend y el proxy
 * (ai-proxy/src/contracts.ts es una copia exacta; un test falla si difieren).
 * Este archivo solo puede importar zod para que la copia compile en ambos lados.
 *
 * Toda cifra y toda decisión lógica viaja ya calculada en AIContext; la IA
 * solo redacta. Las respuestas se validan aquí y luego se filtran los códigos
 * de curso que no existan en el contexto.
 */

export const MAX_MENSAJES = 8;
export const MAX_TEXTO_MENSAJE = 1000;
export const MAX_ACCIONES = 3;
export const MAX_PREGUNTAS = 3;

export const NivelSchema = z.enum(['ok', 'atencion', 'riesgo']);
export type Nivel = z.infer<typeof NivelSchema>;

const PeriodoIdSchema = z.string().regex(/^(ciclo|verano)-\d+$/);
const monto = z.number().finite();

// ==========================================
// Contexto (lo calcula buildAIContext)
// ==========================================

const CursoCatalogoSchema = z.object({
  codigo: z.string(),
  nombre: z.string(),
  estado: z.enum(['APROBADO', 'CONVALIDADO', 'EN_CURSO', 'PENDIENTE']),
  tipo: z.enum(['OBLIGATORIO', 'ELECTIVO']),
  creditos: z.number(),
  /** "banco" o el id del periodo donde está ubicado. */
  ubicacion: z.string(),
});

const CursoPlanificadoSchema = z.object({
  codigo: z.string(),
  nombre: z.string(),
  creditos: z.number(),
  horas: z.number(),
  tipo: z.enum(['OBLIGATORIO', 'ELECTIVO']),
  /** Cursos pendientes que dependen de este, directa o indirectamente. */
  impacto: z.number().int(),
  /** Largo de la cadena de prerrequisitos que empieza en este curso. */
  longitudCadena: z.number().int(),
  esLaboratorio: z.boolean(),
  jalado: z.boolean(),
});

const EscenarioPeriodoSchema = z.object({
  id: z.enum(['sin_descuento', 'interbank_scotiabank', 'bcp_bbva', 'pago_unico']),
  nombre: z.string(),
  matricula: monto,
  numeroCuotas: z.number().int(),
  /** Cuota mensual; null en pago único (se pagan todas las pensiones juntas al inicio: no hay cuota mensual). */
  cuotaMensual: monto.nullable(),
  total: monto,
  /** presupuestoMensual - cuotaMensual (negativo = no alcanza); null sin presupuesto y en pago único. */
  diferenciaPresupuesto: monto.nullable(),
});

const EscenarioPlanSchema = z.object({
  id: EscenarioPeriodoSchema.shape.id,
  nombre: z.string(),
  total: monto,
});

const CargaSchema = z.object({
  nivel: NivelSchema,
  puntos: z.number().int(),
  horas: z.number(),
  topeEscala: z.number().nullable(),
  limiteRecomendado: z.number(),
  cursos4HorasOMas: z.number().int(),
  laboratorios: z.number().int(),
  cadenasLargas: z.number().int(),
  motivos: z.array(z.string()),
});

const PeriodoResumenSchema = z.object({
  id: PeriodoIdSchema,
  etiqueta: z.string(),
  cursos: z.array(z.string()),
  horas: z.number(),
  creditos: z.number(),
});

/** Pago único: todas las pensiones juntas al inicio, con descuento. */
const PagoUnicoSchema = z.object({
  /** Pensión total del ciclo con el descuento, pagada al inicio. */
  pensionAlInicio: monto,
  matricula: monto,
  totalCiclo: monto,
  /** Total sin descuento - total con pago único. */
  ahorroVsSinDescuento: monto,
  /** Comparación referencial: presupuestoMensual × número de cuotas - pensionAlInicio; null sin presupuesto. */
  diferenciaVsPresupuestoDelCiclo: monto.nullable(),
  comparacion: z.literal('comparación referencial').nullable(),
});

/**
 * Restas y totales que la IA no debe hacer (D-001): todo lo que puede necesitar para responder
 * "cuánto me falta" o "cuánto me paso" ya viene calculado aquí.
 */
const DerivadosSchema = z.object({
  /** Horas del próximo periodo frente al tope de la escala y a las 24 h recomendadas (0 si no se pasa). */
  horas: z.object({
    proximoPeriodo: z.number(),
    topeEscala: z.number().nullable(),
    sobreTopeEscala: z.number(),
    margenTopeEscala: z.number(),
    recomendadas: z.number(),
    sobreRecomendadas: z.number(),
    margenRecomendadas: z.number(),
  }),
  /** Cada escenario mensual del próximo periodo contra el presupuesto (sin pago único); null sin presupuesto. */
  presupuesto: z.array(z.object({
    id: z.enum(['sin_descuento', 'interbank_scotiabank', 'bcp_bbva', 'pago_unico']),
    alcanza: z.boolean(),
    /** presupuesto - cuotaMensual (negativo = no alcanza). */
    diferenciaMes: monto,
    /** Lo que falta (> 0 si no alcanza) o sobra cada mes, en positivo. */
    faltaPorMes: monto,
    sobraPorMes: monto,
    /** diferenciaMes × numeroCuotas: las cuotas del ciclo (la matrícula se paga aparte). */
    diferenciaCiclo: monto,
    faltaPorCiclo: monto,
    sobraPorCiclo: monto,
  })).nullable(),
  /**
   * Pago único del próximo periodo: todas las pensiones juntas al inicio, con descuento. No tiene cuota mensual.
   * null si no hay próximo periodo o tarifario.
   */
  pagoUnico: PagoUnicoSchema.nullable(),
  /** Horas del próximo periodo si se quita cada curso, y si así quedaría dentro del tope de la escala (null sin tope). */
  horasSinCadaCurso: z.array(z.object({
    codigo: z.string(),
    nombre: z.string(),
    horasSinElCurso: z.number(),
    quedaBajoTopeEscala: z.boolean().nullable(),
  })),
  /**
   * El próximo periodo con los jalados que están fuera de su ventana y deben ir en él (D-001): horas, créditos,
   * topes y costos calculados con el mismo motor financiero. null si no hay jalados que agregar al próximo periodo.
   */
  proximoPeriodoConJalados: z.object({
    periodoId: PeriodoIdSchema,
    /** Jalados agregados al periodo. */
    jalados: z.array(z.string()),
    horas: z.number(),
    creditos: z.number(),
    /** null sin escala de pensión. */
    superaTopeEscala: z.boolean().nullable(),
    horasSobreTopeEscala: z.number(),
    superaRecomendadas: z.boolean(),
    horasSobreRecomendadas: z.number(),
    /** Escenarios mensuales (sin pago único): cuota y total con los jalados incluidos. */
    escenarios: z.array(z.object({
      id: z.enum(['sin_descuento', 'interbank_scotiabank', 'bcp_bbva']),
      nombre: z.string(),
      cuotaMensual: monto,
      total: monto,
      /** presupuesto - cuotaMensual; null sin presupuesto. */
      diferenciaMes: monto.nullable(),
    })),
    /** Mismo bloque que derivados.pagoUnico, con los jalados incluidos. */
    pagoUnico: PagoUnicoSchema.nullable(),
  }).nullable(),
  /** Cursos del próximo periodo que quedan bloqueados hasta que se agregue el jalado (planificadosSinJalado). */
  planificadosBloqueadosPorJalado: z.array(z.object({ codigo: z.string(), nombre: z.string() })),
  /** Créditos de electivos que faltan aprobar para el mínimo (los electivos se cuentan en créditos, no en cursos). */
  creditosElectivosFaltantes: z.number(),
  creditos: z.object({
    /** Suma de los créditos de todos los cursos de la malla (incluye todos los electivos ofrecidos). */
    totalMalla: z.number(),
    obligatorios: z.number(),
    /** Créditos electivos mínimos (academic.json, creditosMinimosElectivos). */
    electivosMinimos: z.number(),
    /** obligatorios + electivosMinimos. */
    paraEgresar: z.number(),
    /** Aprobados o convalidados que cuentan: obligatorios + electivos hasta el mínimo. */
    aprobadosQueCuentan: z.number(),
    enCurso: z.number(),
    /** paraEgresar - aprobadosQueCuentan (incluye lo que está en curso). */
    faltanParaEgresar: z.number(),
    /** faltanParaEgresar - créditos obligatorios en curso: lo que faltaría si aprueba todo lo que lleva. */
    faltanSiApruebaEnCurso: z.number(),
    ciclosRestantes: z.number().int(),
  }),
  /** Cursos del próximo periodo: si se puede mover sin dejar inválidos otros cursos planificados. */
  cursosProximoPeriodo: z.array(z.object({
    codigo: z.string(),
    nombre: z.string(),
    creditos: z.number(),
    horas: z.number(),
    estado: z.enum(['APROBADO', 'CONVALIDADO', 'EN_CURSO', 'PENDIENTE']),
    jalado: z.boolean(),
    sePuedeMover: z.boolean(),
    /** Cursos planificados que quedarían sin su prerrequisito si se mueve. */
    bloquearia: z.array(z.string()),
  })),
});

/**
 * Propuesta del planificador con los límites que el alumno pidió en su mensaje (horas, créditos, presupuesto,
 * un ciclo más o veranos). La arma el código (D-001); la IA solo la explica y el alumno la aplica con
 * "Aplicar a mi malla". null si el mensaje no pide límites.
 */
const PropuestaConLimitesSchema = z.object({
  limites: z.object({
    maxHorasPorPeriodo: z.number().nullable(),
    maxCreditosPorPeriodo: z.number().nullable(),
    /** "Menos de N": ningún periodo llega a N horas (o créditos). "Máximo / hasta / no más de N" permite N. */
    horasEstricto: z.boolean(),
    creditosEstricto: z.boolean(),
    /** Presupuesto mensual que pidió el alumno; se traduce en horas con la escala del tarifario. */
    maxCuotaMensual: monto.nullable(),
    metodoPago: z.string().nullable(),
    /** Horas por ciclo cuya cuota mensual no pasa maxCuotaMensual (null sin presupuesto). */
    horasPorCuota: z.number().nullable(),
    /** Horas máximas por ciclo con las que se armó (el menor de los límites; 22 si no pidió horas). */
    horasAplicadas: z.number(),
    creditosAplicados: z.number().nullable(),
    usarVeranos: z.boolean(),
    /** Pidió un ciclo más: la propuesta reparte la carga en un ciclo más que sin límites, con las horas mínimas. */
    agregarCiclo: z.boolean(),
    alcance: z.enum(['proximoPeriodo', 'hastaEgresar']),
  }),
  periodos: z.array(z.object({
    periodoId: PeriodoIdSchema,
    etiqueta: z.string(),
    cursos: z.array(z.string()),
    numeroCursos: z.number().int(),
    horas: z.number(),
    creditos: z.number(),
    /** Cuota mensual con el método de pago elegido (en verano, sin descuento); null sin tarifario. */
    cuotaMensual: monto.nullable(),
    /** Pago único: la pensión del ciclo, toda al inicio; null en verano o sin tarifario. */
    pagoUnicoAlInicio: monto.nullable(),
  })),
  /** Ciclos que hay que agregar después del último de la malla (11, 12…). */
  ciclosAgregados: z.array(z.number().int()),
  veranosUsados: z.array(PeriodoIdSchema),
  cicloEgreso: z.number().int().nullable(),
  /** Ciclos más que la ruta sin límites (22 h, sin veranos); null si solo se arma el próximo periodo. */
  ciclosExtraVsSinLimites: z.number().int().nullable(),
  noEntraron: z.array(z.object({ codigo: z.string(), motivo: z.string() })),
  /** Total de todos los periodos de la propuesta con su método de pago (el motor financiero); null sin tarifario. */
  costoTotalHastaEgresar: monto.nullable(),
  /**
   * Alternativas del mismo planificador que egresan antes o cuestan menos en total que la propuesta: otro método de
   * pago con el mismo presupuesto, usar veranos, o las horas mínimas para no agregar un ciclo (puede tener recargo).
   */
  alternativas: z.array(z.object({
    tipo: z.enum(['metodoPago', 'veranos', 'metodoPagoYVeranos', 'topeSinCicloExtra']),
    /** Qué cambia, para decírselo al alumno ("Con Interbank / Scotiabank — pronto pago y el Verano 8"). */
    descripcion: z.string(),
    metodoPago: z.string().nullable(),
    usarVeranos: z.boolean(),
    maxHorasPorPeriodo: z.number().nullable(),
    cicloEgreso: z.number().int().nullable(),
    horasPorPeriodo: z.array(z.object({ periodoId: PeriodoIdSchema, horas: z.number() })),
    ciclosAgregados: z.array(z.number().int()),
    veranosUsados: z.array(PeriodoIdSchema),
    costoTotalHastaEgresar: monto.nullable(),
    /** costoTotalHastaEgresar de la propuesta − el de esta alternativa (positivo = cuesta menos); null sin costos. */
    ahorroVsPropuesta: monto.nullable(),
    /** Ciclos antes que egresa que la propuesta (0 si egresa en el mismo). */
    ciclosAntes: z.number().int(),
    conRecargo: z.boolean(),
  })),
  /** Nunca está en la malla: el alumno la aplica con el botón "Aplicar a mi malla". */
  aplicadaEnMalla: z.literal(false),
});

const WhatIfSchema = z.object({
  codigo: z.string(),
  origen: z.enum(['EN_CURSO', 'PROXIMO_PERIODO']),
  cursosBloqueados: z.array(z.string()),
  planificadosInvalidos: z.array(z.object({ codigo: z.string(), periodoId: PeriodoIdSchema })),
  /** Ventana de recuperación si se jalara: periodos donde tendría que llevarse (vacía si no está ubicado). */
  ventanaSiJala: z.array(PeriodoIdSchema),
});

const FocoCursoSchema = z.object({
  tipo: z.literal('curso'),
  codigo: z.string(),
  nombre: z.string(),
  estado: CursoCatalogoSchema.shape.estado,
  tipoCurso: CursoCatalogoSchema.shape.tipo,
  creditos: z.number(),
  horas: z.number(),
  ubicacion: z.string(),
  esLaboratorio: z.boolean(),
  jalado: z.boolean(),
  impacto: z.number().int(),
  longitudCadena: z.number().int(),
  prerrequisitos: z.array(z.object({ codigo: z.string(), nombre: z.string(), estado: z.string() })),
  habilitaA: z.array(z.string()),
  whatIf: WhatIfSchema.omit({ origen: true }),
  ventanaRecuperacion: z.array(PeriodoIdSchema),
  area: z.string().nullable(),
});

const FocoCicloSchema = z.object({
  tipo: z.literal('ciclo'),
  periodo: PeriodoResumenSchema,
  cursos: z.array(CursoPlanificadoSchema),
  carga: CargaSchema,
  escenarios: z.array(EscenarioPeriodoSchema),
  jaladosEnVentana: z.array(z.string()),
});

export const AIContextSchema = z.object({
  version: z.literal(1),
  perfil: z.object({
    periodoIngreso: z.enum(['marzo', 'agosto']).nullable(),
    cicloActual: z.number().int().nullable(),
    totalCiclos: z.number().int(),
    disciplina: z.string(),
    /** pendientesEnMalla: todos los cursos pendientes, incluidos todos los electivos ofrecidos (no es lo que falta para egresar). */
    creditos: z.object({ aprobados: z.number(), enCurso: z.number(), pendientesEnMalla: z.number() }),
    electivos: z.object({ cubiertos: z.number(), minimo: z.number(), faltantes: z.number() }),
  }),
  catalogo: z.array(CursoCatalogoSchema),
  periodosPlanificados: z.array(PeriodoResumenSchema),
  proximoPeriodo: z.object({
    id: PeriodoIdSchema,
    etiqueta: z.string(),
    cursos: z.array(CursoPlanificadoSchema),
    totalHoras: z.number(),
    totalCreditos: z.number(),
    horasExceso: z.number(),
  }).nullable(),
  jalados: z.array(z.object({
    codigo: z.string(),
    nombre: z.string(),
    ventana: z.array(PeriodoIdSchema),
    ubicacionActual: z.string(),
    enVentana: z.boolean(),
  })),
  financiero: z.object({
    moneda: z.string(),
    referencia: z.string(),
    metodoPagoElegido: z.object({ id: z.string(), nombre: z.string() }),
    costoHoraAdicional: monto.nullable(),
    presupuestoMensual: monto.nullable(),
    /** "plan": el presupuesto del alumno en MallaU; "mensaje": el monto que escribió en su último mensaje. */
    presupuestoFuente: z.enum(['plan', 'mensaje']).nullable(),
    proximoPeriodo: z.array(EscenarioPeriodoSchema),
    planCompleto: z.array(EscenarioPlanSchema),
  }).nullable(),
  carga: CargaSchema,
  whatIf: z.array(WhatIfSchema),
  /**
   * Ruta que SUGIERE el planificador hasta egresar (sin límites del alumno). No es la malla del alumno salvo que
   * aplicadaEnMalla sea true: si es false, es una propuesta que puede aplicar con Autogenerar.
   */
  rutaSugerida: z.object({
    /** Cada periodo de la ruta: sus cursos, horas efectivas y créditos. */
    propuesta: z.array(z.object({ periodoId: PeriodoIdSchema, cursos: z.array(z.string()), horas: z.number(), creditos: z.number() })),
    ciclosRestantes: z.number().int(),
    cicloFinal: z.number().int().nullable(),
    noPlanificados: z.array(z.string()),
    /** true si la malla del alumno ya tiene exactamente esta ruta (cada pendiente en el mismo periodo o en el banco). */
    aplicadaEnMalla: z.boolean(),
  }),
  electivos: z.array(z.object({
    codigo: z.string(),
    nombre: z.string(),
    creditos: z.number(),
    horas: z.number(),
    area: z.string().nullable(),
    areaConfirmada: z.boolean(),
    ubicacion: z.string(),
  })),
  limites: z.object({
    creditosMinimos: z.number(),
    creditosMaximos: z.number(),
    horasRecomendadasPeriodo: z.number(),
    horasMaximasPlanificacion: z.number(),
    creditosMaximosVerano: z.number(),
    creditosMinimosElectivos: z.number(),
    factorHorasVerano: z.number(),
    topeEscalaPension: z.number().nullable(),
  }),
  foco: z.discriminatedUnion('tipo', [z.object({ tipo: z.literal('plan') }), FocoCicloSchema, FocoCursoSchema]).nullable(),
  derivados: DerivadosSchema,
  propuestaConLimites: PropuestaConLimitesSchema.nullable(),
  /** Descuentos y formas de pago del tarifario, para explicarlos sin inventar porcentajes; null sin tarifario. */
  descuentos: z.object({
    /** Pronto pago por banco: porcentaje sobre cada cuota mensual de un ciclo regular. */
    metodosPago: z.array(z.object({
      id: z.string(),
      nombre: z.string(),
      descuentoPorcentaje: z.number(),
      requiereProntoPago: z.boolean(),
    })),
    /** Pago único: todas las pensiones del ciclo juntas, al inicio, con este descuento. Solo en ciclos regulares. */
    pagoUnico: z.object({
      descuentoPorcentaje: z.number(),
      seCobra: z.literal('todo junto al inicio del ciclo'),
      soloCiclosRegulares: z.literal(true),
    }),
    /** Costo de cada hora sobre el tope de la escala (horasSinRecargo), por cuota. */
    costoHoraAdicional: monto.nullable(),
    horasSinRecargo: z.number().nullable(),
    /** Cómo calcula hoy MallaU: el descuento se aplica sobre la cuota con el recargo incluido (por confirmar con la UTP). */
    descuentoSobreRecargo: z.boolean(),
    /** En verano no hay pronto pago ni pago único. */
    veranoConDescuento: z.literal(false),
    /** Dónde lo ve el alumno en la app. */
    ubicacionEnApp: z.string(),
  }).nullable(),
});
export type AIContext = z.infer<typeof AIContextSchema>;
export type AIPropuestaConLimites = z.infer<typeof PropuestaConLimitesSchema>;
export type AIDerivados = z.infer<typeof DerivadosSchema>;
export type AICursoPlanificado = z.infer<typeof CursoPlanificadoSchema>;
export type AIEscenarioPeriodo = z.infer<typeof EscenarioPeriodoSchema>;
export type AICarga = z.infer<typeof CargaSchema>;
export type AIWhatIf = z.infer<typeof WhatIfSchema>;
export type AIFocoContexto = NonNullable<AIContext['foco']>;

// ==========================================
// Petición
// ==========================================

export const AIFocoSchema = z.object({
  tipo: z.enum(['plan', 'ciclo', 'curso']),
  id: z.string().max(40).optional(),
});
export type AIFoco = z.infer<typeof AIFocoSchema>;

export const AIMensajeSchema = z.object({
  rol: z.enum(['user', 'assistant']),
  texto: z.string().max(MAX_TEXTO_MENSAJE),
});
export type AIMensaje = z.infer<typeof AIMensajeSchema>;

export const AIRequestSchema = z.object({
  modo: z.enum(['analisis', 'chat']),
  contexto: AIContextSchema,
  foco: AIFocoSchema.optional(),
  mensajes: z.array(AIMensajeSchema).max(MAX_MENSAJES),
});
export type AIRequest = z.infer<typeof AIRequestSchema>;

// ==========================================
// Respuestas (lo que devuelve la IA)
// ==========================================

/** Las 5 secciones del análisis, en el orden obligatorio. */
export const TIPOS_SECCION = ['carga', 'financiero', 'ruta', 'whatIf', 'electivos'] as const;

export const AISeccionSchema = z.object({
  tipo: z.enum(TIPOS_SECCION),
  nivel: NivelSchema,
  titulo: z.string(),
  detalle: z.string(),
  acciones: z.array(z.string()).max(MAX_ACCIONES),
  cursos: z.array(z.string()),
});
export type AISeccion = z.infer<typeof AISeccionSchema>;

const seccionDe = <T extends typeof TIPOS_SECCION[number]>(tipo: T) => AISeccionSchema.extend({ tipo: z.literal(tipo) });

/** Contrato del análisis: exactamente 5 secciones, una de cada tipo, en el orden de TIPOS_SECCION. */
export const AIAnalisisResponseSchema = z.object({
  resumen: z.string(),
  secciones: z.tuple([seccionDe('carga'), seccionDe('financiero'), seccionDe('ruta'), seccionDe('whatIf'), seccionDe('electivos')]),
  preguntasSugeridas: z.array(z.string()).max(MAX_PREGUNTAS),
});

/**
 * La misma forma con las secciones en cualquier cantidad u orden. Solo la usa el proxy al leer la respuesta del
 * modelo, para que el filtro de salida pida corregir las secciones con el error concreto.
 */
export const AIAnalisisLibreSchema = AIAnalisisResponseSchema.extend({ secciones: z.array(AISeccionSchema) });
export type AIAnalisisResponse = z.infer<typeof AIAnalisisLibreSchema>;

export const AIChatResponseSchema = z.object({
  texto: z.string(),
  cursos: z.array(z.string()),
  preguntasSugeridas: z.array(z.string()).max(MAX_PREGUNTAS),
});
export type AIChatResponse = z.infer<typeof AIChatResponseSchema>;

export type AIRespuesta = AIAnalisisResponse | AIChatResponse;

// ==========================================
// Errores
// ==========================================

export const CODIGOS_ERROR = [
  'SIN_SALDO', 'LIMITE', 'PROVEEDOR_CAIDO', 'ENTRADA_INVALIDA', 'RESPUESTA_INVALIDA', 'SIN_CONEXION', 'PAUSADO',
  'RESPUESTA_LARGA', 'RESPUESTA_NO_VERIFICADA',
] as const;
export const AIErrorCodigoSchema = z.enum(CODIGOS_ERROR);
export type AIErrorCodigo = z.infer<typeof AIErrorCodigoSchema>;

export const MENSAJE_LIMITE = 'Llegaste al límite de consultas por ahora. Intenta de nuevo en un rato.';
/** Límite global del día (todos los alumnos): mensaje distinto del límite por dispositivo o por red. */
export const MENSAJE_LIMITE_DIARIO = 'El asistente llegó a su límite de hoy. Vuelve a intentarlo mañana.';

/**
 * ID anónimo por dispositivo (D-050): un UUID que genera el navegador, sin datos personales. El proxy solo guarda
 * su hash con AI_SALT y rechaza un valor que no tenga formato UUID.
 */
export const CABECERA_DISPOSITIVO = 'X-MallaU-Dispositivo';
export const FORMATO_ID_DISPOSITIVO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Respuesta segura fija cuando el filtro de salida del proxy no pudo verificar los datos. */
export const MENSAJE_NO_VERIFICADA = 'No pude verificar esos datos con seguridad. Revisa la pestaña Simulación de cuotas o pregúntame de otra forma.';

/** `reintentarEn` (ISO) llega con LIMITE cuando el tope es del proxy: inicio de la ventana siguiente. */
export const AIErrorResponseSchema = z.object({
  error: AIErrorCodigoSchema,
  mensaje: z.string().max(200).optional(),
  reintentarEn: z.iso.datetime().optional(),
});
export type AIErrorResponse = z.infer<typeof AIErrorResponseSchema>;

/** Esquema JSON (para el prompt) de la respuesta de cada modo. */
export const esquemaRespuesta = (modo: AIRequest['modo']) =>
  z.toJSONSchema(modo === 'analisis' ? AIAnalisisResponseSchema : AIChatResponseSchema);

// ==========================================
// Post-validación
// ==========================================

export const codigosDelContexto = (contexto: AIContext): Set<string> =>
  new Set(contexto.catalogo.map((curso) => curso.codigo));

const filtrar = (codigos: string[], validos: Set<string>) => [...new Set(codigos.filter((codigo) => validos.has(codigo)))];

/** "Faltan las secciones whatIf.", etc.; null si son exactamente las 5, una de cada tipo, en orden. */
export const errorSecciones = (tipos: string[]): string | null => {
  if (tipos.length === TIPOS_SECCION.length && tipos.every((tipo, indice) => tipo === TIPOS_SECCION[indice])) return null;
  const faltan = TIPOS_SECCION.filter((tipo) => !tipos.includes(tipo));
  const sobran = tipos.filter((tipo, indice) => tipos.indexOf(tipo) !== indice || !(TIPOS_SECCION as readonly string[]).includes(tipo));
  const partes = [
    ...(faltan.length ? [`Faltan las secciones ${faltan.join(', ')}.`] : []),
    ...(sobran.length ? [`Sobran las secciones ${[...new Set(sobran)].join(', ')}.`] : []),
    ...(!faltan.length && !sobran.length ? ['Las secciones no están en el orden pedido.'] : []),
  ];
  return `${partes.join(' ')} Incluye exactamente 5 secciones, en este orden: ${TIPOS_SECCION.join(', ')}.`;
};

/**
 * Valida la respuesta del modo y descarta los códigos de curso que no existan en el contexto.
 * `seccionesLibres` (solo el proxy) acepta un análisis con otras secciones para que el filtro lo corrija.
 */
export function parsearRespuesta(modo: 'analisis', datos: unknown, contexto: AIContext, seccionesLibres?: boolean): AIAnalisisResponse;
export function parsearRespuesta(modo: 'chat', datos: unknown, contexto: AIContext, seccionesLibres?: boolean): AIChatResponse;
export function parsearRespuesta(modo: AIRequest['modo'], datos: unknown, contexto: AIContext, seccionesLibres?: boolean): AIRespuesta;
export function parsearRespuesta(modo: AIRequest['modo'], datos: unknown, contexto: AIContext, seccionesLibres = false): AIRespuesta {
  const validos = codigosDelContexto(contexto);
  if (modo === 'analisis') {
    const respuesta: AIAnalisisResponse = (seccionesLibres ? AIAnalisisLibreSchema : AIAnalisisResponseSchema).parse(datos);
    return {
      ...respuesta,
      secciones: respuesta.secciones.map((seccion) => ({ ...seccion, cursos: filtrar(seccion.cursos, validos) })),
    };
  }
  const respuesta = AIChatResponseSchema.parse(datos);
  return { ...respuesta, cursos: filtrar(respuesta.cursos, validos) };
}
