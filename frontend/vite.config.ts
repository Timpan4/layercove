import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import type { Connect } from 'vite'

// Backend target for dev server proxy. BACKEND_URL allows the frontend to
// run locally against a remote LayerCove instance; BACKEND_PORT preserves the
// existing local-backend workflow.
const backendPort = process.env.BACKEND_PORT || '8000'
const backendUrl = process.env.BACKEND_URL || `http://localhost:${backendPort}`

// Absolute path to the gcode_viewer directory at the repo root
const gcodeViewerDir = path.resolve(__dirname, '../gcode_viewer')

// MIME types for static files served from gcode_viewer/
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.obj':  'model/obj',
  '.mtl':  'model/mtl',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
}

/**
 * Map a request URL to a file inside `dir`. Returns null when the URL is not
 * under /gcode-viewer (segment boundary required) or when the resolved path
 * escapes `dir`.
 */
export function resolveGcodeViewerPath(url: string, dir: string): string | null {
  const pathname = url.split('?')[0]
  if (pathname !== '/gcode-viewer' && !pathname.startsWith('/gcode-viewer/')) return null
  let rel = pathname.slice('/gcode-viewer'.length)
  if (rel === '' || rel === '/') rel = '/index.html'
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  const absPath = path.resolve(dir, '.' + rel)
  return absPath.startsWith(dir + path.sep) ? absPath : null
}

/**
 * Vite dev-server plugin: serves ../gcode_viewer/ at /gcode-viewer/
 * without needing a proxy to uvicorn.  In production uvicorn handles it
 * via the StaticFiles mount in main.py.
 */
function serveGcodeViewer() {
  return {
    name: 'serve-gcode-viewer',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use((req, res, next) => {
        const absPath = resolveGcodeViewerPath(req.url ?? '', gcodeViewerDir)
        if (!absPath) return next()

        try {
          const stat = fs.statSync(absPath)
          if (stat.isFile()) {
            const ext = path.extname(absPath).toLowerCase()
            res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
            res.end(fs.readFileSync(absPath))
            return
          }
        } catch {
          // file not found — fall through to index.html
        }

        // SPA fallback: serve index.html for any unmatched /gcode-viewer/* path
        const index = path.join(gcodeViewerDir, 'index.html')
        if (fs.existsSync(index)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(fs.readFileSync(index))
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  // Default base ('/') emits absolute asset URLs (/assets/...). Required so
  // deep SPA routes (camera popup at /camera/<id>, /projects/<id>, kiosk
  // /spoolbuddy/ams, refresh on any nested route) resolve their <script>
  // and <link> tags to /assets/... instead of /<route-prefix>/assets/...,
  // which the SPA fallback would otherwise return as text/html and the
  // browser would refuse to execute (#1221). The earlier `base: ''` partial
  // fix for subpath reverse proxies (#1195, wontfix) is reverted — that
  // audience uses NPM + Cloudflare Tunnel at a real domain per the
  // documented workaround, which doesn't depend on this setting.
  plugins: [react(), serveGcodeViewer()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3000,
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api/v1/ws': {
        target: backendUrl,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: backendUrl,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
