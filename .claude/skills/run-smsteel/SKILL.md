---
name: run-smsteel
description: Launches the smsteel.ru Vite dev server and drives it with a headless-Chromium Playwright script to produce screenshots for visual verification. Use when asked to run, preview, or screenshot this app, or to visually confirm a UI/canvas change (e.g. the animated 3D scene background).
---

# Running & screenshotting smsteel.ru

This is a Vite + React app with no `chromium-cli` available in this
environment, so a small Playwright driver script (`tests/visual/screenshot-app.mjs`)
stands in for it. Playwright is already a devDependency.

## Dev server

```bash
npm run dev &
timeout 30 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
```

Stop it by killing the port's listener before relaunching (npm doesn't
forward signals to the child it spawns):

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
```

## Screenshot driver

One-time setup if browsers aren't installed yet: `npx playwright install chromium`.

```bash
npm run screenshot -- [options]
```

Options (all optional):

- `--url <url>` — page to load (default `http://localhost:5173`)
- `--out <path>` — output PNG (default `tests/visual/screenshots/latest.png`, gitignored)
- `--hide-ui` — hides foreground chrome (the shadcn login card, theme toggle
  button) so the full background scene is visible and unobstructed
- `--mouse <x,y>` — moves the mouse to a point and settles briefly, useful
  for triggering the cursor-glow effect in `SceneBackground`
- `--wait <ms>` — settle time before the shot (default `1200`; the 3D scene's
  bloom/twinkle/pulse animations need a beat to look right)

Example — verify the animated background end to end:

```bash
npm run screenshot -- --hide-ui --out tests/visual/screenshots/scene.png
npm run screenshot -- --mouse 900,300 --out tests/visual/screenshots/scene-mouse.png
```

Then use the Read tool on the output PNG to actually look at it — don't
declare success from the script exiting 0 alone.

The script prints `console errors: [...]` from the page; a non-empty array
also makes it exit non-zero. Check this before declaring anything working —
the canvas/WebGL scene can render its shell fine while a shader or
postprocessing effect silently fails.

## Cleanup

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
```
