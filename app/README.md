# lineage-app

A Microsoft Fabric static-hosted **SPA** (Rayfin) that visualises
**OpenLineage** data lineage for a OneLake medallion lakehouse.

For the full solution (Eventhouse setup, notebooks, architecture, and how it
works), see the [repository README](../README.md). This file covers app-level
development only.

> **This `src/` is the app that ships.** The deploy scripts build and host it
> from source by default (`./scripts/deploy.ps1`, or `npm run deploy` here). A
> prebuilt production bundle may also be kept locally in `prebuilt/` as a backup
> (not tracked in git); pass `-UsePrebuiltApp:$true` to re-host that bundle
> instead of building. Both target the same Eventhouse contract.

## Architecture

| Layer          | Technology                                                     |
| -------------- | -------------------------------------------------------------- |
| Frontend       | React 19 + Vite + TypeScript, hand-rolled SVG graph (no graph lib) |
| Hosting        | Rayfin **static hosting** (frontend only — no server backend)  |
| Lineage source | Eventhouse / KQL DB `lineage_eh` (OpenLineage events)          |
| Auth           | Entra (MSAL) — per-resource tokens; app login not required     |

## Views (tabs)

- **Overview** — health/run-success band and live counts (tables, columns,
  edges, runs, last activity); a drill-down **Lakehouses & schemas** tree; a
  **Top tables by impact** list; an **Activity** sparkline (last 14 days); and
  a **Recent runs** table. Auto-refreshes every 30s when enabled.
- **Lineage graph** — an **interactive** table-level lineage graph:
  - layered left→right layout with column rows per table card
  - **drag** any table card by its header to reposition it; **Fit** (zoom to
    fit) and **Reset layout** toolbar buttons restore the computed layout
  - click a table to highlight its **upstream + downstream** closure
  - **hover a column** to highlight its end-to-end **column-dependency**
    closure (the participating columns across tables, with the connecting
    column-level edges drawn and unrelated tables/edges dimmed)
  - a side **detail panel** shows the table's **columns** and **column-level
    lineage** (incoming/outgoing)
  - **right-click** a table for expand/collapse (upstream/downstream), isolate,
    collapse/expand columns, **Show code** (the medallion notebook source that
    produced the table, resolved from its `job_name`), **Check lakehouse
    access** (lists the workspace role assignments that govern access, with a
    name/UPN/email search), **Open lakehouse** (resolved via the Fabric REST
    API), and **Open monitoring hub**
  - search, column filter, color-by-lakehouse, expand/collapse all, and zoom
  - driven by the KQL functions `lin_table_edges_active()`,
    `lin_column_edges_active()`, `lin_runs()`, `lin_datasets()`.
- **Settings** — Eventhouse cluster URI + KQL database and identity
  (persisted to `localStorage` key `lineage.config.v1`).

## Getting started

```bash
npm install

# Local dev (Vite dev server; rayfin env injects RAYFIN_* vars).
npm run dev
```

Build / deploy:

```bash
npm run build    # tsc -b && vite build
npm run deploy   # rayfin up (static hosting)
```

Configuration comes from build-time `VITE_*` env vars (see
[.env.example](.env.example)) with a `localStorage` override
(`lineage.config.v1`) that the Settings page and the deploy scripts write.

## Project layout

```
rayfin/
  rayfin.yml            app definition (Entra auth + static hosting)
src/
  config.ts             AppConfig + load/save (localStorage override)
  theme.ts              dark theme tokens + status colours
  useLineage.ts         shared snapshot hook (stats/edges/columns/runs + 30s refresh)
  data/notebooks.ts     embedded medallion notebook source (for "Show code")
  utils/                format / dataset / notebook / colour helpers
  services/
    auth.ts             MSAL token acquisition (Kusto + Fabric; popups serialized)
    lineageService.ts   Eventhouse KQL queries (table + column lineage)
    fabricService.ts    Fabric REST lakehouse resolution + workspace users + portal links
  components/
    ShowCodeDrawer.tsx  bottom drawer rendering the resolved PySpark source
    AccessCheckDrawer.tsx  "Check lakehouse access" modal (workspace role assignments)
  pages/                Overview / Lineage graph / Settings
prebuilt/               Local-only prebuilt bundle backup (gitignored; opt-in via -UsePrebuiltApp)
```
