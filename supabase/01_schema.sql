-- ═══════════════════════════════════════════════════════════════════════
--  CINÉ AFFICHES — LE LIDO
--  Fichier 1/2 : tables, fonctions, sécurité (Row Level Security)
--
--  À coller en entier dans Supabase → SQL Editor → « New query » → Run.
--  Le script peut être relancé sans danger (il ne supprime aucune donnée).
-- ═══════════════════════════════════════════════════════════════════════

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- ───────────────────────────────────────────────────────────────────────
-- Types
-- ───────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.visual_status as enum ('published', 'hidden', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.visual_source as enum ('tmdb', 'photo');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.movement_reason as enum (
    'stock_in',              -- Entrée de stock
    'sale',                  -- Vente
    'internal_reservation',  -- Réservation interne
    'return',                -- Retour
    'damaged',               -- Affiche abîmée
    'inventory_correction',  -- Correction d'inventaire
    'transfer',              -- Transfert d'emplacement
    'other'                  -- Autre
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.admin_role as enum ('owner', 'admin');          -- principal / administrateur
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.admin_status as enum ('invited', 'active', 'disabled');
exception when duplicate_object then null; end $$;

-- ───────────────────────────────────────────────────────────────────────
-- Utilitaires
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.normalize_search(t text)
returns text language sql immutable parallel safe set search_path = ''
as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, ''))) $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- ADMINISTRATEURS
-- Un compte Supabase n'a AUCUN droit tant qu'il n'a pas une ligne
-- « active » ici. Il n'existe pas d'inscription publique.
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.admin_profiles (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  email               text not null,
  display_name        text,
  role                public.admin_role   not null default 'admin',
  status              public.admin_status not null default 'invited',
  invited_by          uuid,
  invited_at          timestamptz not null default now(),
  last_invite_sent_at timestamptz,
  activated_at        timestamptz,
  disabled_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists admin_profiles_email_unique on public.admin_profiles (lower(email));

drop trigger if exists admin_profiles_touch on public.admin_profiles;
create trigger admin_profiles_touch before update on public.admin_profiles
  for each row execute function public.touch_updated_at();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admin_profiles where user_id = auth.uid() and status = 'active') $$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admin_profiles where user_id = auth.uid() and status = 'active' and role = 'owner') $$;

create or replace function public.assert_admin()
returns void language plpgsql stable security definer set search_path = ''
as $$ begin
  if not public.is_admin() then
    raise exception 'Accès réservé aux administrateurs actifs.' using errcode = '42501';
  end if;
end $$;

create or replace function public.assert_owner()
returns void language plpgsql stable security definer set search_path = ''
as $$ begin
  if not public.is_owner() then
    raise exception 'Action réservée à l''administrateur principal.' using errcode = '42501';
  end if;
end $$;

-- Garde-fou : il reste toujours au moins un administrateur principal actif.
create or replace function public.ensure_active_owner()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin
  if exists (select 1 from public.admin_profiles)
     and not exists (select 1 from public.admin_profiles where role = 'owner' and status = 'active') then
    raise exception 'Impossible : il doit toujours rester au moins un administrateur principal actif.'
      using errcode = '23514';
  end if;
  return null;
end $$;

drop trigger if exists admin_profiles_keep_owner on public.admin_profiles;
create trigger admin_profiles_keep_owner after update or delete on public.admin_profiles
  for each statement execute function public.ensure_active_owner();

-- Profil de l'utilisateur connecté (même invité ou désactivé : sert à l'affichage)
create or replace function public.my_admin_profile()
returns table (user_id uuid, email text, display_name text, role public.admin_role, status public.admin_status)
language sql stable security definer set search_path = ''
as $$ select user_id, email, display_name, role, status from public.admin_profiles where user_id = auth.uid() $$;

-- Activation par l'invité lui-même, après avoir choisi son mot de passe
create or replace function public.activate_my_account()
returns public.admin_status language plpgsql security definer set search_path = ''
as $$
declare v public.admin_status;
begin
  update public.admin_profiles
     set status = 'active', activated_at = coalesce(activated_at, now())
   where user_id = auth.uid() and status = 'invited'
  returning status into v;
  if v is null then
    select status into v from public.admin_profiles where user_id = auth.uid();
  end if;
  if v is null then
    raise exception 'Aucune invitation pour ce compte.' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function public.update_my_display_name(p_name text)
returns void language plpgsql security definer set search_path = ''
as $$ begin
  perform public.assert_admin();
  update public.admin_profiles set display_name = nullif(btrim(p_name), '') where user_id = auth.uid();
end $$;

-- Enregistre (ou renouvelle) une invitation. Appelée par la fonction serveur
-- /api/admins avec le jeton de l'administrateur principal.
create or replace function public.admin_record_invitation(p_user_id uuid, p_email text, p_role public.admin_role default 'admin')
returns public.admin_status language plpgsql security definer set search_path = ''
as $$
declare v public.admin_status;
begin
  perform public.assert_owner();
  insert into public.admin_profiles (user_id, email, role, status, invited_by, invited_at, last_invite_sent_at)
  values (p_user_id, lower(btrim(p_email)), 'admin', 'invited', auth.uid(), now(), now())
  on conflict (user_id) do update
     set last_invite_sent_at = now()
   where public.admin_profiles.status = 'invited'
  returning status into v;
  if v is null then
    raise exception 'Ce compte est déjà administrateur.' using errcode = '23505';
  end if;
  -- Le rôle principal ne peut être donné qu'à un compte déjà activé (voir admin_set_role).
  return v;
end $$;

create or replace function public.admin_set_role(p_user_id uuid, p_role public.admin_role)
returns void language plpgsql security definer set search_path = ''
as $$
declare v public.admin_profiles%rowtype;
begin
  perform public.assert_owner();
  select * into v from public.admin_profiles where user_id = p_user_id for update;
  if not found then raise exception 'Administrateur introuvable.' using errcode = 'P0002'; end if;
  if p_role = 'owner' and v.status <> 'active' then
    raise exception 'Le compte doit être activé avant de recevoir le rôle principal.' using errcode = '22023';
  end if;
  update public.admin_profiles set role = p_role where user_id = p_user_id;
end $$;

create or replace function public.admin_set_status(p_user_id uuid, p_enabled boolean)
returns public.admin_status language plpgsql security definer set search_path = ''
as $$
declare v public.admin_status;
begin
  perform public.assert_owner();
  update public.admin_profiles
     set status = case when p_enabled then (case when activated_at is null then 'invited' else 'active' end)::public.admin_status
                       else 'disabled'::public.admin_status end,
         disabled_at = case when p_enabled then null else now() end
   where user_id = p_user_id
  returning status into v;
  if v is null then raise exception 'Administrateur introuvable.' using errcode = 'P0002'; end if;
  return v;
end $$;

create or replace function public.admin_remove(p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$ begin
  perform public.assert_owner();
  delete from public.admin_profiles where user_id = p_user_id;
  if not found then raise exception 'Administrateur introuvable.' using errcode = 'P0002'; end if;
end $$;

-- Transfert du rôle principal : atomique (les deux changements ou aucun).
create or replace function public.transfer_ownership(p_user_id uuid, p_keep_me_owner boolean default false)
returns void language plpgsql security definer set search_path = ''
as $$
declare v public.admin_profiles%rowtype;
begin
  perform public.assert_owner();
  if p_user_id = auth.uid() then
    raise exception 'Choisissez un autre administrateur.' using errcode = '22023';
  end if;
  select * into v from public.admin_profiles where user_id = p_user_id for update;
  if not found then raise exception 'Administrateur introuvable.' using errcode = 'P0002'; end if;
  if v.status <> 'active' then
    raise exception 'Ce compte doit d''abord accepter son invitation et se connecter.' using errcode = '22023';
  end if;
  update public.admin_profiles set role = 'owner' where user_id = p_user_id;
  if not p_keep_me_owner then
    update public.admin_profiles set role = 'admin' where user_id = auth.uid();
  end if;
end $$;

-- Première initialisation : réservée à la clé serveur (service_role), une seule fois.
create or replace function public.bootstrap_first_owner(p_user_id uuid, p_email text, p_display_name text default null)
returns void language plpgsql security definer set search_path = ''
as $$ begin
  if exists (select 1 from public.admin_profiles) then
    raise exception 'L''application est déjà initialisée.' using errcode = '42501';
  end if;
  insert into public.admin_profiles (user_id, email, display_name, role, status, activated_at, last_invite_sent_at)
  values (p_user_id, lower(btrim(p_email)), nullif(btrim(p_display_name), ''), 'owner', 'active', now(), null);
end $$;

create or replace function public.is_initialized()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admin_profiles) $$;

-- ═══════════════════════════════════════════════════════════════════════
-- CATALOGUE
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.films (
  id               uuid primary key default gen_random_uuid(),
  tmdb_id          integer unique,
  title            text not null check (length(btrim(title)) > 0),
  original_title   text,
  release_date     date,
  release_year     smallint check (release_year between 1880 and 2200),
  overview         text,
  genres           text[] not null default '{}',
  runtime          integer check (runtime is null or runtime > 0),
  director         text,
  tmdb_poster_path text,
  search_text      text generated always as (
    public.normalize_search(title || ' ' || coalesce(original_title, '') || ' ' || coalesce(release_year::text, ''))
  ) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists films_search_trgm_idx on public.films using gin (search_text extensions.gin_trgm_ops);
drop trigger if exists films_touch on public.films;
create trigger films_touch before update on public.films for each row execute function public.touch_updated_at();

create table if not exists public.formats (
  id                  integer generated always as identity primary key,
  code                text not null unique check (code ~ '^[a-z0-9_-]+$'),
  label               text not null check (length(btrim(label)) > 0),
  default_price_cents integer check (default_price_cents is null or default_price_cents >= 0),
  sort_order          integer not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
insert into public.formats (code, label, sort_order) values ('small', 'Petit format', 1), ('large', 'Grand format', 2)
on conflict (code) do nothing;

create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  notes      text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists locations_name_unique on public.locations (lower(btrim(name)));

create sequence if not exists public.visual_ref_seq;

create table if not exists public.poster_visuals (
  id             uuid primary key default gen_random_uuid(),
  film_id        uuid not null references public.films (id) on delete restrict,
  reference_code text not null unique default ('AF-' || lpad(nextval('public.visual_ref_seq')::text, 4, '0')),
  label          text,
  source         public.visual_source not null,
  tmdb_file_path text,
  tmdb_language  text,
  image_path     text,
  thumb_path     text,
  status         public.visual_status not null default 'published',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint poster_visuals_image_present check (
    (source = 'tmdb' and tmdb_file_path is not null) or (source = 'photo' and image_path is not null)
  )
);
create unique index if not exists poster_visuals_film_tmdb_unique on public.poster_visuals (film_id, tmdb_file_path) where tmdb_file_path is not null;
create index if not exists poster_visuals_film_idx on public.poster_visuals (film_id);
drop trigger if exists poster_visuals_touch on public.poster_visuals;
create trigger poster_visuals_touch before update on public.poster_visuals for each row execute function public.touch_updated_at();

-- Tarifs personnalisés (sinon : prix par défaut du format)
create table if not exists public.prices (
  visual_id   uuid not null references public.poster_visuals (id) on delete cascade,
  format_id   integer not null references public.formats (id) on delete restrict,
  price_cents integer not null check (price_cents >= 0),
  updated_at  timestamptz not null default now(),
  primary key (visual_id, format_id)
);

-- Stock = visuel × format × emplacement
create table if not exists public.stocks (
  id          uuid primary key default gen_random_uuid(),
  visual_id   uuid not null references public.poster_visuals (id) on delete restrict,
  format_id   integer not null references public.formats (id) on delete restrict,
  location_id uuid not null references public.locations (id) on delete restrict,
  quantity    integer not null default 0 check (quantity >= 0),
  updated_at  timestamptz not null default now(),
  unique (visual_id, format_id, location_id)
);
create index if not exists stocks_location_idx on public.stocks (location_id);

-- Historique immuable. Les libellés et l'auteur sont copiés : ils restent lisibles
-- même si un emplacement est renommé ou un administrateur supprimé.
create table if not exists public.stock_movements (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  stock_id        uuid not null references public.stocks (id) on delete restrict,
  visual_id       uuid not null references public.poster_visuals (id) on delete restrict,
  film_id         uuid not null references public.films (id) on delete restrict,
  format_id       integer not null references public.formats (id) on delete restrict,
  location_id     uuid not null references public.locations (id) on delete restrict,
  film_title      text not null,
  visual_ref      text not null,
  visual_label    text,
  format_label    text not null,
  location_name   text not null,
  quantity_before integer not null,
  delta           integer not null,
  quantity_after  integer not null check (quantity_after >= 0),
  reason          public.movement_reason not null,
  note            text,
  actor_id        uuid,
  actor_name      text not null,
  actor_email     text
);
create index if not exists movements_created_idx on public.stock_movements (created_at desc);
create index if not exists movements_visual_idx  on public.stock_movements (visual_id, created_at desc);

create table if not exists public.app_settings (
  id                     boolean primary key default true check (id),
  catalog_name           text not null default 'Ciné Affiches',
  cinema_name            text not null default 'Le Lido',
  tagline                text not null default 'Découvrez les affiches de films disponibles au cinéma.',
  contact_note           text not null default 'Les affiches sont en vente à la caisse du cinéma.',
  logo_path              text,
  accent_color           text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  show_prices            boolean not null default true,
  show_recent            boolean not null default true,
  recent_count           integer not null default 8 check (recent_count between 0 and 24),
  pdf_include_thumbnails boolean not null default true,
  pdf_include_prices     boolean not null default false,
  updated_at             timestamptz not null default now()
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;
drop trigger if exists settings_touch on public.app_settings;
create trigger settings_touch before update on public.app_settings for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- MOUVEMENTS DE STOCK ATOMIQUES
-- Verrou de ligne + mise à jour + historique dans la même transaction.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public._apply_stock_delta(
  p_visual_id uuid, p_format_id integer, p_location_id uuid,
  p_delta integer, p_reason public.movement_reason, p_note text
) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_stock  public.stocks%rowtype;
  v_after  integer;
  v_visual public.poster_visuals%rowtype;
  v_film   text;
  v_format text;
  v_loc    text;
  v_actor  public.admin_profiles%rowtype;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'La quantité doit être différente de zéro.' using errcode = '22023';
  end if;
  select * into v_visual from public.poster_visuals where id = p_visual_id;
  if not found then raise exception 'Affiche introuvable.' using errcode = 'P0002'; end if;
  select label into v_format from public.formats where id = p_format_id;
  if not found then raise exception 'Format introuvable.' using errcode = 'P0002'; end if;
  select name into v_loc from public.locations where id = p_location_id;
  if not found then raise exception 'Emplacement introuvable.' using errcode = 'P0002'; end if;
  select title into v_film from public.films where id = v_visual.film_id;

  insert into public.stocks (visual_id, format_id, location_id, quantity)
  values (p_visual_id, p_format_id, p_location_id, 0)
  on conflict (visual_id, format_id, location_id) do nothing;

  select * into v_stock from public.stocks
   where visual_id = p_visual_id and format_id = p_format_id and location_id = p_location_id
   for update;

  v_after := v_stock.quantity + p_delta;
  if v_after < 0 then
    raise exception 'Stock insuffisant : % exemplaire(s) à cet emplacement.', v_stock.quantity using errcode = '23514';
  end if;

  update public.stocks set quantity = v_after, updated_at = now() where id = v_stock.id;

  select * into v_actor from public.admin_profiles where user_id = auth.uid();
  insert into public.stock_movements (
    stock_id, visual_id, film_id, format_id, location_id,
    film_title, visual_ref, visual_label, format_label, location_name,
    quantity_before, delta, quantity_after, reason, note, actor_id, actor_name, actor_email
  ) values (
    v_stock.id, p_visual_id, v_visual.film_id, p_format_id, p_location_id,
    v_film, v_visual.reference_code, v_visual.label, v_format, v_loc,
    v_stock.quantity, p_delta, v_after, p_reason, nullif(btrim(p_note), ''),
    auth.uid(), coalesce(v_actor.display_name, v_actor.email, 'Administrateur'), v_actor.email
  );
  return v_after;
end $$;

create or replace function public.adjust_stock(
  p_visual_id uuid, p_format_id integer, p_location_id uuid,
  p_delta integer, p_reason public.movement_reason, p_note text default null
) returns integer
language plpgsql security definer set search_path = ''
as $$ begin
  perform public.assert_admin();
  if p_reason = 'transfer' then
    raise exception 'Utilisez la fonction de déplacement.' using errcode = '22023';
  end if;
  return public._apply_stock_delta(p_visual_id, p_format_id, p_location_id, p_delta, p_reason, p_note);
end $$;

create or replace function public.set_stock_quantity(
  p_visual_id uuid, p_format_id integer, p_location_id uuid, p_quantity integer, p_note text default null
) returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_current integer;
begin
  perform public.assert_admin();
  if p_quantity is null or p_quantity < 0 then
    raise exception 'La quantité ne peut pas être négative.' using errcode = '23514';
  end if;
  insert into public.stocks (visual_id, format_id, location_id, quantity)
  values (p_visual_id, p_format_id, p_location_id, 0)
  on conflict (visual_id, format_id, location_id) do nothing;
  select quantity into v_current from public.stocks
   where visual_id = p_visual_id and format_id = p_format_id and location_id = p_location_id for update;
  if v_current = p_quantity then return v_current; end if;
  return public._apply_stock_delta(p_visual_id, p_format_id, p_location_id, p_quantity - v_current, 'inventory_correction', p_note);
end $$;

create or replace function public.transfer_stock(
  p_visual_id uuid, p_format_id integer, p_from_location_id uuid, p_to_location_id uuid,
  p_quantity integer, p_note text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_from text; v_to text;
begin
  perform public.assert_admin();
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La quantité à déplacer doit être positive.' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'Choisissez un emplacement différent.' using errcode = '22023';
  end if;
  select name into v_from from public.locations where id = p_from_location_id;
  select name into v_to from public.locations where id = p_to_location_id;
  if v_to is null or v_from is null then raise exception 'Emplacement introuvable.' using errcode = 'P0002'; end if;
  -- Verrouillage dans un ordre stable pour éviter tout interblocage entre deux appareils
  perform 1 from public.stocks
   where visual_id = p_visual_id and format_id = p_format_id and location_id in (p_from_location_id, p_to_location_id)
   order by location_id for update;
  perform public._apply_stock_delta(p_visual_id, p_format_id, p_from_location_id, -p_quantity, 'transfer',
    coalesce(nullif(btrim(p_note), '') || ' — ', '') || 'vers ' || v_to);
  perform public._apply_stock_delta(p_visual_id, p_format_id, p_to_location_id, p_quantity, 'transfer',
    coalesce(nullif(btrim(p_note), '') || ' — ', '') || 'depuis ' || v_from);
end $$;

-- Création d'une affiche en une transaction : film (réutilisé) + visuel + prix + stocks.
-- p.stock = [{format_id, location_id, quantity}] (plusieurs emplacements possibles)
create or replace function public.create_poster(p jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_film      jsonb := p -> 'film';
  v_visual    jsonb := p -> 'visual';
  v_film_id   uuid;
  v_visual_id uuid;
  v_item      jsonb;
  v_qty       integer;
  v_tmdb_path text := nullif(v_visual ->> 'tmdb_file_path', '');
  v_genres    text[];
begin
  perform public.assert_admin();
  if v_film is null or v_visual is null then raise exception 'Données incomplètes.' using errcode = '22023'; end if;

  select coalesce(array_agg(g), '{}') into v_genres from jsonb_array_elements_text(coalesce(v_film -> 'genres', '[]'::jsonb)) g;

  if nullif(v_film ->> 'id', '') is not null then
    v_film_id := (v_film ->> 'id')::uuid;
    perform 1 from public.films where id = v_film_id;
    if not found then raise exception 'Film introuvable.' using errcode = 'P0002'; end if;
  elsif nullif(v_film ->> 'tmdb_id', '') is not null then
    insert into public.films (tmdb_id, title, original_title, release_date, release_year, overview, genres, runtime, director, tmdb_poster_path)
    values ((v_film ->> 'tmdb_id')::integer, btrim(v_film ->> 'title'), nullif(v_film ->> 'original_title', ''),
            nullif(v_film ->> 'release_date', '')::date, nullif(v_film ->> 'release_year', '')::smallint,
            nullif(v_film ->> 'overview', ''), v_genres, nullif(v_film ->> 'runtime', '')::integer,
            nullif(v_film ->> 'director', ''), nullif(v_film ->> 'tmdb_poster_path', ''))
    on conflict (tmdb_id) do update set
      title = excluded.title, original_title = excluded.original_title,
      release_date = coalesce(excluded.release_date, public.films.release_date),
      release_year = coalesce(excluded.release_year, public.films.release_year),
      overview = coalesce(excluded.overview, public.films.overview),
      genres = case when cardinality(excluded.genres) > 0 then excluded.genres else public.films.genres end,
      runtime = coalesce(excluded.runtime, public.films.runtime),
      director = coalesce(excluded.director, public.films.director),
      tmdb_poster_path = coalesce(excluded.tmdb_poster_path, public.films.tmdb_poster_path)
    returning id into v_film_id;
  else
    insert into public.films (title, original_title, release_date, release_year, overview, genres, director)
    values (btrim(v_film ->> 'title'), nullif(v_film ->> 'original_title', ''), nullif(v_film ->> 'release_date', '')::date,
            nullif(v_film ->> 'release_year', '')::smallint, nullif(v_film ->> 'overview', ''), v_genres, nullif(v_film ->> 'director', ''))
    returning id into v_film_id;
  end if;

  if v_tmdb_path is not null then
    select id into v_visual_id from public.poster_visuals where film_id = v_film_id and tmdb_file_path = v_tmdb_path;
    if found then
      return jsonb_build_object('status', 'duplicate', 'visual_id', v_visual_id, 'film_id', v_film_id);
    end if;
  end if;

  insert into public.poster_visuals (film_id, label, source, tmdb_file_path, tmdb_language, image_path, thumb_path, status)
  values (v_film_id, nullif(btrim(v_visual ->> 'label'), ''), (v_visual ->> 'source')::public.visual_source,
          v_tmdb_path, nullif(v_visual ->> 'tmdb_language', ''), nullif(v_visual ->> 'image_path', ''),
          nullif(v_visual ->> 'thumb_path', ''), coalesce(nullif(v_visual ->> 'status', ''), 'published')::public.visual_status)
  returning id into v_visual_id;

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'prices', '[]'::jsonb)) loop
    if nullif(v_item ->> 'price_cents', '') is not null then
      insert into public.prices (visual_id, format_id, price_cents)
      values (v_visual_id, (v_item ->> 'format_id')::integer, (v_item ->> 'price_cents')::integer);
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'stock', '[]'::jsonb)) loop
    v_qty := coalesce((v_item ->> 'quantity')::integer, 0);
    if v_qty < 0 then raise exception 'La quantité ne peut pas être négative.' using errcode = '23514'; end if;
    if v_qty > 0 then
      if nullif(v_item ->> 'location_id', '') is null then
        raise exception 'Choisissez un emplacement de rangement.' using errcode = '22023';
      end if;
      perform public._apply_stock_delta(v_visual_id, (v_item ->> 'format_id')::integer, (v_item ->> 'location_id')::uuid,
                                        v_qty, 'stock_in', 'Création de l''affiche');
    end if;
  end loop;

  return jsonb_build_object('status', 'created', 'visual_id', v_visual_id, 'film_id', v_film_id);
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- VITRINE PUBLIQUE : seules ces deux fonctions sont accessibles aux visiteurs.
-- Ni quantité, ni emplacement, ni historique, ni information de compte.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.get_public_catalog()
returns table (
  visual_id uuid, film_id uuid, title text, original_title text, release_date date, release_year smallint,
  overview text, genres text[], runtime integer, director text, label text, reference_code text,
  source public.visual_source, tmdb_file_path text, image_path text, thumb_path text,
  added_at timestamptz, formats jsonb
)
language sql stable security definer set search_path = ''
as $$
  with settings as (select coalesce((select show_prices from public.app_settings limit 1), true) as show_prices),
  available as (
    select st.visual_id, f.id as format_id, f.code, f.label, f.sort_order, f.default_price_cents
      from public.stocks st join public.formats f on f.id = st.format_id and f.is_active
     group by st.visual_id, f.id having sum(st.quantity) > 0
  )
  select v.id, fi.id, fi.title, fi.original_title, fi.release_date, fi.release_year, fi.overview, fi.genres,
         fi.runtime, fi.director, v.label, v.reference_code, v.source, v.tmdb_file_path, v.image_path, v.thumb_path, v.created_at,
         jsonb_agg(jsonb_build_object(
           'format_id', a.format_id, 'code', a.code, 'label', a.label,
           'price_cents', case when (select show_prices from settings) then coalesce(pr.price_cents, a.default_price_cents) end
         ) order by a.sort_order)
    from public.poster_visuals v
    join public.films fi on fi.id = v.film_id
    join available a on a.visual_id = v.id
    left join public.prices pr on pr.visual_id = v.id and pr.format_id = a.format_id
   where v.status = 'published'
   group by v.id, fi.id
$$;

create or replace function public.get_public_settings()
returns table (catalog_name text, cinema_name text, tagline text, contact_note text, logo_path text,
               accent_color text, show_prices boolean, show_recent boolean, recent_count integer)
language sql stable security definer set search_path = ''
as $$ select catalog_name, cinema_name, tagline, contact_note, logo_path, accent_color, show_prices, show_recent, recent_count
        from public.app_settings limit 1 $$;

-- ═══════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════
alter table public.admin_profiles  enable row level security;
alter table public.films           enable row level security;
alter table public.formats         enable row level security;
alter table public.locations       enable row level security;
alter table public.poster_visuals  enable row level security;
alter table public.prices          enable row level security;
alter table public.stocks          enable row level security;
alter table public.stock_movements enable row level security;
alter table public.app_settings    enable row level security;

-- Visiteurs : aucun accès direct aux tables (défense en profondeur en plus de RLS)
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Administrateurs : lecture seule côté client ; toute modification passe par les fonctions.
revoke insert, update, delete on public.admin_profiles from authenticated;
-- Stocks et historique : jamais modifiables directement (fonctions atomiques uniquement)
revoke insert, update, delete on public.stocks, public.stock_movements from authenticated;

drop policy if exists admin_profiles_read on public.admin_profiles;
create policy admin_profiles_read on public.admin_profiles for select to authenticated
  using (user_id = auth.uid() or public.is_owner());

-- Tables du catalogue : administrateurs actifs (principal ou non)
do $$
declare t text;
begin
  foreach t in array array['films', 'formats', 'locations', 'poster_visuals', 'prices'] loop
    execute format('drop policy if exists %1$s_admin_select on public.%1$s', t);
    execute format('create policy %1$s_admin_select on public.%1$s for select to authenticated using (public.is_admin())', t);
    execute format('drop policy if exists %1$s_admin_insert on public.%1$s', t);
    execute format('create policy %1$s_admin_insert on public.%1$s for insert to authenticated with check (public.is_admin())', t);
    execute format('drop policy if exists %1$s_admin_update on public.%1$s', t);
    execute format('create policy %1$s_admin_update on public.%1$s for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Suppressions autorisées uniquement là où elles sont sans risque :
-- prix personnalisé (retour au prix par défaut) et emplacement jamais utilisé (clé étrangère « restrict »).
drop policy if exists prices_admin_delete on public.prices;
create policy prices_admin_delete on public.prices for delete to authenticated using (public.is_admin());
drop policy if exists locations_admin_delete on public.locations;
create policy locations_admin_delete on public.locations for delete to authenticated using (public.is_admin());
revoke delete on public.films, public.formats, public.poster_visuals from authenticated;

drop policy if exists stocks_admin_select on public.stocks;
create policy stocks_admin_select on public.stocks for select to authenticated using (public.is_admin());
drop policy if exists movements_admin_select on public.stock_movements;
create policy movements_admin_select on public.stock_movements for select to authenticated using (public.is_admin());

drop policy if exists settings_admin_select on public.app_settings;
create policy settings_admin_select on public.app_settings for select to authenticated using (public.is_admin());
-- Réglages généraux : administrateur principal uniquement
drop policy if exists settings_admin_update on public.app_settings;
drop policy if exists settings_owner_update on public.app_settings;
create policy settings_owner_update on public.app_settings for update to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- ───────────────────────────────────────────────────────────────────────
-- Droits d'exécution des fonctions (PostgreSQL les ouvre à tous par défaut)
-- ───────────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'public._apply_stock_delta(uuid, integer, uuid, integer, public.movement_reason, text)',
    'public.bootstrap_first_owner(uuid, text, text)',
    'public.ensure_active_owner()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.is_admin()', 'public.is_owner()', 'public.assert_admin()', 'public.assert_owner()',
    'public.my_admin_profile()', 'public.activate_my_account()', 'public.update_my_display_name(text)',
    'public.admin_record_invitation(uuid, text, public.admin_role)', 'public.admin_set_role(uuid, public.admin_role)',
    'public.admin_set_status(uuid, boolean)', 'public.admin_remove(uuid)', 'public.transfer_ownership(uuid, boolean)',
    'public.adjust_stock(uuid, integer, uuid, integer, public.movement_reason, text)',
    'public.set_stock_quantity(uuid, integer, uuid, integer, text)',
    'public.transfer_stock(uuid, integer, uuid, uuid, integer, text)',
    'public.create_poster(jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array['public.get_public_catalog()', 'public.get_public_settings()', 'public.is_initialized()'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

grant execute on function public.bootstrap_first_owner(uuid, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- Temps réel : les écrans d'administration se mettent à jour quand un autre
-- appareil modifie le stock (les politiques RLS s'appliquent aussi ici).
-- ───────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['stocks', 'stock_movements', 'poster_visuals'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
