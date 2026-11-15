// POST /api/admins — gestion des administrateurs (réservée à l'administrateur principal).
//
// Les opérations sur les comptes Supabase (invitation par e-mail, blocage, suppression)
// exigent la clé serveur « service_role », qui ne quitte jamais ce fichier.
// Double contrôle : 1) le serveur vérifie que l'appelant est principal actif ;
// 2) chaque changement en base passe par une fonction SQL qui revérifie ce droit
//    avec le jeton de l'appelant (et garantit qu'il reste toujours un principal actif).
//
// Corps JSON : { action: 'invite', email } | { action: 'resend' | 'disable' | 'enable' | 'remove', userId }
import {
  authAdmin, handleError, HttpError, isEmail, isUuid, json, keyHeaders, readJson, requireOwner, rpcAsUser, selectAsService, siteOrigin, supabaseUrl, anonKey,
} from './_lib/supabase.js'

const BAN_FOREVER = '876000h' // ≈ 100 ans

async function findProfile(filter) {
  const rows = await selectAsService(`admin_profiles?select=user_id,email,role,status&${filter}`)
  return rows?.[0] || null
}

async function sendInvite(email, redirectTo) {
  const r = await authAdmin('POST', `/invite?redirect_to=${encodeURIComponent(redirectTo)}`, { email })
  if (r.ok) return { user: r.data, via: 'invite' }
  const code = r.data?.error_code || r.data?.code
  if (r.status === 422 && (code === 'email_exists' || /already been registered/i.test(r.data?.msg || ''))) {
    return { exists: true }
  }
  if (r.status === 429) throw new HttpError(429, 'Trop d’e-mails envoyés récemment. Réessayez plus tard (ou configurez un SMTP, voir le guide).')
  throw new HttpError(502, `L’invitation n’a pas pu être envoyée : ${r.data?.msg || r.data?.message || r.status}`)
}

// Repli : l'invité a déjà ouvert le lien mais n'a pas choisi de mot de passe → e-mail de réinitialisation.
async function sendRecovery(email, redirectTo) {
  const res = await fetch(`${supabaseUrl()}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: 'POST',
    headers: { ...keyHeaders(anonKey()), 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (res.status === 429) throw new HttpError(429, 'Trop d’e-mails envoyés récemment. Réessayez plus tard.')
  if (!res.ok) throw new HttpError(502, 'L’e-mail n’a pas pu être envoyé.')
  return { via: 'recovery' }
}

export async function POST(request) {
  try {
    const { token, user } = await requireOwner(request)
    const body = await readJson(request)
    const redirectTo = `${siteOrigin(request)}/espace-interne/activation`

    switch (body.action) {
      case 'invite': {
        const email = String(body.email || '').trim().toLowerCase()
        if (!isEmail(email)) throw new HttpError(400, 'Adresse e-mail invalide.')
        const existing = await findProfile(`email=eq.${encodeURIComponent(email)}`)
        if (existing && existing.status !== 'invited') throw new HttpError(409, 'Cette adresse est déjà administrateur.')
        const sent = await sendInvite(email, redirectTo)
        if (sent.exists) {
          if (existing) {
            await sendRecovery(email, redirectTo)
            await rpcAsUser('admin_record_invitation', { p_user_id: existing.user_id, p_email: email }, token)
            return json({ ok: true, userId: existing.user_id, message: 'Invitation renvoyée (lien de création du mot de passe).' })
          }
          throw new HttpError(409, 'Un compte Supabase existe déjà avec cette adresse sans être administrateur. Supprimez-le dans Supabase → Authentication → Users, puis réinvitez.')
        }
        await rpcAsUser('admin_record_invitation', { p_user_id: sent.user.id, p_email: email }, token)
        return json({ ok: true, userId: sent.user.id, message: `Invitation envoyée à ${email}.` })
      }

      case 'resend': {
        if (!isUuid(body.userId)) throw new HttpError(400, 'Compte invalide.')
        const p = await findProfile(`user_id=eq.${body.userId}`)
        if (!p) throw new HttpError(404, 'Administrateur introuvable.')
        if (p.status !== 'invited') throw new HttpError(409, 'Ce compte a déjà accepté son invitation.')
        const sent = await sendInvite(p.email, redirectTo)
        if (sent.exists) await sendRecovery(p.email, redirectTo)
        await rpcAsUser('admin_record_invitation', { p_user_id: p.user_id, p_email: p.email }, token)
        return json({ ok: true, message: `Invitation renvoyée à ${p.email}.` })
      }

      case 'disable':
      case 'enable': {
        if (!isUuid(body.userId)) throw new HttpError(400, 'Compte invalide.')
        const enable = body.action === 'enable'
        // 1) Base de données : l'accès aux données est coupé immédiatement (RLS)
        const status = await rpcAsUser('admin_set_status', { p_user_id: body.userId, p_enabled: enable }, token)
        // 2) Supabase Auth : empêche toute nouvelle connexion / prolongation de session
        const r = await authAdmin('PUT', `/admin/users/${body.userId}`, { ban_duration: enable ? 'none' : BAN_FOREVER })
        if (!r.ok) console.warn('[api/admins] blocage Auth non appliqué', r.status, r.data)
        return json({ ok: true, status, message: enable ? 'Compte réactivé.' : 'Compte désactivé : ses accès sont coupés.' })
      }

      case 'remove': {
        if (!isUuid(body.userId)) throw new HttpError(400, 'Compte invalide.')
        if (body.userId === user.id) throw new HttpError(409, 'Vous ne pouvez pas retirer votre propre compte. Transférez d’abord le rôle principal, ou désactivez-le.')
        await rpcAsUser('admin_remove', { p_user_id: body.userId }, token)
        // Le compte de connexion est supprimé ; l'historique conserve son nom et son e-mail.
        const r = await authAdmin('DELETE', `/admin/users/${body.userId}`)
        if (!r.ok && r.status !== 404) console.warn('[api/admins] suppression Auth non appliquée', r.status, r.data)
        return json({ ok: true, message: 'Accès retiré. L’historique de ce compte est conservé.' })
      }

      default:
        throw new HttpError(400, 'Action inconnue.')
    }
  } catch (err) {
    return handleError(err, 'api/admins')
  }
}
