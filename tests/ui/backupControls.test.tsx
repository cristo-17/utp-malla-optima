import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackupControls, DURACION_ERROR_RESPALDO_MS } from '../../src/components/BackupControls';

describe('Importar respaldo: el aviso de error', () => {
  it('no aparece si no se importó nada', () => {
    const html = renderToStaticMarkup(<BackupControls />);
    expect(html).toContain('Importar');
    expect(html).not.toContain('role="alert"');
  });

  it('se cierra solo a los 6 s y tiene una X', () => {
    expect(DURACION_ERROR_RESPALDO_MS).toBe(6000);
    const fuente = readFileSync(fileURLToPath(new URL('../../src/components/BackupControls.tsx', import.meta.url)), 'utf8');
    expect(fuente).toContain('aria-label="Cerrar aviso de importación"');
    expect(fuente).toMatch(/setTimeout\(\(\) => setError\(''\), DURACION_ERROR_RESPALDO_MS\)/);
  });
});
