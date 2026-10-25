import { Upload, X } from 'lucide-react';
import { useAcademicStore } from '../store/useAcademicStore';
import { importAcademicBackup } from '../application/usecases/importAcademicBackup';
import { useEffect, useState } from 'react';

/** El error de importación se cierra solo después de este tiempo (o con la X). */
export const DURACION_ERROR_RESPALDO_MS = 6000;

export const BackupControls = () => {
  const importarRespaldo = useAcademicStore((state) => state.importarRespaldo);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!error) return;
    const temporizador = window.setTimeout(() => setError(''), DURACION_ERROR_RESPALDO_MS);
    return () => window.clearTimeout(temporizador);
  }, [error]);

  const importar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Sin archivo elegido (se canceló el selector) no hay nada que avisar.
    if (!file) return;
    setError('');
    try {
      const data = await importAcademicBackup(file);
      await importarRespaldo(data.cursos, data.tarifario);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo importar el respaldo.');
    }
    event.target.value = '';
  };

  return (
    <div className="backup-controls">
      <label className="nav-action secondary">
        <Upload size={14} /> Importar
        <input hidden type="file" accept="application/json" onChange={importar} />
      </label>
      {error && <span className="backup-error" role="alert">
        {error}
        <button type="button" className="backup-error-cerrar" onClick={() => setError('')} aria-label="Cerrar aviso de importación"><X size={14} /></button>
      </span>}
    </div>
  );
};
