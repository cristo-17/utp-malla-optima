import { X } from 'lucide-react';
import type { AppController } from '../../hooks/useAppController';
import { Asistente } from '../ai/Asistente';
import { AutogenerarModal } from '../AutogenerarModal';
import { AyudaModal } from '../AyudaModal';
import { BienvenidaModal } from '../BienvenidaModal';
import { FileUpload } from '../FileUpLoad';
import { PlanificadorPanel } from '../PlanificadorPanel';
import { PrerequisitoToast } from '../PrerequisitoToast';

export function AppOverlays({ app }: { app: AppController }) {
  return <>
    <PlanificadorPanel /><PrerequisitoToast /><Asistente /><AutogenerarModal />
    {app.cursoAMover && <div className="tap-move-floating-bar" role="status"><span>Moviendo {app.cursos.find((curso) => curso.codigo === app.cursoAMover)?.nombre}</span><button type="button" onClick={() => app.setCursoAMover(null)}><X size={14} /> Cancelar</button></div>}
    {app.errorExportar && <div className="integration-error" role="alert">{app.errorExportar}</div>}
    {app.mostrarConfiguracion && <BienvenidaModal onClose={() => app.setModalContexto(false)} />}
    {app.mostrarAyuda && <AyudaModal obligatorio={app.mostrarTutorialInicial}
      onClose={() => app.setModalAyuda(false)}
      onFinish={app.mostrarTutorialInicial ? app.finalizarTutorialInicial : undefined} />}
    {app.modalCarga && <div className="upload-modal-backdrop" role="presentation" onMouseDown={() => app.setModalCarga(false)}><div className="upload-modal" role="dialog" aria-modal="true" aria-label="Cargar malla" onMouseDown={(event) => event.stopPropagation()}><div className="upload-modal-head"><h2>Actualizar plan de estudios</h2><button type="button" onClick={() => app.setModalCarga(false)} aria-label="Cerrar"><X size={18} /></button></div><p>Al cargar una malla nueva se reinicia la planificación manual.</p><FileUpload onSuccess={() => app.setModalCarga(false)} /></div></div>}
  </>;
}
