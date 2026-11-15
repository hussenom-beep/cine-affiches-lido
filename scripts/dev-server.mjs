// Serveur de développement local, sans dépendance : sert index.html et exécute
// les fonctions /api/* exactement comme Vercel (y compris les en-têtes de vercel.json).
//   npm run dev   →  http://localhost:3000
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT || 3000)

for (const file of ['.env.local', '.env']) {
  const p = join(root, file)
  if (!existsSync(p)) continue
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
const toRegex = (src) => new RegExp('^' + src.replace(/\(\.\*\)/g, '(.*)') + '$')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' }

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  for (const rule of vercel.headers) if (toRegex(rule.source).test(url.pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value)
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/\/$/, '')
      const file = join(root, 'api', `${name}.js`)
      if (!/^[a-z-]+$/.test(name) || !existsSync(file)) return void ((res.statusCode = 404), res.end('Not found'))
      const mod = await import(pathToFileURL(file).href + `?t=${statSync(file).mtimeMs}`)
      const handler = mod[req.method]
      if (!handler) return void ((res.statusCode = 405), res.end('Method not allowed'))
      const chunks = []
      for await (const c of req) chunks.push(c)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
      const response = await handler(request)
      res.statusCode = response.status
      response.headers.forEach((v, k) => res.setHeader(k, v))
      return void res.end(Buffer.from(await response.arrayBuffer()))
    }
    const candidate = join(root, url.pathname)
    // Seuls les fichiers publics simples sont servis (jamais .env, SQL, tests…)
    const servable = /^\/[\w-]+\.(html|svg|png|txt)$/.test(url.pathname)
    const file = servable && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html')
    res.setHeader('content-type', types[extname(file)] || 'application/octet-stream')
    res.end(readFileSync(file))
  } catch (err) {
    console.error(err)
    res.statusCode = 500
    res.end('Erreur serveur')
  }
}).listen(port, () => console.log(`Ciné Affiches : http://localhost:${port}  (administration : /espace-interne)`))
