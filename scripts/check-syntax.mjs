// Vérifie la syntaxe du JavaScript contenu dans index.html et des fonctions /api.
//   npm run check
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const htmlText = readFileSync(join(root, 'index.html'), 'utf8')
const scripts = [...htmlText.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1])
if (scripts.length !== 1) throw new Error(`1 script module attendu, ${scripts.length} trouvé(s)`)
const dir = mkdtempSync(join(tmpdir(), 'ca-check-'))
const file = join(dir, 'app.mjs')
writeFileSync(file, scripts[0])
execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
console.log('✓ index.html : JavaScript valide')
for (const f of readdirSync(join(root, 'api'))) if (f.endsWith('.js')) { execFileSync(process.execPath, ['--check', join(root, 'api', f)], { stdio: 'inherit' }); console.log(`✓ api/${f}`) }
execFileSync(process.execPath, ['--check', join(root, 'api/_lib/supabase.js')], { stdio: 'inherit' })
console.log('✓ api/_lib/supabase.js')
