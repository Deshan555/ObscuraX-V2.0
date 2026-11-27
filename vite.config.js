import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Writes dist/sw.js after the build: a service worker that precaches every
 * built file (app, fonts, face model, icons) so ObscuraX runs with no network.
 * The cache name is a hash of all file contents, so any change ships as an update.
 */
/** The NudeNet model and the onnxruntime WebAssembly files: fetched only when nudity blur is used. */
const ON_DEMAND = /(^|\/)(nudenet-320n\.onnx|ort-wasm[^/]*\.(wasm|mjs))$/

function offlineServiceWorker() {
  let outDir
  return {
    name: 'obscurax-offline-sw',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    closeBundle() {
      const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
      const files = walk(outDir)
        .map(f => relative(outDir, f).split(sep).join('/'))
        // .woff duplicates .woff2, which every browser with service workers reads.
        .filter(f => f !== 'sw.js' && !/\.(map|woff)$/.test(f) && !f.startsWith('.'))
        .sort()
      const template = readFileSync(resolve(import.meta.dirname, 'src/sw-template.js'), 'utf8')
      const hash = createHash('sha256').update(template)
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)))
      const version = hash.digest('hex').slice(0, 12)
      // Large files only needed by an optional feature (nudity detection) are
      // cached on first use instead of on install, so first visits stay small.
      const onDemand = files.filter(f => ON_DEMAND.test(f))
      // './' is the page itself; index.html is served there by any static host.
      const assets = ['./', ...files.filter(f => f !== 'index.html' && !ON_DEMAND.test(f))]
      writeFileSync(join(outDir, 'sw.js'), template
        .replace('__VERSION__', version)
        .replace('__ASSETS__', JSON.stringify(assets))
        .replace('__ON_DEMAND__', JSON.stringify(onDemand)))
      console.log(`\n  offline: sw.js precaches ${assets.length} files, ${onDemand.length} more on first use (version ${version})`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths, so the build works from any folder or sub-path.
  base: './',
  plugins: [react(), offlineServiceWorker()],
})
