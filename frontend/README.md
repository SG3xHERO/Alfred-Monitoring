# frontend

React dashboard. Vite, React Router, Tailwind v4. Monaco for the rules editor,
Recharts for the graphs, dnd-kit for the wall layout designer.

## Run

```
npm install
npm run dev          # Vite dev server on 5173, proxies /api to localhost:8080
npm run build        # type-check, then build to dist/
npm run preview
```

The dev server expects the backend on `localhost:8080` (see `vite.config.ts`).

## Build

`frontend/Dockerfile` builds this app and also cross-compiles the Go agent for
Linux and Windows, then serves both from nginx along with the install scripts.
The build context is the repo root, not this directory.

## Layout

```
src/
  pages/          one file per screen
  components/     shared UI, charts, the flow generator
  api.ts          fetch wrapper
  msal.ts         Microsoft sign-in (only loads when SSO is enabled)
  useLive.ts      SSE subscription for live updates
  types.ts
```
