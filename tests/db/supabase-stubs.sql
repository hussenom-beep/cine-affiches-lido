-- Reproduction minimale de l'environnement Supabase pour les tests locaux :
-- rôles anon/authenticated, schéma auth avec auth.uid(), schéma storage.
-- (Sur Supabase, tout ceci existe déjà : ce fichier n'est utilisé QUE par les tests.)

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Comme sur Supabase : droits par défaut larges, la sécurité repose sur RLS.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text unique);

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
