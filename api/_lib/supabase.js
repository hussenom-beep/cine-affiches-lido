// Outils partagés par les fonctions serveur (/api/*).
// Les fichiers commençant par « _ » ne deviennent pas des adresses publiques sur Vercel.
// Aucune dépendance : uniquement fetch (Node 18+).

export function env(name, fallback) {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

export function supabaseUrl() {
  const url = env('SUPABASE_URL')
  if (!url) throw new HttpError(503, 'SUPABASE_URL n’est pas configuré sur le serveur.')
  return url.replace(/\/+$/, '')
}

export function anonKey() {
  const k = env('SUPABASE_ANON_KEY')
  if (!k) throw new HttpError(503, 'SUPABASE_ANON_KEY n’est pas configuré sur le serveur.')
  return k
}

export function serviceKey() {
  const k = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!k) throw new HttpError(503, 'SUPABASE_SERVICE_ROLE_KEY n’est pas configuré sur le serveur (nécessaire pour les invitations).')
  return k
}

/**
 * En-têtes d'authentification d'une clé Supabase.
 * • Nouvelles clés (sb_publishable_…, sb_secret_…) : en-tête « apikey » UNIQUEMENT
 *   (recommandation officielle Supabase : ce ne sont pas des jetons JWT).
 * • Anciennes clés « anon » / « service_role » (JWT) : « apikey » + « Authorization ».
 * userToken : jeton de session d'un utilisateur connecté (les règles RLS s'appliquent alors).
 */
export function keyHeaders(key, userToken) {
  const h = { apikey: key }
  if (userToken) h.authorization = `Bearer ${userToken}`
  else if (!key.startsWith('sb_')) h.authorization = `Bearer ${key}`
  return h
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers },
  })
}

export function handleError(err, where) {
  if (err instanceof HttpError) return json({ error: err.message }, err.status)
  console.error(`[${where}]`, err)
  return json({ error: 'Erreur interne du serveur. Réessayez dans un instant.' }, 500)
}

export function bearer(request) {
  const h = request.headers.get('authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

/** Appel d'une fonction SQL (RPC) avec le jeton de l'utilisateur : les règles de sécurité de la base s'appliquent. */
export async function rpcAsUser(name, args, userToken) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...keyHeaders(anonKey(), userToken), 'content-type': 'application/json' },
    body: JSON.stringify(args || {}),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw dbError(res.status, body)
  return body
}

/** Appel d'une fonction SQL avec la clé serveur (réservé aux opérations d'initialisation). */
export async function rpcAsService(name, args) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...keyHeaders(serviceKey()), 'content-type': 'application/json' },
    body: JSON.stringify(args || {}),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw dbError(res.status, body)
  return body
}

/** Lecture directe d'une table avec la clé serveur (contourne RLS : à n'utiliser qu'après contrôle des droits). */
export async function selectAsService(path) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, { headers: keyHeaders(serviceKey()) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw dbError(res.status, body)
  return body
}

function dbError(status, body) {
  const msg = body?.message || body?.msg || body?.error_description || body?.error || `Erreur base de données (${status})`
  const code = body?.code
  if (code === '42501' || status === 401 || status === 403) return new HttpError(403, msg)
  if (code === '23514' || code === '22023' || code === '23505') return new HttpError(409, msg)
  if (code === 'P0002') return new HttpError(404, msg)
  return new HttpError(status >= 400 && status < 600 ? status : 500, msg)
}

/** API d'administration de Supabase Auth (clé serveur). */
export async function authAdmin(method, path, body) {
  const res = await fetch(`${supabaseUrl()}/auth/v1${path}`, {
    method,
    headers: { ...keyHeaders(serviceKey()), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

/** Vérifie le jeton de session et renvoie l'utilisateur Supabase. */
export async function getUser(token) {
  if (!token) throw new HttpError(401, 'Session absente. Reconnectez-vous.')
  const res = await fetch(`${supabaseUrl()}/auth/v1/user`, { headers: keyHeaders(anonKey(), token) })
  if (!res.ok) throw new HttpError(401, 'Session expirée. Reconnectez-vous.')
  return res.json()
}

export async function requireAdmin(request) {
  const token = bearer(request)
  if (!token) throw new HttpError(401, 'Session absente. Reconnectez-vous.')
  const ok = await rpcAsUser('is_admin', {}, token).catch(() => false)
  if (ok !== true) throw new HttpError(403, 'Accès réservé aux administrateurs actifs.')
  return token
}

export async function requireOwner(request) {
  const token = bearer(request)
  const user = await getUser(token)
  const ok = await rpcAsUser('is_owner', {}, token).catch(() => false)
  if (ok !== true) throw new HttpError(403, 'Action réservée à l’administrateur principal.')
  return { token, user }
}

export function siteOrigin(request) {
  const configured = env('PUBLIC_SITE_URL')
  if (configured) return configured.replace(/\/+$/, '')
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host
  return `${proto}://${host}`
}

export function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

export function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function readJson(request) {
  try {
    const text = await request.text()
    if (text.length > 10_000) throw new Error('trop long')
    return text ? JSON.parse(text) : {}
  } catch {
    throw new HttpError(400, 'Requête invalide.')
  }
}
