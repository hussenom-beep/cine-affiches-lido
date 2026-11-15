-- ═══════════════════════════════════════════════════════════════════════
--  CINÉ AFFICHES — LE LIDO
--  Fichier 2/2 : espace de stockage des photos d'affiches et du logo
--
--  À exécuter APRÈS 01_schema.sql, dans Supabase → SQL Editor.
--
--  Bucket « posters » :
--   • lecture par URL publique (les photos sont affichées dans la vitrine ;
--     les noms de fichiers sont aléatoires et ne peuvent pas être listés)
--   • envoi, remplacement, suppression, listage : administrateurs actifs uniquement
--   • 5 Mo maximum par fichier, images JPEG / PNG / WebP uniquement
-- ═══════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('posters', 'posters', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists posters_admin_select on storage.objects;
create policy posters_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'posters' and public.is_admin());

drop policy if exists posters_admin_insert on storage.objects;
create policy posters_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'posters' and public.is_admin());

drop policy if exists posters_admin_update on storage.objects;
create policy posters_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'posters' and public.is_admin()) with check (bucket_id = 'posters' and public.is_admin());

drop policy if exists posters_admin_delete on storage.objects;
create policy posters_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'posters' and public.is_admin());
