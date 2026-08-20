---
name: researching-and-porting-tutorials
description: Use when asked to implement an effect/technique from an external tutorial article and its companion demo/repo (e.g. a Codrops article, a CodeSandbox writeup, a "here's how X did it" blog post with linked source) — especially under read-only/plan-mode constraints where git clone or headless-browser screenshotting isn't available.
---

# Researching and porting tutorial techniques

## Overview

When a user points at a tutorial article + demo + repo and says "learn how
they did it, then do the same for us," the fast path is: fetch the article
text, find the linked repo, read its *final/most complete* example via the
GitHub web API (not `git clone`), and port the actual API calls — don't
assume the technique is a custom shader/render pass just because the visual
result looks complex. Many "advanced-looking" effects are a few lines of a
high-level API (e.g. three.js's `MeshPhysicalMaterial.transmission`) doing
the hard part internally.

## When to use

- User links a tutorial article and asks you to replicate its effect.
- You're tempted to `git clone` a repo or screenshot a live demo for
  research, but you're in **plan mode** or otherwise read-only (subagents
  with a read-only tool policy will refuse `git clone`/Playwright writes —
  don't fight that, use the read-only path below instead).
- You're about to hand-roll a shader/render-to-texture pipeline to
  reproduce something you haven't actually confirmed is implemented that
  way in the source.

## Workflow

1. **Fetch the article directly** with `WebFetch` — ask it to summarize the
   pipeline/technique AND to report the exact URL of any linked GitHub repo.
   Don't guess the repo URL; extract it.
2. **Browse the repo without cloning**, entirely via `WebFetch` on GitHub's
   own pages — this is read-only and works fine under plan mode:
   - `https://github.com/<owner>/<repo>` — top-level structure, README.
   - `https://github.com/<owner>/<repo>/tree/<branch>/<path>` — list a
     subfolder.
   - `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` —
     full raw file contents, verbatim.
   
   If genuinely outside plan mode and a local clone is needed (e.g. to grep
   across many files), `git clone --depth 1 <url> /tmp/<name>` works, but
   for a single-file-per-step tutorial repo the raw-URL approach above is
   usually enough and needs no cleanup.
3. **Find the final/most-complete example**, not step 1. Tutorials
   structured as numbered step folders (`01`, `02`, ... or `demo-1`,
   `demo-2`, ...) accumulate features — the last one is the reference
   implementation. Read its README/structure listing to confirm which
   folder is actually last before diving into code.
4. **Read the actual source, don't infer from the visual result.** Fetch
   the key file(s) verbatim (raw URL) and check: is this a custom
   shader/manual render pass, or is it a few properties set on a built-in
   material/API? Report exactly what's there — assuming complexity that
   isn't in the source wastes an implementation cycle building the wrong
   thing.
5. **Verify the API still exists in your project's installed version.**
   Tutorials age; libraries evolve. Grep the relevant `node_modules`
   source (or docs) for the properties/methods the tutorial uses before
   committing to them in a plan — don't assume year-old tutorial code
   matches your current dependency version.
6. **Identify what made the demo's result actually work**, not just which
   properties were set. A material recipe copied without its supporting
   assets (a real HDR environment map, a normal map providing surface
   detail) can silently fail to produce the same look — cranking an
   intensity knob on thin/absent input won't fix that. If the original
   relies on binary assets your project doesn't otherwise use, either
   source equivalent ones or reproduce them procedurally (see worked
   example below) rather than skipping them.

## Worked example: three.js glass/plastic material

Source: [Codrops — "Creating the Effect of Transparent Glass and Plastic in
Three.js"](https://tympanus.net/codrops/2021/10/27/creating-the-effect-of-transparent-glass-and-plastic-in-three-js/),
repo [kellymilligan/codrops-oct-2021-final](https://github.com/kellymilligan/codrops-oct-2021-final)
(15 numbered step folders; `15` is final).

**The whole technique is stock `THREE.MeshPhysicalMaterial`** — no custom
shaders, no manual render-to-texture code anywhere in that repo. Setting
`transmission > 0` makes three.js's `WebGLRenderer` internally capture the
scene behind the object each frame and sample it for refraction
(roughness-driven blur, IOR-driven UV offset) — entirely a black box inside
three.js core. The final demo's recipe:

```js
new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0,
  roughness: 0.2,       // 0-0.15 or 0.65+ read best; mid-range shows pixelation
  transmission: 1,       // makes it see-through (not the same as opacity)
  ior: 1.5,
  thickness: 2.5,         // drives refraction distortion strength
  envMap: hdrEquirectTexture,   // MUST be a real, bright, varied environment —
  envMapIntensity: 1.5,          // a dark/sparse envMap won't read as a reflection
                                   // at any intensity, no matter how high
  clearcoat: 1,
  clearcoatRoughness: 0.1,
  normalMap: tiledNormalMapTexture,   // breaks a transmissive surface into
  normalScale: new THREE.Vector2(0.3, 0.3),   // recognizable facets/ripples —
  clearcoatNormalMap: tiledNormalMapTexture,   // without this it reads as a
  clearcoatNormalScale: new THREE.Vector2(0.2, 0.2), // flat smooth-shaded blob
})
```

**No `@react-three/drei` needed** — `<meshPhysicalMaterial>` is a native
r3f JSX intrinsic. (Drei's `MeshTransmissionMaterial` is a *different*,
heavier technique — a hand-authored shader adding chromatic
aberration/distortion on top of this same core mechanism — don't reach for
it by default just because the visual goal is "glass".)

**If your project has no binary asset pipeline** (no bundled
textures/HDRs), reproduce both supporting assets procedurally instead of
adding files:

- **Environment map**: build a small offscreen `THREE.Scene` (a gradient
  sky sphere + a few bright unlit highlight spheres) and bake it once via
  `THREE.PMREMGenerator(renderer).fromScene(scene, 0, near, far).texture`.
  One-time cost, correctly roughness-blurred, real IBL — not a live capture
  and not a hand-rolled Fresnel overlay hack.
- **Normal map**: generate a tileable heightfield from a sum of sinusoids
  with *integer* frequencies over a `[0,1)` UV tile (exactly periodic at
  the tile boundary, so it wraps seamlessly with no blending needed), then
  derive a normal map via a wrap-around central-difference (Sobel-style)
  pass into a `CanvasTexture`. Set `colorSpace = THREE.NoColorSpace`
  (normal maps are non-color data). See
  `src/components/scene-background/procedural-normal-map.ts` and
  `src/components/scene-background/crystal-environment.ts` in this repo
  for the full working implementation.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming a polished effect needs a custom shader | Read the actual source first — many effects are a few built-in material properties |
| `git clone`-ing when in plan mode / read-only | Use `WebFetch` on the GitHub page / `raw.githubusercontent.com` instead |
| Copying a tutorial's material properties but skipping its texture assets | The assets (HDRI, normal map) often *are* the effect; reproduce them (real or procedural) rather than omitting them |
| Cranking an intensity/multiplier prop to compensate for missing/weak input content | If the source (envMap, background) has no real signal, no multiplier fixes it — fix the input, not the multiplier |
| Reading step 1 of a numbered tutorial series instead of the last step | Confirm which folder is actually final before reading code |
| Trusting a multi-year-old tutorial's API surface as-is | Grep your installed dependency's source for the exact properties before relying on them |
