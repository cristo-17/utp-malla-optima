import type { PropuestaPlan } from '../../application/usecases/generateOptimalPlanUseCase';
import type { PeriodoPropuesto } from '../../domain/services/automaticPlanningService';
import { nombrePeriodoCorto } from '../../domain/rules/jaladoRules';
import { pluralizar } from '../../utils/pluralizar';

const soles = (monto: number) => `S/ ${monto.toFixed(2)}`;

/** Avisos de la vista previa de Autogenerar: ciclos o veranos extra, lo que paga la cuota y lo que no entró. */
export const avisosPropuesta = (
  propuesta: PropuestaPlan, contexto: { usarVeranos?: boolean; tieneIngreso: boolean; nombreMetodo?: string }
): string[] => {
  const avisos: string[] = [];
  const { ciclosAgregados, veranosUsados, comparacionSinLimites, limitesPedidos } = propuesta;
  if (ciclosAgregados.length) {
    avisos.push(`Necesitas ${pluralizar(ciclosAgregados.length, '1 ciclo más', `${ciclosAgregados.length} ciclos más`)} (${ciclosAgregados.map((ciclo) => `Ciclo ${ciclo}`).join(', ')}).`);
  }
  for (const id of veranosUsados) {
    const periodo = propuesta.periodos.find((item) => item.periodo.id === id)?.periodo;
    if (periodo) avisos.push(`Se usa el ${nombrePeriodoCorto(periodo)}.`);
  }
  if (comparacionSinLimites && comparacionSinLimites.ciclosExtra > 0) {
    avisos.push(`Con estos límites terminas ${pluralizar(comparacionSinLimites.ciclosExtra, '1 ciclo', `${comparacionSinLimites.ciclosExtra} ciclos`)} después que sin límites.`);
  }
  if (limitesPedidos.maxCuotaMensual !== null && limitesPedidos.horasPorCuota !== null) {
    avisos.push(limitesPedidos.horasPorCuota === 0
      ? `Con ${soles(limitesPedidos.maxCuotaMensual)} al mes no alcanza para ninguna hora de la escala.`
      : `Con ${soles(limitesPedidos.maxCuotaMensual)} al mes${contexto.nombreMetodo ? ` (${contexto.nombreMetodo})` : ''} pagas hasta ${limitesPedidos.horasPorCuota} h por ciclo.`);
  }
  if (contexto.usarVeranos && !contexto.tieneIngreso) avisos.push('Configura tu mes de ingreso para poder usar veranos.');
  // Lo que el alumno ya ubicó se conserva aunque pase su límite: se avisa cómo reordenarlo.
  const { limites } = propuesta;
  for (const { periodo, horas, creditos, cursos } of periodosVistaPrevia(propuesta)) {
    const verano = periodo.tipo === 'VERANO';
    const tope = verano ? limites.horasVerano : limites.horas;
    const topeCreditos = verano ? limites.creditosVerano : limites.creditos;
    const pasa = horas > tope ? `${horas} h` : topeCreditos !== null && creditos > topeCreditos ? `${creditos} cr` : null;
    if (pasa && cursos.some((curso) => curso.conservado && !curso.jalado)) {
      avisos.push(`El ${nombrePeriodoCorto(periodo)} que ya ubicaste pasa tu límite (${pasa}): desmarca «Conservar lo que ya ubiqué» para reordenarlo.`);
    }
  }
  return avisos;
};

/** Periodos de la vista previa: con alcance "proximoPeriodo", solo ese periodo. */
export const periodosVistaPrevia = (propuesta: PropuestaPlan): PeriodoPropuesto[] =>
  propuesta.alcance === 'proximoPeriodo'
    ? propuesta.periodos.filter((item) => item.periodo.id === propuesta.periodoInicio.id)
    : propuesta.periodos;

/** Cuota mensual del periodo con el método elegido (en verano, sin descuento); null sin costos. */
export const cuotaDelPeriodo = (periodo: PeriodoPropuesto, metodoPago: string): number | null => {
  const cuotas = periodo.costos?.cuotas ?? [];
  return (cuotas.find((cuota) => cuota.metodo === metodoPago) ?? cuotas[0])?.cuotaMensual ?? null;
};

/** "Tu Ciclo 8 está vacío": el próximo ciclo regular no tiene cursos pendientes ubicados. */
export const cicloVacioProximo = (
  cursos: { estado: string; ubicacion: string; tipoPeriodo: string; ciclo: number }[], cicloActual: number | null
): number | null => {
  if (!cicloActual || !cursos.length) return null;
  const proximo = cicloActual + 1;
  const tieneCursos = cursos.some((curso) => curso.estado === 'PENDIENTE' && curso.ubicacion === 'periodo' &&
    curso.tipoPeriodo === 'REGULAR' && curso.ciclo === proximo);
  const quedaPendiente = cursos.some((curso) => curso.estado === 'PENDIENTE');
  return !tieneCursos && quedaPendiente ? proximo : null;
};

/** El mensaje de la app en el chat después de aplicar desde él. */
export const textoPlanAplicado = ({ ciclo, cursos, horas }: { ciclo: number; cursos: number; horas: number }): string =>
  `Listo, armé tu Ciclo ${ciclo}: ${pluralizar(cursos, '1 curso', `${cursos} cursos`)}, ${horas} h. ¿Lo analizo?`;
