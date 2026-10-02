# Project notes

## Dev server

The dev server (`npm run dev`, port 5173) is always already running in a
terminal the user is watching — never start it, and never stop/kill it
(don't run `npm run dev`, don't kill the port-5173 listener). Just use it
as-is (e.g. for the `run-smsteel` skill's screenshot step) without asking
first.

## Architecture

React 19 + Vite + TypeScript. Tailwind v4 + shadcn/ui components built on
**Base UI** (not Radix — see `components.json`). Biome is the only
linter/formatter (no ESLint config or dependency exists in this repo).

`src/App.tsx` is the app shell: it mounts `<SceneBackground />` (a fixed,
full-viewport 3D canvas) with a UI layer on top — currently a login card
scaffold, mostly commented out while the background is the focus.

### `src/components/scene-background/`

The 3D background is an R3F (`@react-three/fiber`) scene. `scene-background.tsx`
is the `<Canvas>` composition root — it sets up the camera (fixed, no
orbit controls), lighting, postprocessing (`Bloom` + the custom
`VolumetricFog` pass), and mounts:

- **`floor.tsx`** — shader-based neon grid plane; click-triggered ripples
  (`ripples.ts`) and a cursor-driven flashlight (`flashlight.tsx`) both
  feed uniforms into its fragment shader. It's a *solid, opaque* mesh at
  world `y = 0` — anything rendered below that is invisible (depth-tested
  away), which matters for grounding any new geomety correctly.
- **`sky.tsx`**, **`nebula.tsx`**, **`horizon-glow.tsx`** — starfield /
  atmosphere layers, each an independent shader pass.
- **`volumetric-fog.tsx`** — postprocessing light shafts from a single
  "hero star" (`scene-background.tsx`'s `HeroStar`), occluded by anything
  on `FOG_OCCLUDER_LAYER` (the floor and every crystal shard mesh).
- **`crystals.tsx`** — the procedural crystal field. Key pieces:
  - `mulberry32(seed)` — the project's one seeded PRNG, reused everywhere
    (layout, geometry variants, other shader effects) for a reproducible-
    per-load but non-uniform look.
  - A shared pool of `SHARD_VARIANT_COUNT` (18) pre-generated shard
    geometries (`buildShardGeometryVariants`) — each with randomized
    proportions and per-facet radius jitter — built once at module load
    from a *fixed* seed (independent of the placement seed), so the shape
    "species" stays stable across reloads while layout still varies.
  - `CRYSTAL_SITES` (module-level, built once via `buildCrystalSites()`) —
    ~110 sites rejection-sampled across the ground, each either a single
    crystal (`buildShardCluster`, sometimes with one small leaning
    companion) or a "node": several crystals fanning outward from nearly
    one base point (reference: a real quartz cluster — one taller
    centerpiece, several shorter crystals tilting outward around it).
    Placement includes real collision avoidance (footprint-radius +
    minimum-distance rejection, not just the fixed UI-exclusion rectangle
    that keeps crystals off the login card's area).
  - Per-site glow (`triggerGlow`, `MAX_GLOWING_CRYSTALS`-capped FIFO
    eviction) drives the animated edge-outline "snake" shader
    (`EdgeSnake`/`buildEdgeGeometry`) and emissive flicker.
- **`sparks.tsx`** — layers three pooled, ref-driven (no per-frame
  allocation) particle effects on top of the crystal field: a constant
  "fizz" of tiny surface sparks, rare branching arcs off a single crystal,
  and rarer "resonance" bolts jumping between two nearby crystals. Spawn
  points are biased toward each shard's real silhouette via
  `SHARD_VARIANT_METRICS` (looked up per shard by `variantId`), not a
  single hardcoded shape.
- **`title.tsx`** — the 3D wordmark; reuses the crystals' glass material,
  color constants, and edge-outline shader for visual consistency, but is
  otherwise independent (its own environment map, own small arc pool).

Most of this layer is computed once at module load (`CRYSTAL_SITES`,
geometry variants, shader uniforms setup) rather than per-render — treat
anything reading `Date.now()`-seeded RNG as "fixed for this page load,
re-rolled on the next."

### Visual verification

No component test suite — 3D scene changes are verified visually via
`tests/visual/screenshot-app.mjs`, a Playwright driver that screenshots the
canvas against the (already-running, see above) dev server. See the
`run-smsteel` skill (`.claude/skills/run-smsteel/`) for the usual workflow.
Screenshots themselves are gitignored (regenerated on demand, not source).

## Commit messages: Conventional Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/)
— required by the release automation (`release.yml`, see CI).

Format: `<type>(<optional scope>): <description>`

- `feat: ...` — a new capability. Triggers a **minor** version bump.
- `fix: ...` — a bug fix. Triggers a **patch** version bump.
- `feat!: ...` or a `BREAKING CHANGE: ...` footer — triggers a **major**
  bump. Rare for a site this size; use deliberately.
- `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `ci:`, `build:` — no
  version bump. Use for anything that isn't a user-facing fix or feature.

One logical change per commit, same as always — this doesn't change that,
it just adds a prefix that says what kind of change it is.

## Branching & workflow

`develop` is the integration branch — every task branch gets PR'd there.
`main` is the GitHub **default** branch and release-only: it only moves via
a deliberate `develop` → `main` PR when you want to cut a release, and that
push is what triggers `release.yml`. Both branches require a PR — no direct
pushes, no force pushes, no deletions.

Because `main` is the default, **a new PR's base defaults to `main`** —
always target `develop` explicitly: `gh pr create --base develop …`.

The standard flow for any task:

1. Make sure it has a GitHub issue (see "Task tracking").
2. Create an isolated worktree for it at `.claude/worktrees/<branch>`.
3. Branch from `develop` as `<type>/<issue#>-<slug>` — `<type>` matches the
   Conventional Commits type (`feat/`, `fix/`, `chore/`, `docs/`, …).
4. Commit there, then open a PR explicitly targeting `develop`.

Releasing is its own step: open a `develop` → `main` PR and merge it when
you're ready. That merge leaves a commit on `main` that `develop` doesn't
have — `sync-develop.yml` opens a `main` → `develop` PR automatically;
merge it before starting new branches.

**A release only publishes an image** (`ghcr.io/sm-steel/smsteel-web:X.Y.Z`).
It does not deploy: production runs whatever version a separate, private
deployer repo pins, and deploying a release is a version-bump PR there.

## Task tracking (GitHub Issues)

Work is tracked as **GitHub Issues** on `sm-steel/smsteel.ru` via `gh` —
the issue tracker is the source of truth for what's done/in progress.

**Security rule — no exceptions, the repo is public:**

> **Never put real logins, hostnames, IPs, passwords, API keys/tokens, SSH
> keys, or any other credential into an issue title, issue body, issue
> comment, PR description, PR comment, or commit message.** Use
> placeholders (`<host>`, `<user>`, `<token>`). Everything here — commits,
> issues, PRs, history — is public and indexed; there is no private
> fallback to catch a slip.

## CI

- `checks.yml` — every push and PR (docs-only changes skipped): lint,
  build, and an image smoke test (the built image run read-only; `/`, a
  deep link and `/version.txt` checked; non-root asserted).
- `release.yml` — push to `main`: semantic-release cuts the version from
  Conventional Commits; if one was cut, the image is built and pushed.
- `sync-develop.yml` — push to `main`: opens the `main` → `develop` PR.
