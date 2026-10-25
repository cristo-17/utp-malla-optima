import type { ExplicacionPlan, MotivoNoPlanificado } from '../../domain/services/automaticPlanningService';
import { formatCredits } from '../../utils/formatCredits';
import { pluralizar } from '../../utils/pluralizar';

export const explicarPlan = (explicacion: ExplicacionPlan): string => {
  switch (explicacion.tipo) {
    case 'RESUMEN':
      return `${pluralizar(explicacion.total, 'Se organizó 1 curso pendiente', `Se organizaron ${explicacion.total} cursos pendientes`)} desde el ciclo ${explicacion.cicloInicio} hasta el ${explicacion.cicloFinal}, ${explicacion.conVeranos ? 'con ciclos regulares y veranos' : 'utilizando solo ciclos regulares'}${!explicacion.conVeranos && explicacion.jaladosEnVerano
        ? ` (el verano se usa únicamente para ${pluralizar(explicacion.jaladosEnVerano, 'tu curso jalado', `tus ${explicacion.jaladosEnVerano} cursos jalados`)})` : ''}.`;
    case 'LIMITE':
      return `Cada ciclo que recibe nuevas asignaciones respeta hasta ${explicacion.horas} horas semanales${explicacion.creditos
        ? ` y ${formatCredits(explicacion.creditos)} créditos.` : '. Los créditos son informativos y no limitan la propuesta.'}`;
    case 'CICLOS_AGREGADOS':
      return `Con estos límites hace falta ${pluralizar(explicacion.ciclos.length, 'agregar el ciclo', 'agregar los ciclos')} ${explicacion.ciclos.join(', ')} para terminar la carrera.`;
    case 'VERANOS_USADOS':
      return `Se ${pluralizar(explicacion.periodos.length, 'usa el', 'usan el')} ${explicacion.periodos.join(' y el ')} para no agregar ciclos (máximo de créditos por verano).`;
    case 'PRIORIDAD_OBLIGATORIOS':
      return 'Primero se organizan todos los obligatorios: se priorizan los que desbloquean más obligatorios pendientes y se completa el espacio con materias de ciclos anteriores o del actual, y después de ciclos posteriores.';
    case 'APROBADOS_SIN_CARGA':
      return 'Los aprobados y convalidados solo se consultan para resolver prerrequisitos; no aportan carga ni prioridad. Los cursos en curso se conservan.';
    case 'REQUISITOS_EXTERNOS':
      return 'Los prerrequisitos cuyos códigos no existen en la malla se omiten; los existentes deben cumplirse en un periodo anterior.';
    case 'CICLOS_EXCLUIDOS':
      return `Los ciclos retirados (${explicacion.ciclos.join(', ')}) no reciben asignaciones automáticas.`;
    case 'ELECTIVO_ELEGIDO':
      return `Se eligió un solo electivo: ${explicacion.curso.nombre} (${explicacion.curso.horasSemanales} h, ${formatCredits(explicacion.curso.creditos)} cr). Se selecciona por menos horas y, en empate, más créditos. Se coloca al final de los obligatorios si cabe; los demás electivos quedan en el banco como alternativas.`;
    case 'ELECTIVO_CUBIERTO':
      return 'Ya hay un electivo aprobado, convalidado, en curso o en un bloque cerrado. No se añaden electivos adicionales.';
    case 'JALADOS_PRIMERO':
      return `Primero se ${pluralizar(explicacion.total, 'colocó tu curso jalado', `colocaron tus ${explicacion.total} cursos jalados`)} en el ${explicacion.periodos.join(' y en el ')}, el primer periodo de su ventana de recuperación, como exige la UTP; el resto se organiza en los ciclos regulares.`;
    case 'CONSERVADOS':
      return `${pluralizar(explicacion.total, 'Se conservó 1 pendiente', `Se conservaron ${explicacion.total} pendientes`)} con asignaciones cerradas o vinculadas a veranos manuales válidos. Sus prerrequisitos y cargas se consideran al planificar.`;
    case 'PENDIENTES':
      return `${pluralizar(explicacion.total, '1 curso permanece', `${explicacion.total} cursos permanecen`)} en el banco. Revisa los motivos indicados para cada curso.`;
    case 'COMPLETADOS':
      return 'Se planificaron todos los obligatorios que podían reorganizarse y el electivo seleccionado, cuando era necesario.';
    case 'ADVERTENCIAS_HORAS':
      return `Algunas asignaciones manuales conservadas superan las ${explicacion.horas} horas recomendadas; se mantienen y se muestran como advertencia.`;
  }
};

export const explicarMotivo = (motivo: MotivoNoPlanificado): string => {
  switch (motivo.tipo) {
    case 'HORAS_INVALIDAS':
      return 'El curso no tiene una cantidad válida de horas semanales. Revisa el archivo importado.';
    case 'SIN_CICLOS_FUTUROS':
      return 'No hay ciclos regulares futuros en el rango elegido.';
    case 'DEPENDENCIA_CIRCULAR':
      return 'Existe una dependencia circular en sus prerrequisitos.';
    case 'REQUISITO_SIN_ESPACIO':
      return `${motivo.requisito.nombre} está en ${motivo.periodo.etiqueta}; no queda un ciclo posterior disponible para este curso.`;
    case 'REQUISITO_NO_PROGRAMADO':
      return `Depende de ${motivo.requisito.nombre} (${motivo.requisito.codigo}), que no está programado válidamente en un periodo anterior.`;
    case 'SIN_ESPACIO':
      return `No encontró espacio hasta el ciclo ${motivo.cicloFinal}, respetando prerrequisitos y las ${motivo.limiteHoras} horas${motivo.limiteCreditos ? ` y ${formatCredits(motivo.limiteCreditos)} créditos` : ''} por ciclo. Puedes añadir ciclos o ajustar la distribución manual.`;
    case 'NO_CABE_EN_PERIODO':
      return `Se puede llevar en el ${motivo.periodo.etiqueta}, pero pasaría el límite de ${motivo.limiteHoras} horas${motivo.limiteCreditos ? ` o de ${formatCredits(motivo.limiteCreditos)} créditos` : ''}.`;
    case 'ELECTIVO_ESPERA_OBLIGATORIOS':
      return 'El electivo queda en el banco hasta que puedan planificarse todos los obligatorios.';
  }
};
