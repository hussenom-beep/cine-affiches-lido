// POST /api/account — { action: 'check-password', password }
// Revérifie le mot de passe de l'administrateur connecté (avant un changement de mot de passe),
// côté serveur, sans ouvrir de nouvelle session sur l'appareil : la double authentification
// de la session en cours est conservée.
import { getUser, handleError, HttpError, json, passwordMatches, readJson, requireAdmin } from './_lib/supabase.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function POST(request) {
  try {
    const token = await requireAdmin(request)
    const user = await getUser(token)
    const body = await readJson(request)
    if (body.action !== 'check-password') throw new HttpError(400, 'Action inconnue.')
    if (typeof body.password !== 'string' || !body.password || body.password.length > 200) throw new HttpError(400, 'Mot de passe requis.')
    if (!(await passwordMatches(user.email, body.password, user.id))) {
      await sleep(700)
      throw new HttpError(403, 'Mot de passe actuel incorrect.')
    }
    return json({ ok: true })
  } catch (err) {
    return handleError(err, 'api/account')
  }
}
