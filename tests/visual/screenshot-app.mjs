#!/usr/bin/env node
// Headless-Chromium screenshot driver for smsteel.ru, used to visually verify
// changes against the running dev server (see .claude/skills/run-smsteel).
//
// Usage:
//   node tests/visual/screenshot-app.mjs [options]
//
// Options:
//   --url <url>       Page to load (default: http://localhost:5173)
//   --out <path>       Output PNG path (default: tests/visual/screenshots/latest.png)
//   --hide-ui           Hide foreground UI chrome (cards, buttons) to see the
//                       full background scene unobstructed
//   --mouse <x,y>       Move the mouse to x,y before screenshotting (e.g. to
//                       trigger the cursor-glow effect) and settle briefly
//   --wait <ms>         Extra time to let animations settle before the shot
//                       (default: 1200)

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { chromium } from "playwright"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const url = value("--url", "http://localhost:5173")
const out = value("--out", "tests/visual/screenshots/latest.png")
const wait = Number(value("--wait", "1200"))
const hideUi = flag("--hide-ui")
const mouse = value("--mouse", null)

await mkdir(dirname(out), { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text())
})
page.on("pageerror", (err) => errors.push(String(err)))

await page.goto(url, { waitUntil: "networkidle" })
await page.waitForSelector("canvas").catch(() => {})
await page.waitForTimeout(wait)

if (hideUi) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-slot="card"], button')) {
      el.style.display = "none"
    }
  })
}

if (mouse) {
  const [x, y] = mouse.split(",").map(Number)
  await page.mouse.move(x, y, { steps: 20 })
  await page.waitForTimeout(600)
}

await page.screenshot({ path: out })

console.log("screenshot:", out)
console.log("console errors:", JSON.stringify(errors))

await browser.close()

if (errors.length > 0) process.exitCode = 1
