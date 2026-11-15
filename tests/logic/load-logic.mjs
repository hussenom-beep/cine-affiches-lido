// Extrait le bloc « LOGIQUE MÉTIER » d'index.html pour le tester tel quel sous Node.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'index.html'), 'utf8')
const block = src.split('// ==LOGIC-START==')[1].split('// ==LOGIC-END==')[0]
const file = join(mkdtempSync(join(tmpdir(), 'ca-logic-')), 'logic.mjs')
writeFileSync(file, block)
export const L = await import(pathToFileURL(file).href)
