# smsteel.ru

Personal site. A full-viewport animated 3D background — a neon-grid floor,
a starfield with volumetric light shafts, and a field of procedurally
generated glass crystals — with a UI layer on top (currently just a login
card scaffold, mostly commented out while the background is the focus).

Built with React 19 + Vite + TypeScript, the 3D scene via
[three.js](https://threejs.org/) / [@react-three/fiber](https://r3f.docs.pmnd.rs/),
styled with Tailwind CSS v4 and [shadcn/ui](https://ui.shadcn.com/) (on top
of [Base UI](https://base-ui.com/), not Radix).

## Getting started

```bash
npm install
npm run dev       # starts the Vite dev server on http://localhost:5173
```

Other scripts:

```bash
npm run build      # tsc -b && vite build
npm run lint        # biome lint .
npm run format      # biome format --write .
npm run check       # biome check --write . (lint + format)
npm run preview     # preview a production build locally
npm run screenshot   # headless-Chromium screenshot driver, see below
```

There's no ESLint in this project — [Biome](https://biomejs.dev/) handles
both linting and formatting.

## Project structure

```
src/
  App.tsx                        # app shell: mounts SceneBackground + (WIP) login card
  components/
    scene-background/            # the 3D background — see below
    ui/                          # shadcn/ui components (Base UI primitives)
    theme-toggle.tsx
  hooks/
    use-reduced-motion.ts
  lib/
    utils.ts                     # cn() class-merging helper
```

### `scene-background/`

`scene-background.tsx` is the R3F `<Canvas>` composition root. It assembles:

- **`floor.tsx`** — a shader-based neon grid plane with click-triggered
  ripples (`ripples.ts`) and a cursor flashlight (`flashlight.tsx`).
- **`sky.tsx`**, **`nebula.tsx`**, **`horizon-glow.tsx`** — starfield and
  background atmosphere layers.
- **`volumetric-fog.tsx`** — postprocessing light shafts from a single
  "hero star," occluded by the floor and crystals (`FOG_OCCLUDER_LAYER`).
- **`crystals.tsx`** + **`sparks.tsx`** — the procedural crystal field:
  seeded-random (`mulberry32`) placement of ~110 "sites" across the ground,
  each either a single crystal or a multi-crystal "node" cluster fanning
  from one base point, built from a small pool of pre-generated geometry
  variants (randomized proportions + per-facet jitter) so every crystal
  reads as unique without paying for fully-unique-per-instance geometry.
  Placement includes real collision avoidance (no overlapping sites).
  `sparks.tsx` layers on top: a constant "fizz" of surface sparks, rare
  branching arcs off a single crystal, and rarer "resonance" bolts jumping
  between nearby crystals.
- **`title.tsx`** — the 3D wordmark, reusing the crystals' glass material
  and edge-outline shader for visual consistency.

Most of this layer is shader/PRNG-driven and computed once at module load
(`CRYSTAL_SITES`, geometry variants) rather than per-render.

## Visual verification

There's no component test suite yet — changes to the 3D scene are verified
visually via a small Playwright driver (`tests/visual/screenshot-app.mjs`)
that launches headless Chromium against the dev server and screenshots the
canvas. See the `run-smsteel` Claude Code skill (`.claude/skills/`) for the
usual workflow; screenshots themselves are gitignored (regenerated on
demand, not source).
