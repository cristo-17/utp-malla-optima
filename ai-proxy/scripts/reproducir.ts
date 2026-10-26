/**
 * Reproduce una petición real contra la API de DeepSeek a través del handler del proxy (no corre en CI, gasta saldo).
 * Uso: pnpm reproducir <payload.json> [--veces N]
 * Lee DEEPSEEK_API_KEY de ai-proxy/.env.local (como pnpm evaluar). Por cada intento guarda la salida cruda del modelo
 * y, si no pasa el contrato, los problemas de Zod (path y code). Reporte en docs/evaluaciones/ (local).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AIRequestSchema, parsearRespuesta } from '../src/contracts.js';
import { problemasDelContenido } from '../src/deepseek.js';
import { crearHandlers, leerConfig } from '../src/handler.js';
import { crearLimitadorMemoria } from '../src/limites.js';
import { leerEnvLocal } from './evaluacion/cli.js';

const AI_PROXY = new URL('../', import.meta.url);
const ORIGEN = 'http://localhost:5173';

const args = process.argv.slice(2);
const ruta = args.find((arg) => !arg.startsWith('--'));
const veces = Number(args[args.indexOf('--veces') + 1]) || 10;
if (!ruta) throw new Error('Uso: pnpm reproducir <payload.json> [--veces N]');
const peticion = AIRequestSchema.parse(JSON.parse(readFileSync(ruta, 'utf8')));

const envLocal = new URL('.env.local', AI_PROXY);
const local = existsSync(envLocal) ? leerEnvLocal(readFileSync(envLocal, 'utf8')) : {};
const apiKey = process.env.DEEPSEEK_API_KEY ?? local.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Falta DEEPSEEK_API_KEY en ai-proxy/.env.local.');

interface Intento { contenido: string; finishReason: string | null; problemas: string[] }
/** Problemas del contrato de una salida cruda, igual que el log del proxy ("path:code", vacío o JSON inválido). */
const problemasDe = (contenido: string): string[] => {
  try {
    parsearRespuesta(peticion.modo, JSON.parse(contenido), peticion.contexto, true);
    return [];
  } catch (error) {
    return problemasDelContenido(contenido, error);
  }
};

const lineas: string[] = [`# Reproducción de ${ruta}`, '', `Modo ${peticion.modo}, ${peticion.mensajes.length} mensajes, ${veces} veces.`, ''];
let validas = 0;
for (let vez = 1; vez <= veces; vez += 1) {
  const intentos: Intento[] = [];
  const registros: unknown[] = [];
  // fetch real envuelto: guarda el contenido de cada respuesta del modelo (solo para este reporte local).
  const fetchEspia: typeof fetch = async (url, init) => {
    const respuesta = await fetch(url, init);
    const copia = respuesta.clone();
    try {
      const datos = await copia.json() as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
      const contenido = datos.choices?.[0]?.message?.content ?? '';
      intentos.push({ contenido, finishReason: datos.choices?.[0]?.finish_reason ?? null, problemas: problemasDe(contenido) });
    } catch { /* sin cuerpo JSON */ }
    return respuesta;
  };
  const config = leerConfig(
    { DEEPSEEK_API_KEY: apiKey, ALLOWED_ORIGINS: ORIGEN, VERCEL_ENV: 'production', AI_SALT: 'reproducir' },
    { fetch: fetchEspia, registrar: (registro) => registros.push(registro), limitador: crearLimitadorMemoria() },
  );
  const respuesta = await crearHandlers(config).POST(new Request('http://localhost/api/asistente', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGEN }, body: JSON.stringify(peticion),
  }));
  const cuerpo = await respuesta.json() as { error?: string };
  if (respuesta.ok) validas += 1;
  console.log(`${respuesta.ok ? '✓' : '✗'} #${vez} · ${respuesta.status} ${cuerpo.error ?? ''} · intentos ${intentos.length} · ${intentos.map((intento) => intento.problemas.join(',') || 'ok').join(' | ')}`);
  lineas.push(`## #${vez} · ${respuesta.status} ${cuerpo.error ?? 'ok'}`, '', `Registro: \`${JSON.stringify(registros.at(-1))}\``, '');
  intentos.forEach((intento, indice) => {
    lineas.push(`Intento ${indice + 1} · finish_reason \`${intento.finishReason}\` · problemas: ${intento.problemas.join(', ') || 'ninguno'}`, '', '```', intento.contenido, '```', '');
  });
}
console.log(`Válidas: ${validas}/${veces}`);
lineas.splice(3, 0, `**Válidas: ${validas}/${veces}**`, '');
const carpeta = new URL('../docs/evaluaciones/', AI_PROXY);
if (!existsSync(carpeta)) mkdirSync(carpeta, { recursive: true });
const fecha = new Date();
const nombre = `${fecha.toISOString().slice(0, 10)}-${String(fecha.getHours()).padStart(2, '0')}${String(fecha.getMinutes()).padStart(2, '0')}-reproduccion.md`;
writeFileSync(new URL(nombre, carpeta), `${lineas.join('\n')}\n`);
console.log(`Reporte: docs/evaluaciones/${nombre}`);
