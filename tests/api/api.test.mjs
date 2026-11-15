// Tests des fonctions serveur /api/* : contrôles d'accès, validation, enchaînement des appels.
// Supabase et TMDB sont simulés (fetch remplacé) : on vérifie ce que le serveur envoie et refuse.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const SB = 'https://projet.supabase.co'
Object.assign(process.env, { SUPABASE_URL: SB, SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', TMDB_READ_ACCESS_TOKEN: 'tmdb-token', SETUP_CODE: 'code-secret-123' })

const { GET: configGET } = await import('../../api/config.js')
const { GET: tmdbGET, sortPosters } = await import('../../api/tmdb.js')
const { POST: adminsPOST } = await import('../../api/admins.js')
const { GET: setupGET, POST: setupPOST } = await import('../../api/setup.js')

let calls = []
let routes = []
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const call = { url: u, method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers || {}).entries()), body: init.body ? JSON.parse(init.body) : undefined }
  calls.push(call)
  for (const [match, fn] of routes) if (match(call)) return fn(call)
  return reply({ message: `route non simulée ${call.method} ${u}` }, 500)
}
beforeEach(() => { calls = []; routes = [] })
const on = (method, re, fn) => routes.push([(c) => c.method === method && re.test(c.url), fn])
const req = (path, { method = 'GET', token, body } = {}) => new Request(`https://affiches-lelido.fr${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})
const json = async (r) => ({ status: r.status, body: await r.json() })

// Simulation des droits : jeton → rôle
const ROLES = { owner: { id: '11111111-1111-1111-1111-111111111111', admin: true, owner: true }, admin: { id: '33333333-3333-3333-3333-333333333333', admin: true, owner: false }, nobody: { id: '44444444-4444-4444-4444-444444444444', admin: false, owner: false } }
function mockAuth() {
  on('GET', /\/auth\/v1\/user$/, (c) => { const r = ROLES[c.headers.authorization?.slice(7)]; return r ? reply({ id: r.id, email: 'x@x.fr' }) : reply({ msg: 'invalid' }, 401) })
  on('POST', /\/rest\/v1\/rpc\/is_admin$/, (c) => reply(ROLES[c.headers.authorization?.slice(7)]?.admin === true))
  on('POST', /\/rest\/v1\/rpc\/is_owner$/, (c) => reply(ROLES[c.headers.authorization?.slice(7)]?.owner === true))
}

test('config : ne renvoie que des paramètres publics', async () => {
  const r = await json(configGET())
  assert.deepEqual(r.body, { configured: true, supabaseUrl: SB, supabaseAnonKey: 'anon-key' })
  assert.ok(!JSON.stringify(r.body).includes('service-secret') && !JSON.stringify(r.body).includes('tmdb-token'))
})

test('tmdb : refusé sans session, et pour un compte non administrateur', async () => {
  mockAuth()
  assert.equal((await tmdbGET(req('/api/tmdb?action=search&q=mario'))).status, 401)
  assert.equal((await tmdbGET(req('/api/tmdb?action=search&q=mario', { token: 'nobody' }))).status, 403)
  assert.ok(!calls.some((c) => c.url.includes('themoviedb')), 'TMDB ne doit pas être appelé')
})

test('tmdb : recherche et galerie complète pour un administrateur (clé jamais renvoyée)', async () => {
  mockAuth()
  on('GET', /api\.themoviedb\.org\/3\/search\/movie/, () => reply({ page: 1, total_pages: 1, results: [{ id: 27205, title: 'Inception', original_title: 'Inception', release_date: '2010-07-16', poster_path: '/p.jpg' }] }))
  on('GET', /api\.themoviedb\.org\/3\/movie\/27205\/images/, () => reply({ posters: [{ file_path: '/en.jpg', iso_639_1: 'en', vote_count: 9 }, { file_path: '/fr.jpg', iso_639_1: 'fr', vote_count: 1 }, { file_path: '/xx.jpg', iso_639_1: null }, { file_path: '/de.jpg', iso_639_1: 'de' }] }))
  on('GET', /api\.themoviedb\.org\/3\/movie\/27205\?/, () => reply({ id: 27205, title: 'Inception', original_title: 'Inception', release_date: '2010-07-16', genres: [{ name: 'Action' }], runtime: 148, poster_path: '/p.jpg', credits: { crew: [{ job: 'Director', name: 'Christopher Nolan' }] } }))
  const s = await json(await tmdbGET(req('/api/tmdb?action=search&q=Incep', { token: 'admin' })))
  assert.equal(s.status, 200)
  assert.equal(s.body.results[0].title, 'Inception')
  const tmdbCall = calls.find((c) => c.url.includes('themoviedb'))
  assert.equal(tmdbCall.headers.authorization, 'Bearer tmdb-token')
  assert.match(tmdbCall.url, /language=fr-FR/)
  const m = await json(await tmdbGET(req('/api/tmdb?action=movie&id=27205', { token: 'admin' })))
  assert.deepEqual(m.body.posters.map((p) => p.iso_639_1), ['fr', null, 'en', 'de'])
  assert.equal(m.body.director, 'Christopher Nolan')
  const imagesCall = calls.find((c) => c.url.includes('/images'))
  assert.ok(!/language=/.test(imagesCall.url), 'toutes les langues doivent être demandées')
  assert.ok(!JSON.stringify(m.body).includes('tmdb-token'))
})

test('tmdb : ordre de la galerie', () => {
  assert.deepEqual(sortPosters([{ iso_639_1: 'it' }, { iso_639_1: 'en' }, { iso_639_1: 'xx' }, { iso_639_1: 'fr' }]).map((p) => p.iso_639_1), ['fr', 'xx', 'en', 'it'])
})

test('admins : seul le principal peut inviter (administrateur ordinaire refusé)', async () => {
  mockAuth()
  const r = await adminsPOST(req('/api/admins', { method: 'POST', token: 'admin', body: { action: 'invite', email: 'a@b.fr' } }))
  assert.equal(r.status, 403)
  assert.ok(!calls.some((c) => c.url.includes('/invite')), 'aucune invitation envoyée')
  assert.equal((await adminsPOST(req('/api/admins', { method: 'POST', body: { action: 'invite', email: 'a@b.fr' } }))).status, 401)
})

test('admins : invitation par le principal (clé serveur uniquement côté serveur)', async () => {
  mockAuth()
  on('GET', /\/rest\/v1\/admin_profiles\?/, () => reply([]))
  on('POST', /\/auth\/v1\/invite\?redirect_to=/, () => reply({ id: '22222222-2222-2222-2222-222222222222', email: 'contact@lido.example' }))
  on('POST', /\/rest\/v1\/rpc\/admin_record_invitation$/, () => reply('invited'))
  const r = await json(await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'invite', email: ' Contact@Lido.example ' } })))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const invite = calls.find((c) => c.url.includes('/auth/v1/invite'))
  assert.equal(invite.headers.apikey, 'service-secret')
  assert.equal(invite.body.email, 'contact@lido.example')
  assert.match(decodeURIComponent(invite.url), /redirect_to=https:\/\/affiches-lelido\.fr\/espace-interne\/activation/)
  const record = calls.find((c) => c.url.endsWith('/rpc/admin_record_invitation'))
  assert.equal(record.headers.authorization, 'Bearer owner', 'la base revérifie le rôle avec le jeton du principal')
  assert.ok(!JSON.stringify(r.body).includes('service-secret'))
})

test('admins : adresse invalide et compte déjà administrateur refusés', async () => {
  mockAuth()
  assert.equal((await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'invite', email: 'pas-une-adresse' } }))).status, 400)
  on('GET', /\/rest\/v1\/admin_profiles\?/, () => reply([{ user_id: 'x', email: 'a@b.fr', status: 'active' }]))
  assert.equal((await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'invite', email: 'a@b.fr' } }))).status, 409)
})

test('admins : renvoi d’invitation (repli par lien de mot de passe si le lien a déjà été ouvert)', async () => {
  mockAuth()
  const id = '22222222-2222-2222-2222-222222222222'
  on('GET', /\/rest\/v1\/admin_profiles\?/, () => reply([{ user_id: id, email: 'contact@lido.example', status: 'invited' }]))
  on('POST', /\/auth\/v1\/invite/, () => reply({ error_code: 'email_exists', msg: 'A user with this email address has already been registered' }, 422))
  on('POST', /\/auth\/v1\/recover/, () => reply({}))
  on('POST', /\/rpc\/admin_record_invitation$/, () => reply('invited'))
  const r = await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'resend', userId: id } }))
  assert.equal(r.status, 200)
  assert.ok(calls.some((c) => c.url.includes('/auth/v1/recover')))
})

test('admins : désactivation = droits coupés en base + connexion bloquée', async () => {
  mockAuth()
  const id = '22222222-2222-2222-2222-222222222222'
  on('POST', /\/rpc\/admin_set_status$/, () => reply('disabled'))
  on('PUT', /\/auth\/v1\/admin\/users\//, () => reply({}))
  const r = await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'disable', userId: id } }))
  assert.equal(r.status, 200)
  const status = calls.find((c) => c.url.endsWith('/rpc/admin_set_status'))
  assert.deepEqual(status.body, { p_user_id: id, p_enabled: false })
  assert.equal(calls.find((c) => c.method === 'PUT').body.ban_duration, '876000h')
})

test('admins : la base refuse de désactiver le dernier principal → erreur transmise, aucun blocage appliqué', async () => {
  mockAuth()
  on('POST', /\/rpc\/admin_set_status$/, () => reply({ code: '23514', message: 'Impossible : il doit toujours rester au moins un administrateur principal actif.' }, 400))
  const r = await json(await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'disable', userId: ROLES.owner.id } })))
  assert.equal(r.status, 409)
  assert.match(r.body.error, /au moins un administrateur principal/)
  assert.ok(!calls.some((c) => c.method === 'PUT'))
})

test('admins : impossible de retirer son propre compte', async () => {
  mockAuth()
  const r = await adminsPOST(req('/api/admins', { method: 'POST', token: 'owner', body: { action: 'remove', userId: ROLES.owner.id } }))
  assert.equal(r.status, 409)
})

test('setup : code obligatoire, une seule fois', async () => {
  on('POST', /\/rpc\/is_initialized$/, () => reply(false))
  const g = await json(await setupGET())
  assert.deepEqual(g.body, { initialized: false, setupEnabled: true })
  const bad = await setupPOST(req('/api/setup', { method: 'POST', body: { setupCode: 'faux', email: 'moi@exemple.fr', password: 'motdepasse1' } }))
  assert.equal(bad.status, 403)
  assert.ok(!calls.some((c) => c.url.includes('/admin/users')))
})

test('setup : création du compte principal personnel', async () => {
  on('POST', /\/rpc\/is_initialized$/, () => reply(false))
  on('POST', /\/auth\/v1\/admin\/users$/, () => reply({ id: '11111111-1111-1111-1111-111111111111' }))
  on('POST', /\/rpc\/bootstrap_first_owner$/, () => reply(null))
  const r = await setupPOST(req('/api/setup', { method: 'POST', body: { setupCode: 'code-secret-123', email: 'Moi@Exemple.fr', password: 'motdepasse1', displayName: 'Matthias' } }))
  assert.equal(r.status, 200)
  const create = calls.find((c) => c.url.endsWith('/auth/v1/admin/users'))
  assert.deepEqual(create.body, { email: 'moi@exemple.fr', password: 'motdepasse1', email_confirm: true })
  const boot = calls.find((c) => c.url.endsWith('/rpc/bootstrap_first_owner'))
  assert.equal(boot.headers.apikey, 'service-secret')
})

test('setup : refusé si déjà initialisé ; annulation propre si la base refuse', async () => {
  on('POST', /\/rpc\/is_initialized$/, () => reply(true))
  assert.equal((await setupPOST(req('/api/setup', { method: 'POST', body: { setupCode: 'code-secret-123', email: 'moi@exemple.fr', password: 'motdepasse1' } }))).status, 409)
  routes = []
  on('POST', /\/rpc\/is_initialized$/, () => reply(false))
  on('POST', /\/auth\/v1\/admin\/users$/, () => reply({ id: '11111111-1111-1111-1111-111111111111' }))
  on('POST', /\/rpc\/bootstrap_first_owner$/, () => reply({ code: '42501', message: 'L’application est déjà initialisée.' }, 400))
  on('DELETE', /\/auth\/v1\/admin\/users\//, () => reply({}))
  const r = await setupPOST(req('/api/setup', { method: 'POST', body: { setupCode: 'code-secret-123', email: 'moi@exemple.fr', password: 'motdepasse1' } }))
  assert.equal(r.status, 403)
  assert.ok(calls.some((c) => c.method === 'DELETE'), 'le compte créé doit être supprimé')
})

test('nouvelles clés Supabase (sb_secret_…) : en-tête apikey seul, jamais en Authorization', async () => {
  const { keyHeaders } = await import('../../api/_lib/supabase.js')
  assert.deepEqual(keyHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' })
  assert.deepEqual(keyHeaders('sb_publishable_abc', 'jwt-user'), { apikey: 'sb_publishable_abc', authorization: 'Bearer jwt-user' })
  assert.deepEqual(keyHeaders('eyJ.legacy.jwt'), { apikey: 'eyJ.legacy.jwt', authorization: 'Bearer eyJ.legacy.jwt' })
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_nouvelle'
  on('POST', /\/rpc\/is_initialized$/, () => reply(false))
  on('POST', /\/auth\/v1\/admin\/users$/, () => reply({ id: '11111111-1111-1111-1111-111111111111' }))
  on('POST', /\/rpc\/bootstrap_first_owner$/, () => reply(null))
  await setupPOST(req('/api/setup', { method: 'POST', body: { setupCode: 'code-secret-123', email: 'moi@exemple.fr', password: 'motdepasse1' } }))
  const create = calls.find((c) => c.url.endsWith('/auth/v1/admin/users'))
  assert.equal(create.headers.apikey, 'sb_secret_nouvelle')
  assert.equal(create.headers.authorization, undefined)
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved
})

test('setup : désactivé sans SETUP_CODE', async () => {
  const saved = process.env.SETUP_CODE
  process.env.SETUP_CODE = ''
  on('POST', /\/rpc\/is_initialized$/, () => reply(false))
  assert.equal((await json(await setupGET())).body.setupEnabled, false)
  assert.equal((await setupPOST(req('/api/setup', { method: 'POST', body: {} }))).status, 503)
  process.env.SETUP_CODE = saved
})
