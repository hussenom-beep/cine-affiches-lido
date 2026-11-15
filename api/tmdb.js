// GET /api/tmdb — accès sécurisé à TMDB, réservé aux administrateurs actifs.
// La clé TMDB reste sur le serveur et n'apparaît jamais dans le navigateur.
//   ?action=search&q=Mario&page=1
//   ?action=movie&id=157336   (détails du film + TOUTES ses affiches)
import { env, HttpError, json, handleError, requireAdmin } from './_lib/supabase.js'

const TMDB = 'https://api.themoviedb.org/3'

async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers = { accept: 'application/json' }
  const token = env('TMDB_READ_ACCESS_TOKEN')
  const key = env('TMDB_API_KEY')
  if (token) headers.authorization = `Bearer ${token}`
  else if (key) url.searchParams.set('api_key', key)
  else throw new HttpError(503, 'La clé TMDB n’est pas configurée sur le serveur (TMDB_READ_ACCESS_TOKEN).')
  const res = await fetch(url, { headers })
  if (res.status === 401) throw new HttpError(503, 'La clé TMDB est refusée par TMDB : vérifiez-la dans Vercel.')
  if (res.status === 404) throw new HttpError(404, 'Film introuvable sur TMDB.')
  if (res.status === 429) throw new HttpError(429, 'TMDB limite temporairement les requêtes. Réessayez dans quelques secondes.')
  if (!res.ok) throw new HttpError(502, 'TMDB est momentanément indisponible.')
  return res.json()
}

/** Ordre de la galerie : français, sans texte, anglais, puis les autres langues. */
export function languageRank(lang) {
  if (lang === 'fr') return 0
  if (!lang || lang === 'xx') return 1
  if (lang === 'en') return 2
  return 3
}

export function sortPosters(list) {
  return [...list].sort(
    (a, b) =>
      languageRank(a.iso_639_1) - languageRank(b.iso_639_1) ||
      String(a.iso_639_1 || '').localeCompare(String(b.iso_639_1 || '')) ||
      (b.vote_count || 0) - (a.vote_count || 0) ||
      (b.vote_average || 0) - (a.vote_average || 0),
  )
}

export async function GET(request) {
  try {
    await requireAdmin(request)
    const url = new URL(request.url)
    const action = url.searchParams.get('action')

    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim()
      if (!q) return json({ results: [], total_pages: 0, page: 1 })
      if (q.length > 120) throw new HttpError(400, 'Recherche trop longue.')
      const page = Math.min(Math.max(Number(url.searchParams.get('page')) || 1, 1), 20)
      const data = await tmdb('/search/movie', { query: q, language: 'fr-FR', include_adult: 'false', page: String(page), region: 'FR' })
      return json({
        page: data.page,
        total_pages: data.total_pages,
        results: (data.results || []).map((r) => ({
          id: r.id,
          title: r.title,
          original_title: r.original_title,
          release_date: r.release_date || null,
          poster_path: r.poster_path,
        })),
      })
    }

    if (action === 'movie') {
      const id = Number(url.searchParams.get('id'))
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identifiant de film invalide.')
      const [movie, images] = await Promise.all([
        tmdb(`/movie/${id}`, { language: 'fr-FR', append_to_response: 'credits' }),
        tmdb(`/movie/${id}/images`), // sans langue : TMDB renvoie les affiches de toutes les langues
      ])
      return json({
        id: movie.id,
        title: movie.title,
        original_title: movie.original_title,
        release_date: movie.release_date || null,
        overview: movie.overview || '',
        genres: (movie.genres || []).map((g) => g.name),
        runtime: movie.runtime || null,
        director: (movie.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name).join(', ') || null,
        poster_path: movie.poster_path,
        posters: sortPosters(
          (images.posters || []).map((p) => ({
            file_path: p.file_path,
            iso_639_1: p.iso_639_1 || null,
            width: p.width,
            height: p.height,
            vote_average: p.vote_average,
            vote_count: p.vote_count,
          })),
        ),
      })
    }

    throw new HttpError(400, 'Action inconnue.')
  } catch (err) {
    return handleError(err, 'api/tmdb')
  }
}
