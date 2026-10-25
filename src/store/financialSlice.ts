import type { AcademicRepositories } from '../application/ports/AcademicRepositories';
import { migrateLegacyFinancialRulesReference } from '../financial/rules/financialRulesCompatibility';
import type { AcademicSlice, AcademicStore } from './types';

type FinancialSlice = Pick<AcademicStore,
  'tarifario' | 'setTarifario' | 'metodoPago' | 'pagoUnicoPorPeriodo' | 'setMetodoPago' | 'setPagoUnico' |
  'presupuestoMensual' | 'setPresupuestoMensual'>;

export const createFinancialSlice = (repos: AcademicRepositories): AcademicSlice<FinancialSlice> => (set, get) => ({
  tarifario: null,
  metodoPago: 'sin_descuento',
  pagoUnicoPorPeriodo: {},
  presupuestoMensual: '',
  setPresupuestoMensual: (presupuestoMensual) => set({ presupuestoMensual }),
  setMetodoPago: (metodoPago) => set({ metodoPago }),
  setPagoUnico: (periodoId, activo) =>
    set((state) => ({ pagoUnicoPorPeriodo: { ...state.pagoUnicoPorPeriodo, [periodoId]: activo } })),
  setTarifario: async (tarifario) => {
    const normalizado = migrateLegacyFinancialRulesReference(tarifario);
    const disciplinas = Object.keys(normalizado.disciplinas);
    const actual = get().disciplinaActiva;
    const disciplinaActiva = disciplinas.includes(actual) ? actual : (disciplinas[0] ?? actual);
    await repos.transaction(async () => {
      await repos.financial.save(normalizado);
      await repos.profile.save({ universidadId: normalizado.universidadId, disciplinaActiva });
    });
    set({ tarifario: normalizado, disciplinaActiva });
  },
});
