// GET /api/image?src=<adresse> — relais des miniatures pour l'inventaire PDF.
//
// Le navigateur ne peut transformer une image en PDF que si le serveur d'origine l'autorise (CORS).
// Quand ce n'est pas le cas, l'image passe par ce relais, qui la renvoie depuis l'adresse du site.
// Sécurité : réservé aux administrateurs actifs, et limité aux affiches TMDB et aux photos
// du stockage « posters » du projet Supabase (ce n'est pas un relais ouvert).
import { HttpError, handleError, requireAdmin, supabaseUrl } from './_lib/supabase.js'

const MAX_BYTES = 5 * 1024 * 1024
const TMDB_PATH = /^\/t\/p\/(w92|w154|w185|w342|w500|w780)\/[\w-]+\.(jpe?g|png|webp)$/i

export function isAllowedImageUrl(raw, projectUrl) {
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  if (u.hostname === 'image.tmdb.org') return TMDB_PATH.test(u.pathname) && !u.search
  let project
  try { project = new URL(projectUrl) } catch { return false }
  return u.hostname === project.hostname && u.pathname.startsWith('/storage/v1/object/public/posters/') && !u.pathname.includes('..')
}

export async function GET(request) {
  try {
    await requireAdmin(request)
    const src = new URL(request.url).searchParams.get('src') || ''
    if (!isAllowedImageUrl(src, supabaseUrl())) throw new HttpError(400, 'Adresse d’image non autorisée.')

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    let res
    try {
      res = await fetch(src, { signal: ctrl.signal, redirect: 'error' })
    } catch {
      throw new HttpError(502, 'Image momentanément indisponible.')
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'Image indisponible.')
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new HttpError(502, 'Le fichier reçu n’est pas une image.')
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BYTES) throw new HttpError(413, 'Image trop lourde.')

    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
      },
    })
  } catch (err) {
    return handleError(err, 'api/image')
  }
}