# React + TypeScript + Vite

## Asistente académico IA

Botón flotante (abajo a la derecha) que analiza el plan y responde preguntas sobre carga, costos,
jalados, ruta y electivos. Arquitectura:

```
Web en Vercel (este frontend) ──▶ proxy en Vercel (ai-proxy/) ──▶ API de DeepSeek
```

- `src/application/ai/buildAIContext.ts` calcula TODO lo numérico y lógico (créditos, 4 escenarios de
  pago, nivel de carga, what-if, ruta, ventana de jalados). La IA solo redacta. No se envía el nombre
  del archivo ni datos personales.
- `src/application/ai/contracts.ts` (Zod) define petición y respuestas; los códigos de curso que no
  existan en el contexto se descartan. `ai-proxy/src/contracts.ts` es una copia verificada por test.
- La API key y el prompt del sistema viven solo en `ai-proxy/` (ver `ai-proxy/README.md`).
- `VITE_AI_ENDPOINT`: URL del proxy. Vacía en `pnpm dev` → mock local sin red.
- El proxy tiene control de gasto: interruptor `AI_PAUSADO`, límites por IP y por día, y las previews
  siempre en mock.

## Despliegue (solo Vercel)

La web y el proxy son **dos proyectos de Vercel** conectados a este repo de GitHub, con **rama de
producción `main`**. Cada push a `main` despliega a producción y cada PR crea una preview.

| Proyecto | Root Directory | Framework | Build | Output |
| --- | --- | --- | --- | --- |
| Web | raíz del repo (`./`) | Vite | `pnpm build` | `dist` |
| Proxy del asistente | `ai-proxy` | Other (función `api/asistente.ts`) | (ninguno) | (ninguno) |

Cada proyecto se construye solo cuando cambian sus archivos (`ignoreCommand`):
`vercel.json` ignora `ai-proxy/` y `docs/`; `ai-proxy/vercel.json` mira solo `ai-proxy/`.

La web se sirve en la raíz del dominio (base `/`). `VITE_BASE` es opcional, solo para servirla en una
subruta. El manifest de la PWA (`start_url`, `scope`) y el service worker toman esa base, y el service
worker no cachea las respuestas del proxy (solo precache del build). `pnpm verify:base` lo comprueba.

### Variables por entorno

Se definen en **Settings → Environment Variables** de cada proyecto. Las `VITE_*` se leen **al compilar**:
después de cambiarlas hay que volver a desplegar.

**Web**

| Variable | Production | Preview |
| --- | --- | --- |
| `VITE_AI_ENDPOINT` | `https://<proyecto-proxy>.vercel.app/api/asistente` | (vacía o la misma; no se usa con `VITE_AI_MOCK`) |
| `VITE_AI_MOCK` | (sin definir) | `true`: el asistente usa el mock local y nunca llama al proxy real |
| `VITE_BASE` | (sin definir: `/`) | (sin definir: `/`) |

**Proxy** (detalle en [`ai-proxy/README.md`](ai-proxy/README.md))

| Variable | Production | Preview |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | la clave (secreta) | no hace falta: fuera de producción el proxy siempre responde en mock |
| `ALLOWED_ORIGINS` | `https://<proyecto-web>.vercel.app` (y el dominio propio, si hay) | `http://localhost:5173,http://127.0.0.1:5173` |
| `AI_SALT` | texto aleatorio largo (secreto) | opcional |
| `AI_LIMITE_DISPOSITIVO_HORA` | `30` (por defecto) | opcional |
| `AI_LIMITE_IP_HORA` | `300` (por defecto) | opcional |
| `AI_LIMITE_DIARIO` | `1500` (por defecto) | opcional |
| `AI_PAUSADO` | `true` solo para pausar el gasto | opcional |
| `AI_MOCK` | (sin definir; `true` fuerza el mock) | no hace falta |
| `DEEPSEEK_MODEL` | opcional (`deepseek-flash`) | — |
| `DEEPSEEK_PICO_UTC` | opcional, solo para el costo estimado del log | — |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | los crea la integración de Upstash del Marketplace (o `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) | opcional |

`VERCEL_ENV` lo pone Vercel: con cualquier valor distinto de `production` el proxy usa el mock. Si el
dominio de la web no está en `ALLOWED_ORIGINS`, el proxy responde 403 y no llama a DeepSeek.

En Windows con Git Bash, `VITE_BASE=/x/ pnpm build` no sirve para probar a mano: MSYS convierte la ruta;
usa PowerShell (`$env:VITE_BASE='/x/'; pnpm build`) o `pnpm verify:base`.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
