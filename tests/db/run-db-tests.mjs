/**
 * Tests de la base de données sur un VRAI PostgreSQL (paquet embedded-postgres) :
 * schéma, rôles, sécurité RLS, vitrine publique, opérations atomiques, simultanéité.
 *
 *   npm i --no-save embedded-postgres pg && npm run test:db
 */
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const DATA_DIR = `/var/tmp/le-lido-db-test-${process.pid}`
const PORT = 56000 + (process.pid % 1000)

const ME = '11111111-1111-1111-1111-111111111111' // vous (premier principal)
const LIDO = '22222222-2222-2222-2222-222222222222' // compte du cinéma (invité)
const EMPLOYEE = '33333333-3333-3333-3333-333333333333' // administrateur ordinaire
const STRANGER = '44444444-4444-4444-4444-444444444444' // compte sans droits

let passed = 0
let failed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    failures.push(`${name} → ${err.message}`)
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function as(c, who) {
  await c.query('reset role')
  if (who === 'owner-db') return
  if (who === 'anon') {
    await c.query(`select set_config('request.jwt.claims', '', false)`)
    await c.query('set role anon')
    return
  }
  if (who === 'service') {
    await c.query(`select set_config('request.jwt.claims', '', false)`)
    await c.query('set role service_role')
    return
  }
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: who, role: 'authenticated' })])
  await c.query('set role authenticated')
}
async function expectError(p, codeOrText) {
  try {
    await p
  } catch (err) {
    if (err.code === codeOrText || err.message?.includes(codeOrText)) return
    throw new Error(`Erreur inattendue : ${err.code} ${err.message}`, { cause: err })
  }
  throw new Error(`Une erreur « ${codeOrText} » était attendue`)
}

const server = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: 'postgres', password: 'test', port: PORT, persistent: false, onLog: () => {}, onError: () => {} })
rmSync(DATA_DIR, { recursive: true, force: true })
await server.initialise()
await server.start()
const cfg = { host: 'localhost', port: PORT, user: 'postgres', password: 'test', database: 'postgres' }
const c = new pg.Client(cfg)
await c.connect()

try {
  console.log('\nInstallation')
  await c.query(readFileSync(join(here, 'supabase-stubs.sql'), 'utf8'))
  await c.query('grant usage on schema public to service_role')
  const schema = readFileSync(join(root, 'supabase/01_schema.sql'), 'utf8')
  const storage = readFileSync(join(root, 'supabase/02_storage.sql'), 'utf8')
  await c.query(schema)
  await c.query(storage)
  await c.query(schema) // rejouable
  await c.query(storage)
  console.log('  ✓ scripts appliqués deux fois sans erreur')

  for (const [id, email] of [[ME, 'moi@exemple.fr'], [LIDO, 'contact@lido.example'], [EMPLOYEE, 'employe@lido.example'], [STRANGER, 'inconnu@exemple.fr']]) {
    await c.query('insert into auth.users (id, email) values ($1, $2)', [id, email])
  }
  const fmt = (await c.query('select id, code from public.formats order by sort_order')).rows
  const SMALL = fmt.find((r) => r.code === 'small').id
  const LARGE = fmt.find((r) => r.code === 'large').id

  // ─────────────────────────────────────────────────────────────────
  console.log('\nTest 1 — Initialisation du premier administrateur')
  await as(c, 'anon')
  await test('avant initialisation : is_initialized() = false (visible du public)', async () => {
    assert((await c.query('select public.is_initialized() i')).rows[0].i === false, 'devrait être false')
  })
  await test('un visiteur ne peut pas s\'initialiser lui-même', () =>
    expectError(c.query('select public.bootstrap_first_owner($1, $2)', [STRANGER, 'x@x.fr']), '42501'))
  await as(c, STRANGER)
  await test('un compte connecté ne peut pas s\'initialiser non plus', () =>
    expectError(c.query('select public.bootstrap_first_owner($1, $2)', [STRANGER, 'x@x.fr']), '42501'))
  await as(c, 'service')
  await test('clé serveur : création du principal avec votre adresse', async () => {
    await c.query('select public.bootstrap_first_owner($1, $2, $3)', [ME, 'Moi@Exemple.fr', 'Matthias'])
  })
  await test('une seconde initialisation est refusée', () =>
    expectError(c.query('select public.bootstrap_first_owner($1, $2)', [STRANGER, 'x@x.fr']), 'déjà initialisée'))
  await as(c, ME)
  await test('vous êtes principal actif', async () => {
    const r = (await c.query('select * from public.my_admin_profile()')).rows[0]
    assert(r.role === 'owner' && r.status === 'active' && r.email === 'moi@exemple.fr', JSON.stringify(r))
    assert((await c.query('select public.is_owner() o')).rows[0].o === true, 'is_owner')
  })

  // ─────────────────────────────────────────────────────────────────
  console.log('\nVisiteur anonyme (Test 12)')
  await as(c, 'anon')
  for (const t of ['stocks', 'stock_movements', 'locations', 'films', 'poster_visuals', 'app_settings', 'admin_profiles', 'prices', 'formats']) {
    await test(`ne peut pas lire public.${t}`, () => expectError(c.query(`select * from public.${t}`), '42501'))
  }
  await test('ne peut pas modifier le stock (adjust_stock)', () =>
    expectError(c.query(`select public.adjust_stock(gen_random_uuid(), 1, gen_random_uuid(), 1, 'sale')`), '42501'))
  await test('ne peut pas appeler la fonction interne', () =>
    expectError(c.query(`select public._apply_stock_delta(gen_random_uuid(), 1, gen_random_uuid(), 1, 'sale', null)`), '42501'))
  await test('ne peut pas lire son profil ni inviter', () =>
    expectError(c.query(`select public.admin_record_invitation(gen_random_uuid(), 'a@b.fr')`), '42501'))
  await test('ne peut pas déposer de fichier', () =>
    expectError(c.query(`insert into storage.objects (bucket_id, name) values ('posters', 'x.jpg')`), 'row-level security'))

  // ─────────────────────────────────────────────────────────────────
  console.log('\nTest 2 — Invitation du cinéma et d\'un employé')
  await as(c, ME)
  await test('invitation du Lido (statut « invité »)', async () => {
    const r = await c.query(`select public.admin_record_invitation($1, $2) s`, [LIDO, 'Contact@Lido.example'])
    assert(r.rows[0].s === 'invited', r.rows[0].s)
  })
  await test('renvoi d\'invitation : même ligne, date mise à jour', async () => {
    const r = await c.query(`select public.admin_record_invitation($1, $2) s`, [LIDO, 'contact@lido.example'])
    assert(r.rows[0].s === 'invited', 'statut')
    assert((await c.query('select count(*)::int n from public.admin_profiles')).rows[0].n === 2, 'doublon')
  })
  await c.query(`select public.admin_record_invitation($1, $2)`, [EMPLOYEE, 'employe@lido.example'])
  await as(c, LIDO)
  await test('invité non activé : aucun droit', async () => {
    assert((await c.query('select public.is_admin() a')).rows[0].a === false, 'is_admin devrait être false')
    assert((await c.query('select * from public.films')).rowCount === 0, 'voit des films')
  })
  await test('le rôle principal est refusé tant que le compte n\'est pas activé', async () => {
    await as(c, ME)
    await expectError(c.query(`select public.transfer_ownership($1)`, [LIDO]), 'accepter son invitation')
    await expectError(c.query(`select public.admin_set_role($1, 'owner')`, [LIDO]), 'activé')
  })
  await as(c, LIDO)
  await test('activation par l\'invité', async () => {
    const r = await c.query('select public.activate_my_account() s')
    assert(r.rows[0].s === 'active', r.rows[0].s)
    assert((await c.query('select public.is_admin() a')).rows[0].a === true, 'is_admin')
    assert((await c.query('select public.is_owner() o')).rows[0].o === false, 'ne doit pas être principal')
  })
  await as(c, EMPLOYEE)
  await c.query('select public.activate_my_account()')
  await as(c, STRANGER)
  await test('compte non invité : activation impossible', () => expectError(c.query('select public.activate_my_account()'), '42501'))
  await test('compte non invité : aucune donnée visible', async () => {
    assert((await c.query('select * from public.stocks')).rowCount === 0, 'stocks visibles')
  })

  // ─────────────────────────────────────────────────────────────────
  console.log('\nAdministrateur ordinaire (Test 12)')
  await as(c, EMPLOYEE)
  await test('ne peut pas s\'attribuer le rôle principal (RPC)', () => expectError(c.query(`select public.admin_set_role($1, 'owner')`, [EMPLOYEE]), '42501'))
  await test('ne peut pas modifier admin_profiles directement', () =>
    expectError(c.query(`update public.admin_profiles set role = 'owner' where user_id = $1`, [EMPLOYEE]), '42501'))
  await test('ne peut pas s\'insérer un second profil', () =>
    expectError(c.query(`insert into public.admin_profiles (user_id, email, role, status) values ($1, 'x@x.fr', 'owner', 'active')`, [STRANGER]), '42501'))
  await test('ne peut pas transférer la propriété', () => expectError(c.query(`select public.transfer_ownership($1)`, [EMPLOYEE]), '42501'))
  await test('ne peut pas inviter', () => expectError(c.query(`select public.admin_record_invitation($1, 'x@x.fr')`, [STRANGER]), '42501'))
  await test('ne peut pas retirer ni désactiver le principal', async () => {
    await expectError(c.query(`select public.admin_remove($1)`, [ME]), '42501')
    await expectError(c.query(`select public.admin_set_status($1, false)`, [ME]), '42501')
  })
  await test('ne voit que son propre profil', async () => {
    const r = await c.query('select user_id from public.admin_profiles')
    assert(r.rowCount === 1 && r.rows[0].user_id === EMPLOYEE, JSON.stringify(r.rows))
  })
  await test('ne peut pas modifier les réglages généraux', async () => {
    const r = await c.query(`update public.app_settings set catalog_name = 'Piraté'`)
    assert(r.rowCount === 0, 'réglages modifiés')
  })
  await test('peut modifier son nom affiché', async () => {
    await c.query(`select public.update_my_display_name('Julie (caisse)')`)
    assert((await c.query('select display_name from public.my_admin_profile()')).rows[0].display_name === 'Julie (caisse)', 'nom')
  })

  // ─────────────────────────────────────────────────────────────────
  console.log('\nTests 4 à 6 — Affiches, visuels, stocks')
  await as(c, EMPLOYEE)
  const locA = (await c.query(`insert into public.locations (name) values ('Réserve A') returning id`)).rows[0].id
  const locB = (await c.query(`insert into public.locations (name) values ('Carton 2') returning id`)).rows[0].id
  const film = { tmdb_id: 157336, title: 'Interstellar', original_title: 'Interstellar', release_date: '2014-11-05', release_year: 2014, genres: ['Science-Fiction'], director: 'Christopher Nolan' }
  const create = async (p) => (await c.query('select public.create_poster($1::jsonb) r', [JSON.stringify(p)])).rows[0].r
  let vA, vB, filmId
  await test('création visuel A (petit 4 en Réserve A, grand 2 en Carton 2)', async () => {
    const r = await create({ film, visual: { source: 'tmdb', tmdb_file_path: '/a.jpg', label: 'Affiche FR' },
      stock: [{ format_id: SMALL, location_id: locA, quantity: 4 }, { format_id: LARGE, location_id: locB, quantity: 2 }] })
    assert(r.status === 'created', JSON.stringify(r))
    vA = r.visual_id
    filmId = r.film_id
  })
  await test('visuel déjà enregistré → « duplicate », pas de doublon ni de stock ajouté', async () => {
    const r = await create({ film, visual: { source: 'tmdb', tmdb_file_path: '/a.jpg' }, stock: [{ format_id: SMALL, location_id: locA, quantity: 9 }] })
    assert(r.status === 'duplicate' && r.visual_id === vA, JSON.stringify(r))
    assert((await c.query('select sum(quantity)::int s from public.stocks where visual_id = $1', [vA])).rows[0].s === 6, 'stock modifié')
  })
  await test('visuel B du même film : fiche film réutilisée, stocks indépendants', async () => {
    const r = await create({ film: { id: filmId, title: 'x' }, visual: { source: 'tmdb', tmdb_file_path: '/b.jpg', label: 'Teaser' },
      stock: [{ format_id: LARGE, location_id: locA, quantity: 3 }], prices: [{ format_id: LARGE, price_cents: 1500 }] })
    vB = r.visual_id
    assert(r.film_id === filmId, 'nouveau film créé')
    assert((await c.query('select count(*)::int n from public.films')).rows[0].n === 1, 'films')
    const q = await c.query('select visual_id, format_id, sum(quantity)::int q from public.stocks group by 1, 2')
    const m = Object.fromEntries(q.rows.map((x) => [`${x.visual_id === vA ? 'A' : 'B'}:${x.format_id === SMALL ? 'P' : 'G'}`, x.q]))
    assert(m['A:P'] === 4 && m['A:G'] === 2 && m['B:G'] === 3 && m['B:P'] === undefined, JSON.stringify(m))
  })
  await test('Test 5 : film absent de TMDB + photo personnelle', async () => {
    const r = await create({ film: { title: 'Ève et le cinéma', release_year: 1987 }, visual: { source: 'photo', image_path: 'visuals/x/full.jpg', thumb_path: 'visuals/x/thumb.jpg' },
      stock: [{ format_id: SMALL, location_id: locB, quantity: 1 }] })
    assert(r.status === 'created', JSON.stringify(r))
  })
  await test('quantité sans emplacement refusée', () =>
    expectError(create({ film: { id: filmId, title: 'x' }, visual: { source: 'photo', image_path: 'p.jpg' }, stock: [{ format_id: SMALL, quantity: 1 }] }), 'emplacement'))
  await test('historique : auteur enregistré (nom + e-mail)', async () => {
    const r = (await c.query('select actor_id, actor_name, actor_email, reason from public.stock_movements where visual_id = $1 order by id limit 1', [vA])).rows[0]
    assert(r.actor_id === EMPLOYEE && r.actor_name === 'Julie (caisse)' && r.actor_email === 'employe@lido.example' && r.reason === 'stock_in', JSON.stringify(r))
  })

  // ─────────────────────────────────────────────────────────────────
  console.log('\nVitrine publique')
  const catalog = async () => {
    await as(c, 'anon')
    const r = (await c.query('select * from public.get_public_catalog()')).rows
    await as(c, EMPLOYEE)
    return r
  }
  await test('aucune quantité, aucun emplacement, aucun compte exposé', async () => {
    const json = JSON.stringify(await catalog())
    assert(!/quantity|location|Réserve|Carton|actor|@/i.test(json), 'information privée exposée')
  })
  await test('formats et prix par visuel', async () => {
    await as(c, EMPLOYEE)
    await c.query('update public.formats set default_price_cents = 800 where id = $1', [SMALL])
    const rows = await catalog()
    const a = rows.find((r) => r.visual_id === vA)
    const b = rows.find((r) => r.visual_id === vB)
    assert(a.formats.map((f) => f.code).join() === 'small,large', JSON.stringify(a.formats))
    assert(a.formats[0].price_cents === 800 && a.formats[1].price_cents === null, 'prix A')
    assert(b.formats.length === 1 && b.formats[0].price_cents === 1500, 'prix B')
  })

  // ─────────────────────────────────────────────────────────────────
  console.log('\nTests 7 à 10 — Vente, rupture, retour, déplacement')
  await as(c, EMPLOYEE)
  await test('Test 7 : vente −1 au bon format et emplacement + historique', async () => {
    const q = (await c.query(`select public.adjust_stock($1, $2, $3, -1, 'sale', 'Client') q`, [vA, SMALL, locA])).rows[0].q
    assert(q === 3, `reste ${q}`)
    const m = (await c.query('select * from public.stock_movements order by id desc limit 1')).rows[0]
    assert(m.quantity_before === 4 && m.delta === -1 && m.quantity_after === 3 && m.reason === 'sale' && m.location_name === 'Réserve A' && m.format_label === 'Petit format', JSON.stringify(m))
  })
  await test('jamais de stock négatif (refus, aucune trace)', async () => {
    const n1 = (await c.query('select count(*)::int n from public.stock_movements')).rows[0].n
    await expectError(c.query(`select public.adjust_stock($1, $2, $3, -50, 'sale')`, [vA, SMALL, locA]), '23514')
    assert((await c.query('select count(*)::int n from public.stock_movements')).rows[0].n === n1, 'trace créée')
  })
  await test('Test 8 : dernier exemplaire → disparaît de la vitrine, reste en admin', async () => {
    await c.query(`select public.adjust_stock($1, $2, $3, -3, 'sale')`, [vB, LARGE, locA])
    assert(!(await catalog()).some((r) => r.visual_id === vB), 'encore visible')
    assert((await c.query('select status from public.poster_visuals where id = $1', [vB])).rows[0].status === 'published', 'statut changé')
  })
  await test('Test 9 : retour en stock → réapparaît', async () => {
    await c.query(`select public.adjust_stock($1, $2, $3, 2, 'return')`, [vB, LARGE, locA])
    assert((await catalog()).some((r) => r.visual_id === vB), 'non réapparu')
  })
  await test('masquée : invisible même en stock ; archivée : historique conservé', async () => {
    await c.query(`update public.poster_visuals set status = 'hidden' where id = $1`, [vB])
    assert(!(await catalog()).some((r) => r.visual_id === vB), 'masquée visible')
    await c.query(`update public.poster_visuals set status = 'archived' where id = $1`, [vB])
    assert((await c.query('select count(*)::int n from public.stock_movements where visual_id = $1', [vB])).rows[0].n > 0, 'historique perdu')
    await c.query(`update public.poster_visuals set status = 'published' where id = $1`, [vB])
  })
  await test('réservation interne déduit le stock', async () => {
    const q = (await c.query(`select public.adjust_stock($1, $2, $3, -1, 'internal_reservation', 'M. Martin') q`, [vB, LARGE, locA])).rows[0].q
    assert(q === 1, `reste ${q}`)
  })
  await test('le motif « transfert » est réservé à la fonction de déplacement', () =>
    expectError(c.query(`select public.adjust_stock($1, $2, $3, 1, 'transfer')`, [vA, SMALL, locA]), 'déplacement'))
  await test('Test 10 : déplacer 3 affiches de Réserve A vers Carton 2, total inchangé', async () => {
    const before = (await c.query('select sum(quantity)::int s from public.stocks where visual_id = $1 and format_id = $2', [vA, SMALL])).rows[0].s
    await c.query('select public.transfer_stock($1, $2, $3, $4, 3)', [vA, SMALL, locA, locB])
    const r = await c.query('select location_id, quantity from public.stocks where visual_id = $1 and format_id = $2', [vA, SMALL])
    const m = Object.fromEntries(r.rows.map((x) => [x.location_id === locA ? 'A' : 'B', x.quantity]))
    const after = r.rows.reduce((s, x) => s + x.quantity, 0)
    assert(m.A === 0 && m.B === 3 && before === after, JSON.stringify({ m, before, after }))
    const mv = (await c.query(`select reason, delta, note from public.stock_movements where reason = 'transfer' order by id`)).rows
    assert(mv.length === 2 && mv[0].delta === -3 && mv[1].delta === 3 && mv[0].note === 'vers Carton 2', JSON.stringify(mv))
  })
  await test('déplacer plus que le stock : refusé, rien ne bouge', () =>
    expectError(c.query('select public.transfer_stock($1, $2, $3, $4, 5)', [vA, SMALL, locA, locB]), '23514'))
  await test('correction d\'inventaire (quantité exacte)', async () => {
    const q = (await c.query('select public.set_stock_quantity($1, $2, $3, 7) q', [vA, LARGE, locB])).rows[0].q
    const m = (await c.query('select delta, reason from public.stock_movements order by id desc limit 1')).rows[0]
    assert(q === 7 && m.delta === 5 && m.reason === 'inventory_correction', JSON.stringify(m))
  })
  await test('stock et historique non modifiables directement', async () => {
    await expectError(c.query('update public.stocks set quantity = 999'), '42501')
    await expectError(c.query('delete from public.stock_movements'), '42501')
    await expectError(c.query('delete from public.poster_visuals where id = $1', [vA]), '42501')
  })
  await test('emplacement utilisé : suppression bloquée', () => expectError(c.query('delete from public.locations where id = $1', [locA]), 'RESTRICT'))

  // ─────────────────────────────────────────────────────────────────
  console.log('\nTest 2 (suite) — Transfert de l\'administration au Lido')
  await as(c, ME)
  await test('le principal voit tous les administrateurs', async () => {
    assert((await c.query('select * from public.admin_profiles')).rowCount === 3, 'liste')
  })
  await test('impossible de se désactiver en étant le dernier principal', () =>
    expectError(c.query('select public.admin_set_status($1, false)', [ME]), 'au moins un administrateur principal'))
  await test('impossible de se retirer en étant le dernier principal', () =>
    expectError(c.query('select public.admin_remove($1)', [ME]), 'au moins un administrateur principal'))
  await test('transfert atomique : Lido principal, vous administrateur', async () => {
    await c.query('select public.transfer_ownership($1)', [LIDO])
    await as(c, 'owner-db')
    const r = Object.fromEntries((await c.query('select user_id, role from public.admin_profiles')).rows.map((x) => [x.user_id, x.role]))
    assert(r[LIDO] === 'owner' && r[ME] === 'admin', JSON.stringify(r))
    await as(c, ME)
  })
  await test('après transfert, vous ne pouvez plus gérer les administrateurs', () =>
    expectError(c.query('select public.admin_set_role($1, \'owner\')', [ME]), '42501'))
  await as(c, LIDO)
  await test('le Lido désactive votre compte : données intactes', async () => {
    const before = (await c.query('select (select count(*) from public.films) f, (select count(*) from public.poster_visuals) v, (select count(*) from public.stock_movements) m, (select sum(quantity) from public.stocks) q')).rows[0]
    await c.query('select public.admin_set_status($1, false)', [ME])
    const after = (await c.query('select (select count(*) from public.films) f, (select count(*) from public.poster_visuals) v, (select count(*) from public.stock_movements) m, (select sum(quantity) from public.stocks) q')).rows[0]
    assert(JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }))
  })
  await as(c, ME)
  await test('compte désactivé : accès révoqué immédiatement', async () => {
    assert((await c.query('select public.is_admin() a')).rows[0].a === false, 'toujours admin')
    assert((await c.query('select * from public.stocks')).rowCount === 0, 'voit le stock')
    await expectError(c.query(`select public.adjust_stock($1, $2, $3, 1, 'stock_in')`, [vA, SMALL, locA]), '42501')
    const p = (await c.query('select status from public.my_admin_profile()')).rows[0]
    assert(p.status === 'disabled', 'statut')
  })
  await as(c, LIDO)
  await test('l\'historique garde votre nom après désactivation', async () => {
    assert((await c.query(`select count(*)::int n from public.stock_movements where actor_email = 'employe@lido.example'`)).rows[0].n > 0, 'auteur perdu')
  })
  await test('réactivation possible', async () => {
    const s = (await c.query('select public.admin_set_status($1, true) s', [ME])).rows[0].s
    assert(s === 'active', s)
  })
  await test('deux principaux puis retrait : toujours au moins un principal', async () => {
    await c.query(`select public.admin_set_role($1, 'owner')`, [ME])
    await c.query(`select public.admin_set_role($1, 'admin')`, [LIDO])
    await as(c, ME)
    await expectError(c.query(`select public.admin_set_role($1, 'admin')`, [ME]), 'au moins un administrateur principal')
    await c.query('select public.transfer_ownership($1)', [LIDO])
  })

  // ─────────────────────────────────────────────────────────────────
  console.log('\nTest 13 — Simultanéité (2 connexions, 50 ventes pour 30 exemplaires + déplacements croisés)')
  await as(c, LIDO)
  await c.query(`select public.set_stock_quantity($1, $2, $3, 30)`, [vA, LARGE, locA])
  await c.query(`select public.set_stock_quantity($1, $2, $3, 20)`, [vA, LARGE, locB])
  const startId = (await c.query('select max(id)::int m from public.stock_movements')).rows[0].m
  const c1 = new pg.Client(cfg)
  const c2 = new pg.Client(cfg)
  await c1.connect()
  await c2.connect()
  await as(c1, LIDO)
  await as(c2, EMPLOYEE)
  let ok = 0
  let refused = 0
  const sell = async (cl) => {
    for (let i = 0; i < 25; i++) {
      try {
        await cl.query(`select public.adjust_stock($1, $2, $3, -1, 'sale')`, [vA, LARGE, locA])
        ok++
      } catch (e) {
        if (e.code === '23514') refused++
        else throw e
      }
    }
  }
  const shuffle = async (cl, from, to) => {
    for (let i = 0; i < 10; i++) await cl.query('select public.transfer_stock($1, $2, $3, $4, 1)', [vA, SMALL, from, to]).catch((e) => { if (e.code !== '23514') throw e })
  }
  await c.query(`select public.set_stock_quantity($1, $2, $3, 10)`, [vA, SMALL, locA])
  await c.query(`select public.set_stock_quantity($1, $2, $3, 10)`, [vA, SMALL, locB])
  await Promise.all([sell(c1), sell(c2), shuffle(c1, locA, locB), shuffle(c2, locB, locA)])
  await c1.end()
  await c2.end()
  await test('exactement 30 ventes acceptées et 20 refusées', async () => assert(ok === 30 && refused === 20, `acceptées ${ok}, refusées ${refused}`))
  await test('stock final grand format Réserve A = 0', async () => {
    assert((await c.query('select quantity from public.stocks where visual_id = $1 and format_id = $2 and location_id = $3', [vA, LARGE, locA])).rows[0].quantity === 0, 'stock')
  })
  await test('déplacements croisés : total petit format conservé (20)', async () => {
    assert((await c.query('select sum(quantity)::int s from public.stocks where visual_id = $1 and format_id = $2', [vA, SMALL])).rows[0].s === 20, 'total')
  })
  await test('historique des ventes chaîné sans trou', async () => {
    const r = (await c.query(`select quantity_before b, quantity_after a from public.stock_movements where id > $1 and format_id = $2 and location_id = $3 and reason = 'sale' order by id`, [startId, LARGE, locA])).rows
    let exp = 30
    for (const m of r) {
      assert(m.b === exp && m.a === exp - 1, JSON.stringify(m))
      exp--
    }
    assert(r.length === 30, `${r.length} lignes`)
  })
} finally {
  await c.end().catch(() => {})
  await server.stop()
  rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n${passed} réussis, ${failed} échoués`)
if (failed) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'))
  process.exit(1)
}
