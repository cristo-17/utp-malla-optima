import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAcademicStore } from '../store/useAcademicStore';
import { exportPlanPNG } from '../services/exportPlanPNG';
import { obtenerCiclosDisponibles, obtenerSiguienteCiclo } from '../domain/rules/cycleRules';
import { contarAvance } from '../presentation/selectors/plannerCardRules';
import { FinancialConfigurationProvider } from '../infrastructure/configuration/FinancialConfigurationProvider';
import { useTheme } from './useTheme';
import { useTutorialState } from './useTutorialState';

export function useAppController() {
  const store = useAcademicStore(useShallow((state) => ({
    cursos: state.cursos, cargarDesdeDB: state.cargarDesdeDB,
    setTarifario: state.setTarifario, nombreArchivoCargado: state.nombreArchivoCargado,
    perfilCargado: state.perfilCargado, periodoIngreso: state.periodoIngreso,
    cicloActual: state.cicloActual, cursoAMover: state.cursoAMover,
    setCursoAMover: state.setCursoAMover, totalCiclos: state.totalCiclos,
    ciclosExcluidos: state.ciclosExcluidos, agregarCiclo: state.agregarCiclo,
    setPanelPlanificadorAbierto: state.setPanelPlanificadorAbierto,
    reiniciarPlanificacion: state.reiniciarPlanificacion, abrirAutogenerar: state.abrirAutogenerar,
  })));
  const [modalCarga, setModalCarga] = useState(false);
  const [modalContexto, setModalContexto] = useState(false);
  const [modalAyuda, setModalAyuda] = useState(false);
  const [menuMovil, setMenuMovil] = useState(false);
  const [cicloInicioVisible, setCicloInicioVisible] = useState(1);
  const [mostrarVeranos, setMostrarVeranos] = useState(true);
  const [exportando, setExportando] = useState(false);
  const [errorExportar, setErrorExportar] = useState('');
  const { tema, cambiarTema } = useTheme();
  const { tutorialCompletado, finalizarTutorial } = useTutorialState();
  const { cargarDesdeDB, setTarifario } = store;

  useEffect(() => {
    const inicializar = async () => {
      await cargarDesdeDB();
      if (!useAcademicStore.getState().tarifario) {
        await setTarifario(FinancialConfigurationProvider.load());
      }
    };
    void inicializar();
  }, [cargarDesdeDB, setTarifario]);

  const { cursos, periodoIngreso, cicloActual, totalCiclos, ciclosExcluidos } = store;
  const sinMalla = cursos.length === 0;
  const sinContexto = !periodoIngreso || !cicloActual;
  const mostrarTutorialInicial = sinContexto && !tutorialCompletado;
  const mostrarAyuda = mostrarTutorialInicial || modalAyuda;
  const mostrarConfiguracion = !mostrarAyuda && (modalContexto || (sinContexto && tutorialCompletado));
  const pendientesBanco = cursos.filter((curso) => curso.estado === 'PENDIENTE' && curso.ubicacion === 'banco');
  const avance = contarAvance(cursos, cicloActual);
  const creditosElectivos = cursos.filter((curso) => curso.tipo === 'ELECTIVO' &&
    (curso.estado === 'APROBADO' || curso.estado === 'CONVALIDADO' || curso.ubicacion === 'periodo'))
    .reduce((suma, curso) => suma + curso.creditos, 0);
  const ciclosDisponibles = obtenerCiclosDisponibles(totalCiclos, ciclosExcluidos);
  const inicioVisible = ciclosDisponibles.includes(cicloInicioVisible) ? cicloInicioVisible
    : ciclosDisponibles.find((ciclo) => ciclo >= cicloInicioVisible) ?? ciclosDisponibles.at(-1) ?? 1;
  const ciclos = Array.from({ length: Math.max(0, totalCiclos - inicioVisible + 1) }, (_, index) => inicioVisible + index);
  const siguienteCiclo = obtenerSiguienteCiclo(totalCiclos, ciclosExcluidos);

  const descargarPNG = async () => {
    setExportando(true);
    setErrorExportar('');
    try {
      await exportPlanPNG(cursos, totalCiclos, cicloActual, periodoIngreso, ciclosExcluidos);
    } catch {
      setErrorExportar('No se pudo generar el PNG.');
    } finally {
      setExportando(false);
    }
  };
  const finalizarTutorialInicial = () => {
    finalizarTutorial();
    setModalAyuda(false);
  };

  return {
    ...store, tema, cambiarTema, modalCarga, setModalCarga,
    modalContexto, setModalContexto, modalAyuda, setModalAyuda,
    menuMovil, setMenuMovil, cicloInicioVisible, setCicloInicioVisible,
    mostrarVeranos, setMostrarVeranos, exportando, errorExportar,
    sinMalla, mostrarTutorialInicial, mostrarAyuda, mostrarConfiguracion,
    pendientesBanco, avance, creditosElectivos,
    ciclosDisponibles, inicioVisible, ciclos, siguienteCiclo,
    descargarPNG, finalizarTutorialInicial,
  };
}

export type AppController = ReturnType<typeof useAppController>;
