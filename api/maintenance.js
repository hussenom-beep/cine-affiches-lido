// /api/maintenance — remise à zéro pendant la période de test.
//
// GET  : { enabled } — la fonction est-elle installée (03_maintenance.sql) ? Réservé au principal.
// POST : { scope: 'history' | 'stock' | 'all', password, confirm: 'EFFACER' }
//
// Triple protection :
//   1. la session doit être celle de l'administrateur principal actif ;
//   2. son MOT DE PASSE est revérifié ici, côté serveur (une session ouverte ne suffit pas) ;
//   3. la fonction SQL n'est exécutable qu'avec la clé serveur et revérifie le rôle principal.
// Pour retirer la fonction à la livraison : exécuter supabase/04_retirer_remise_a_zero.sql.
import { anonKey, handleError, HttpError, json, keyHeaders, readJson, requireOwner, rpcAsService, serviceKey, supabaseUrl } from './_lib/supabase.js'

const SCOPES = ['history', 'stock', 'all']
export const CONFIRM_WORD = 'EFFACER'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function isEnabled() {
  try { return (await rpcAsService('maintenance_enabled', {})) === true } catch { return false }
}

/** Vérifie le mot de passe en ouvrant une session temporaire, refermée aussitôt. */
async function passwordMatches(email, password, userId) {
  const res = await fetch(`${supabaseUrl()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { ...keyHeaders(anonKey()), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status === 429) throw new HttpError(429, 'Trop de tentatives. Patientez quelques minutes.')
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.user?.id !== userId) return false
  if (data.access_token) {
    await fetch(`${supabaseUrl()}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: keyHeaders(anonKey(), data.access_token),
    }).catch(() => {})
  }
  return true
}

async function removePhotos(paths) {
  const list = [...new Set((paths || []).filter((p) => typeof p === 'string' && p && !p.includes('..')))]
  let removed = 0
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100)
    const res = await fetch(`${supabaseUrl()}/storage/v1/object/posters`, {
      method: 'DELETE',
      headers: { ...keyHeaders(serviceKey()), 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: batch }),
    }).catch(() => null)
    if (res?.ok) removed += batch.length
    else console.warn('[api/maintenance] photos non supprimées', res?.status)
  }
  return removed
}

export async function GET(request) {
  try {
    await requireOwner(request)
    return json({ enabled: await isEnabled(), confirmWord: CONFIRM_WORD })
  } catch (err) {
    return handleError(err, 'api/maintenance')
  }
}

export async function POST(request) {
  try {
    const { user } = await requireOwner(request)
    const body = await readJson(request)
    const scope = String(body.scope || '')
    if (!SCOPES.includes(scope)) throw new HttpError(400, 'Type de remise à zéro inconnu.')
    if (String(body.confirm || '').trim().toUpperCase() !== CONFIRM_WORD) throw new HttpError(400, `Tapez ${CONFIRM_WORD} pour confirmer.`)
    if (typeof body.password !== 'string' || !body.password || body.password.length > 200) throw new HttpError(400, 'Mot de passe requis.')
    if (!(await isEnabled())) throw new HttpError(410, 'La remise à zéro a été retirée de cette installation.')

    if (!(await passwordMatches(user.email, body.password, user.id))) {
      await sleep(700)
      throw new HttpError(403, 'Mot de passe incorrect.')
    }

    const result = await rpcAsService('maintenance_reset', { p_actor: user.id, p_scope: scope })
    const photos = scope === 'all' ? await removePhotos(result?.paths) : 0
    console.info('[api/maintenance] remise à zéro', scope, 'par', user.email, { movements: result?.movements, stocks: result?.stocks, visuals: result?.visuals })
    return json({ ok: true, scope, movements: result?.movements || 0, stocks: result?.stocks || 0, visuals: result?.visuals || 0, films: result?.films || 0, photos })
  } catch (err) {
    return handleError(err, 'api/maintenance')
  }
}
