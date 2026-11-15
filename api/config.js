// GET /api/config — paramètres PUBLICS nécessaires au navigateur.
// La clé « anon » de Supabase est publique par conception : la sécurité repose
// sur les règles Row Level Security de la base. Aucune clé secrète n'est renvoyée ici.
import { env, json } from './_lib/supabase.js'

export function GET() {
  const supabaseUrl = env('SUPABASE_URL', '').replace(/\/+$/, '')
  const supabaseAnonKey = env('SUPABASE_ANON_KEY', '')
  return json(
    { configured: Boolean(supabaseUrl && supabaseAnonKey), supabaseUrl, supabaseAnonKey },
    200,
    { 'cache-control': 'public, max-age=60, s-maxage=300' },
  )
}
