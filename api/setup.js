// /api/setup — création du PREMIER administrateur principal (une seule fois).
//
// Sécurité :
//  • ne fonctionne que si la variable SETUP_CODE est définie sur Vercel (code secret
//    choisi par vous, 12 caractères minimum) et correctement saisi ;
//  • ne fonctionne que tant qu'AUCUN administrateur n'existe : la base refuse
//    ensuite toute nouvelle initialisation (fonction SQL bootstrap_first_owner) ;
//  • votre adresse et votre mot de passe ne sont jamais écrits dans le code.
//
//   GET  → { initialized, setupEnabled }
//   POST { setupCode, email, password, displayName } → crée le compte et le rôle principal
import { timingSafeEqual } from 'node:crypto'
import { authAdmin, env, handleError, HttpError, isEmail, json, readJson, rpcAsService, rpcAsUser } from './_lib/supabase.js'

const MIN_PASSWORD = 8

function sameSecret(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function GET() {
  try {
    const initialized = (await rpcAsUser('is_initialized', {})) === true
    const code = env('SETUP_CODE', '')
    return json({ initialized, setupEnabled: !initialized && code.length >= 12 })
  } catch (err) {
    return handleError(err, 'api/setup')
  }
}

export async function POST(request) {
  try {
    const code = env('SETUP_CODE', '')
    if (code.length < 12) throw new HttpError(503, 'Initialisation désactivée : définissez SETUP_CODE (12 caractères minimum) dans Vercel.')
    const body = await readJson(request)
    // Petite temporisation : rend les essais au hasard du code inutilement lents.
    await new Promise((r) => setTimeout(r, 400))
    if (!sameSecret(body.setupCode || '', code)) throw new HttpError(403, 'Code d’initialisation incorrect.')

    if ((await rpcAsUser('is_initialized', {})) === true) {
      throw new HttpError(409, 'L’application est déjà initialisée. Connectez-vous normalement.')
    }

    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const displayName = String(body.displayName || '').trim().slice(0, 80)
    if (!isEmail(email)) throw new HttpError(400, 'Adresse e-mail invalide.')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`)

    const created = await authAdmin('POST', '/admin/users', { email, password, email_confirm: true })
    if (!created.ok) {
      const exists = created.status === 422 || /already/i.test(created.data?.msg || '')
      throw new HttpError(exists ? 409 : 502, exists
        ? 'Un compte existe déjà avec cette adresse dans Supabase (Authentication → Users). Supprimez-le puis recommencez.'
        : `Création du compte impossible : ${created.data?.msg || created.status}`)
    }
    const userId = created.data.id
    try {
      await rpcAsService('bootstrap_first_owner', { p_user_id: userId, p_email: email, p_display_name: displayName || null })
    } catch (err) {
      await authAdmin('DELETE', `/admin/users/${userId}`) // annulation propre
      throw err
    }
    return json({ ok: true, message: 'Compte administrateur principal créé. Vous pouvez vous connecter.' })
  } catch (err) {
    return handleError(err, 'api/setup')
  }
}
