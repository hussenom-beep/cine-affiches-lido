import { test } from 'node:test'
import assert from 'node:assert/strict'
import { L } from './load-logic.mjs'

const SMALL = { id: 1, code: 'small', label: 'Petit format', default_price_cents: 800, sort_order: 1, is_active: true }
const LARGE = { id: 2, code: 'large', label: 'Grand format', default_price_cents: null, sort_order: 2, is_active: true }
const RA = { id: 'la', name: 'Réserve A', sort_order: 0, is_active: true }
const C2 = { id: 'lb', name: 'Carton 2', sort_order: 1, is_active: true }
const film = (o = {}) => ({ id: 'f1', tmdb_id: 1, title: 'Interstellar', original_title: 'Interstellar', release_year: 2014, ...o })
const vis = (id, f, stocks, o = {}) => ({ id, film_id: f.id, film: f, reference_code: `AF-${id}`, label: null, status: 'published', prices: [],
  stocks: stocks.map(([format_id, location_id, quantity], i) => ({ id: `${id}${i}`, visual_id: id, format_id, location_id, quantity })), ...o })
const pub = (o) => ({ visual_id: 'v', film_id: 'f', title: 'T', original_title: null, release_date: null, release_year: null, label: null, added_at: '2026-01-01', formats: [{ format_id: 1, code: 'small', label: 'Petit format', price_cents: null }], ...o })

test('recherche : partielle, accents, majuscules', () => {
  assert.equal(L.normalize('  Ève  ET le CINÉMA '), 'eve et le cinema')
  assert.ok(L.matchesQuery('Super Mario Bros. le film 2023', 'MARIO'))
  assert.ok(L.matchesQuery('Super Mario Bros. le film 2023', 'mario 2023'))
  assert.ok(!L.matchesQuery('Super Mario Bros. le film 2023', 'mario 2019'))
  assert.ok(L.matchesQuery('Le Fabuleux Destin d’Amélie Poulain', "d'amelie"))
  assert.ok(L.matchesQuery('Cœur de pirate', 'coeur'))
})

const items = [
  pub({ visual_id: 'a', film_id: 'mario', title: 'Super Mario Bros. le film', original_title: 'The Super Mario Bros. Movie', release_date: '2023-04-05', release_year: 2023, added_at: '2026-03-01' }),
  pub({ visual_id: 'b', film_id: 'mario', title: 'Super Mario Bros. le film', label: 'Teaser', release_date: '2023-04-05', release_year: 2023, added_at: '2026-05-01', formats: [{ format_id: 2, code: 'large', label: 'Grand format', price_cents: 1200 }] }),
  pub({ visual_id: 'c', film_id: 'amelie', title: 'Le Fabuleux Destin d’Amélie Poulain', release_date: '2001-04-25', release_year: 2001, added_at: '2026-01-01' }),
  pub({ visual_id: 'd', film_id: 'eve', title: 'Ève', added_at: '2026-02-01' }),
]
const ids = (l) => l.map((v) => v.visual_id)
test('vitrine : recherche titre français / original / année', () => {
  assert.deepEqual(ids(L.filterCatalog(items, { query: 'mario' })), ['a', 'b'])
  assert.deepEqual(ids(L.filterCatalog(items, { query: 'movie' })), ['a'])
  assert.deepEqual(ids(L.filterCatalog(items, { query: '2001' })), ['c'])
})
test('vitrine : filtre format combiné à la recherche et au tri', () => {
  assert.deepEqual(ids(L.filterCatalog(items, { query: 'mario', format: 'large' })), ['b'])
  assert.equal(L.filterCatalog(items, { format: 'small' }).length, 3)
})
test('vitrine : 5 tris', () => {
  assert.deepEqual(ids(L.filterCatalog(items, { sort: 'title-asc' })), ['d', 'c', 'a', 'b'])
  assert.deepEqual(ids(L.filterCatalog(items, { sort: 'title-desc' })), ['b', 'a', 'c', 'd'])
  assert.deepEqual(ids(L.filterCatalog(items, { sort: 'release-desc' })).slice(0, 3), ['a', 'b', 'c'])
  assert.deepEqual(ids(L.filterCatalog(items, { sort: 'release-asc' })), ['c', 'a', 'b', 'd'])
  assert.deepEqual(ids(L.filterCatalog(items, { sort: 'added-desc' })), ['b', 'a', 'd', 'c'])
  assert.deepEqual(ids(L.recentlyAdded(items, 2)), ['b', 'a'])
  assert.deepEqual(ids(L.otherVisualsOfFilm(items, items[0])), ['b'])
  assert.deepEqual(L.catalogFormats(items).map((f) => f.code), ['small', 'large'])
})

const I = film(), D = film({ id: 'f2', title: 'Dune', original_title: null, release_year: 2024 })
const A = vis('A', I, [[1, 'la', 4], [2, 'la', 2]], { label: 'Affiche FR' })
const B = vis('B', I, [[1, 'la', 0], [2, 'lb', 3]], { prices: [{ format_id: 2, price_cents: 1500 }] })
const C = vis('C', D, [])
const H = vis('H', film({ id: 'f3', title: 'Masquée', original_title: null }), [[1, 'lb', 5]], { status: 'hidden' })
const Z = vis('Z', film({ id: 'f4', title: 'Archivée', original_title: null }), [[1, 'lb', 1]], { status: 'archived' })
const ALL = [A, B, C, H, Z]

test('stocks : visuels et formats jamais mélangés', () => {
  assert.equal(L.totalQuantity(A), 6)
  assert.equal(L.quantityByFormat(A, 1), 4)
  assert.equal(L.quantityByFormat(A, 2), 2)
  assert.equal(L.quantityByFormat(B, 1), 0)
  assert.equal(L.quantityByFormat(B, 2), 3)
})
test('statuts : épuisée calculée, masquée, archivée', () => {
  assert.deepEqual([A, C, H, Z].map(L.availability), ['available', 'soldout', 'hidden', 'archived'])
})
test('rupture puis retour en stock : visibilité publique', () => {
  const active = new Set([1, 2])
  let l = L.applyQuantity([A], 'A', 1, 'la', 0)
  l = L.applyQuantity(l, 'A', 2, 'la', 0)
  assert.equal(L.isPubliclyVisible(l[0], active), false)
  assert.equal(L.availability(l[0]), 'soldout')
  l = L.applyQuantity(l, 'A', 2, 'lb', 2)
  assert.equal(L.isPubliclyVisible(l[0], active), true)
  assert.equal(L.isPubliclyVisible(H, active), false)
})
test('prix : personnalisé sinon défaut', () => {
  assert.equal(L.effectivePrice(A, SMALL), 800)
  assert.equal(L.effectivePrice(A, LARGE), null)
  assert.equal(L.effectivePrice(B, LARGE), 1500)
  assert.equal(L.parsePriceToCents('12,50'), 1250)
  assert.equal(L.parsePriceToCents(' 8 € '), 800)
  assert.equal(L.parsePriceToCents(''), null)
  assert.ok(Number.isNaN(L.parsePriceToCents('-3')))
  assert.equal(L.centsToInput(1250), '12,50')
  assert.equal(L.formatPrice(1250).replace(/\s/g, ' '), '12,50 €')
})
test('tableau de bord', () => {
  assert.deepEqual(L.dashboardStats(ALL), { totalCopies: 14, availableRefs: 3, films: 2, soldOutRefs: 1 })
})
test('recherche administrateur : films, visuels, références, formats, emplacements, statuts', () => {
  const f = (q, o = {}) => L.filterAdminVisuals(ALL, { query: q, ...o }, [SMALL, LARGE], [RA, C2]).map((v) => v.id)
  assert.deepEqual(f('interstel'), ['A', 'B'])
  assert.deepEqual(f('AF-B'), ['B'])
  assert.deepEqual(f('affiche fr'), ['A'])
  assert.deepEqual(f('carton'), ['B', 'H'])
  assert.deepEqual(f('grand format'), ['A', 'B'])
  assert.deepEqual(f('épuisée'), ['C'])
  assert.deepEqual(f('masquee'), ['H'])
  assert.deepEqual(f('', { status: 'all' }).includes('Z'), true)
  assert.deepEqual(f(''), ['C', 'A', 'B', 'H'])
  assert.deepEqual(f('', { locationId: 'lb' }), ['B', 'H'])
  assert.deepEqual(f('', { formatId: 2 }), ['A', 'B'])
})
test('lignes de stock par format puis emplacement', () => {
  const r = L.stockRows([A, B], [SMALL, LARGE], [RA, C2]).map((x) => `${x.visual.id}:${x.format.code}:${x.location.name}:${x.stock.quantity}`)
  assert.deepEqual(r, ['A:small:Réserve A:4', 'A:large:Réserve A:2', 'B:large:Carton 2:3'])
})
test('inventaire : complet / disponibles / emplacement / tri / prix', () => {
  const o = { thumbnails: true, prices: true, sort: 'alpha' }
  const all = L.buildInventoryRows(ALL, [SMALL, LARGE], [RA, C2], { ...o, scope: 'all' })
  assert.equal(all[0].title, 'Dune')
  assert.ok(all.find((r) => r.key === 'C:soldout').soldOut)
  assert.ok(!all.some((r) => r.visualId === 'Z'))
  assert.equal(L.buildInventoryRows(ALL, [SMALL, LARGE], [RA, C2], { ...o, scope: 'available' }).length, 4)
  const loc = L.buildInventoryRows(ALL, [SMALL, LARGE], [RA, C2], { ...o, scope: 'location', locationId: 'lb' })
  assert.deepEqual(loc.map((r) => r.key), ['B:2:lb', 'H:1:lb'])
  assert.equal(loc[0].price, 1500)
  assert.deepEqual(L.buildInventoryRows(ALL, [SMALL, LARGE], [RA, C2], { ...o, scope: 'available', sort: 'location' }).map((r) => r.location), ['Réserve A', 'Réserve A', 'Carton 2', 'Carton 2'])
  assert.ok(L.buildInventoryRows(ALL, [SMALL, LARGE], [RA, C2], { ...o, prices: false, scope: 'all' }).every((r) => r.price === null))
})
test('galerie TMDB : français, sans texte, anglais, autres', () => {
  const p = (l) => ({ file_path: `/${l}.jpg`, iso_639_1: l })
  const g = L.groupPosters([p('de'), p('en'), p(null), p('fr'), p('xx'), p('de'), p('es')])
  assert.equal(g.fr.length, 1); assert.equal(g.none.length, 2); assert.equal(g.en.length, 1)
  assert.deepEqual(g.others.map(([l, list]) => [l, list.length]), [['de', 2], ['es', 1]])
})
test('adresses : vitrine, /espace-interne et pages de compte', () => {
  assert.deepEqual(L.matchRoute('/'), { area: 'public', name: 'catalog', params: {} })
  assert.deepEqual(L.matchRoute('/affiche/abc'), { area: 'public', name: 'catalog', params: { visualId: 'abc' } })
  assert.equal(L.matchRoute('/espace-interne').name, 'dashboard')
  assert.equal(L.matchRoute('/espace-interne/').name, 'dashboard')
  assert.deepEqual(L.matchRoute('/espace-interne/affiche/x-1').params, { id: 'x-1' })
  assert.equal(L.matchRoute('/espace-interne/emplacements/z').name, 'location')
  assert.equal(L.matchRoute('/espace-interne/administrateurs').name, 'admins')
  assert.equal(L.matchRoute('/espace-interne/activation').name, 'activation')
  assert.equal(L.matchRoute('/espace-interne/nouveau-mot-de-passe').name, 'recovery')
  assert.equal(L.matchRoute('/espace-interne/inconnu').redirect, '/espace-interne')
  assert.equal(L.matchRoute('/admin').area, 'public', '/admin n’est pas une adresse d’administration')
})
test('mot de passe et libellés', () => {
  assert.match(L.passwordProblem('court', 'court'), /8 caractères/)
  assert.match(L.passwordProblem('assez-long-1', 'x'), /correspondent/)
  assert.equal(L.passwordProblem('assez-long-1', 'assez-long-1'), null)
  assert.equal(L.languageName('de'), 'Allemand')
  assert.equal(L.defaultVisualLabel('tmdb', 'fr'), 'Affiche française')
  assert.equal(L.REASONS.transfer, "Transfert d'emplacement")
})
