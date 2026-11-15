"""
Test de bout en bout dans Chromium (Playwright), sur le VRAI index.html servi par
scripts/dev-server.mjs (mêmes en-têtes de sécurité que Vercel, dont la CSP).

Simulé au niveau réseau (le code de l'application n'est pas modifié) :
  • Supabase (REST, Auth, Storage) : petite base en mémoire ci-dessous ;
  • /api/tmdb, /api/admins, /api/setup : réponses simulées (leur logique serveur
    est testée séparément par tests/api) ;
  • CDN jsdelivr : fichiers servis depuis node_modules (mêmes versions figées) ;
  • images TMDB : affiches générées.

Lancement :
  SUPABASE_URL=https://test-projet.supabase.co SUPABASE_ANON_KEY=anon PORT=3100 node scripts/dev-server.mjs &
  python3 tests/e2e/e2e.py
"""
import base64, copy, io, json, re, sys, time, uuid
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright, Route, expect

BASE = "http://localhost:3100"
SUPA = "https://test-projet.supabase.co"
ROOT = Path(__file__).resolve().parents[2]
NM = ROOT / "node_modules"
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(exist_ok=True)

# ───────────────────────── Base simulée ─────────────────────────
OWNER = "11111111-1111-1111-1111-111111111111"
LIDO = "22222222-2222-2222-2222-222222222222"
USERS = {
    OWNER: {"email": "matthias.perso@exemple.fr", "password": "MonMotDePasse1"},
    LIDO: {"email": "contact@lido.example", "password": None},
}
DB = {
    "admin_profiles": [],
    "formats": [
        {"id": 1, "code": "small", "label": "Petit format", "default_price_cents": 800, "sort_order": 1, "is_active": True},
        {"id": 2, "code": "large", "label": "Grand format", "default_price_cents": 1500, "sort_order": 2, "is_active": True},
    ],
    "locations": [
        {"id": "loc-a", "name": "Réserve A", "notes": None, "sort_order": 0, "is_active": True, "created_at": "2026-01-01"},
        {"id": "loc-c2", "name": "Carton 2", "notes": None, "sort_order": 1, "is_active": True, "created_at": "2026-01-01"},
    ],
    "app_settings": {"id": True, "catalog_name": "Ciné Affiches", "cinema_name": "Le Lido",
                     "tagline": "Découvrez les affiches de films disponibles au cinéma.",
                     "contact_note": "Les affiches sont en vente à la caisse du cinéma.", "logo_path": None, "accent_color": None,
                     "show_prices": True, "show_recent": True, "recent_count": 8, "pdf_include_thumbnails": True, "pdf_include_prices": False},
    "films": [], "visuals": [], "movements": [], "files": {},
}
COLORS = {}
SRC = [("Interstellar", "Interstellar", 2014, (24, 38, 64), 157336), ("Dune : Deuxième partie", "Dune: Part Two", 2024, (176, 82, 26), 693134),
       ("Super Mario Bros. le film", "The Super Mario Bros. Movie", 2023, (200, 40, 40), 502356), ("Le Fabuleux Destin d'Amélie Poulain", None, 2001, (40, 110, 60), 194),
       ("La La Land", None, 2016, (70, 40, 120), 313369), ("Le Voyage de Chihiro", "千と千尋の神隠し", 2001, (30, 120, 140), 129)]
for i, (t, o, y, col, tid) in enumerate(SRC):
    fid = f"film-{i}"
    DB["films"].append({"id": fid, "tmdb_id": tid, "title": t, "original_title": o or t, "release_date": f"{y}-06-01", "release_year": y, "overview": "Un film remarquable projeté au Lido.",
                        "genres": ["Drame"], "runtime": 120, "director": "Réalisateur", "tmdb_poster_path": f"/p{i}a.jpg"})
    for j, (suf, label) in enumerate([("a", "Affiche française"), ("b", "Affiche teaser")][: 2 if i in (0, 2) else 1]):
        path = f"/p{i}{suf}.jpg"
        COLORS[path] = (col if j == 0 else tuple(min(255, c + 70) for c in col), t, label)
        vid = f"vis-{i}{suf}"
        stocks = [] if i == 4 else [{"id": f"s-{vid}-1", "visual_id": vid, "format_id": 1, "location_id": "loc-a", "quantity": 3}]
        if j == 0 and i in (0, 2):
            stocks.append({"id": f"s-{vid}-2", "visual_id": vid, "format_id": 2, "location_id": "loc-c2", "quantity": 4})
        DB["visuals"].append({"id": vid, "film_id": fid, "reference_code": f"AF-{len(DB['visuals']) + 1:04d}", "label": label, "source": "tmdb", "tmdb_file_path": path,
                              "tmdb_language": "fr" if j == 0 else None, "image_path": None, "thumb_path": None, "status": "published",
                              "created_at": f"2026-0{1 + len(DB['visuals'])}-01T10:00:00Z", "stocks": stocks, "prices": []})
CALLS = []


def film(fid): return next(f for f in DB["films"] if f["id"] == fid)
def vis(vid): return next(v for v in DB["visuals"] if v["id"] == vid)
def prof(uid): return next((p for p in DB["admin_profiles"] if p["user_id"] == uid), None)


def jwt(uid):
    enc = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    return f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc({'sub': uid, 'role': 'authenticated', 'aud': 'authenticated', 'exp': int(time.time()) + 3600, 'email': USERS[uid]['email']})}.c2ln"


def uid_from(headers):
    a = headers.get("authorization", "")
    try:
        return json.loads(base64.urlsafe_b64decode(a.split(".")[1] + "==")).get("sub")
    except Exception:
        return None


def user_obj(uid):
    return {"id": uid, "aud": "authenticated", "role": "authenticated", "email": USERS[uid]["email"], "email_confirmed_at": "2026-01-01T00:00:00Z",
            "app_metadata": {"provider": "email"}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}


def session(uid):
    return {"access_token": jwt(uid), "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": f"r-{uid}", "user": user_obj(uid)}


def active_admin(uid):
    p = prof(uid)
    return p and p["status"] == "active"


def catalog():
    out = []
    for v in DB["visuals"]:
        if v["status"] != "published":
            continue
        fm = []
        for f in DB["formats"]:
            if not f["is_active"]:
                continue
            q = sum(s["quantity"] for s in v["stocks"] if s["format_id"] == f["id"])
            if q > 0:
                custom = next((p["price_cents"] for p in v["prices"] if p["format_id"] == f["id"]), None)
                fm.append({"format_id": f["id"], "code": f["code"], "label": f["label"],
                           "price_cents": (custom if custom is not None else f["default_price_cents"]) if DB["app_settings"]["show_prices"] else None})
        if fm:
            fi = film(v["film_id"])
            out.append({"visual_id": v["id"], "film_id": fi["id"], "title": fi["title"], "original_title": fi["original_title"], "release_date": fi["release_date"],
                        "release_year": fi["release_year"], "overview": fi["overview"], "genres": fi["genres"], "runtime": fi["runtime"], "director": fi["director"],
                        "label": v["label"], "reference_code": v["reference_code"], "source": v["source"], "tmdb_file_path": v["tmdb_file_path"],
                        "image_path": v["image_path"], "thumb_path": v["thumb_path"], "added_at": v["created_at"], "formats": fm})
    return out


def apply_delta(uid, vid, fid, lid, delta, reason, note):
    v = vis(vid)
    s = next((x for x in v["stocks"] if x["format_id"] == fid and x["location_id"] == lid), None)
    if not s:
        s = {"id": str(uuid.uuid4()), "visual_id": vid, "format_id": fid, "location_id": lid, "quantity": 0}
        v["stocks"].append(s)
    if s["quantity"] + delta < 0:
        raise ValueError(f"Stock insuffisant : {s['quantity']} exemplaire(s) à cet emplacement.")
    before = s["quantity"]
    s["quantity"] += delta
    p = prof(uid)
    DB["movements"].insert(0, {"id": len(DB["movements"]) + 1, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stock_id": s["id"], "visual_id": vid,
                               "film_id": v["film_id"], "format_id": fid, "location_id": lid, "film_title": film(v["film_id"])["title"], "visual_ref": v["reference_code"],
                               "visual_label": v["label"], "format_label": next(f["label"] for f in DB["formats"] if f["id"] == fid),
                               "location_name": next(l["name"] for l in DB["locations"] if l["id"] == lid), "quantity_before": before, "delta": delta,
                               "quantity_after": s["quantity"], "reason": reason, "note": note, "actor_id": uid, "actor_name": (p or {}).get("display_name") or USERS[uid]["email"]})
    return s["quantity"]


def respond(route, data, status=200, headers=None):
    h = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*", "content-type": "application/json"}
    h.update(headers or {})
    route.fulfill(status=status, headers=h, body=json.dumps(data) if data is not None else "")


def err(route, code, message, status=400):
    respond(route, {"code": code, "message": message, "details": None, "hint": None}, status)


def handle_supabase(route: Route):
    req = route.request
    if req.method == "OPTIONS":
        return respond(route, None, 200)
    u = urlparse(req.url)
    path, q = u.path, parse_qs(u.query)
    uid = uid_from(req.headers)
    raw_body = req.post_data_buffer
    try:
        body = json.loads(req.post_data) if req.post_data and "json" in (req.headers.get("content-type") or "") else {}
    except Exception:
        body = {}
    CALLS.append((req.method, path, body, uid))
    single = "vnd.pgrst.object" in (req.headers.get("accept") or "")

    # ── Auth ──
    if path == "/auth/v1/token":
        email, pw = body.get("email", "").lower(), body.get("password")
        for k, u2 in USERS.items():
            if u2["email"] == email and u2["password"] and u2["password"] == pw:
                return respond(route, session(k))
        return respond(route, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}, 400)
    if path == "/auth/v1/user" and req.method == "GET":
        return respond(route, user_obj(uid)) if uid in USERS else respond(route, {"msg": "invalid"}, 401)
    if path == "/auth/v1/user" and req.method == "PUT":
        if body.get("password"):
            USERS[uid]["password"] = body["password"]
        return respond(route, user_obj(uid))
    if path == "/auth/v1/logout":
        return respond(route, None, 204)
    if path == "/auth/v1/recover":
        return respond(route, {})

    # ── Storage ──
    m = re.match(r"^/storage/v1/object/public/posters/(.+)$", path)
    if m:
        data = DB["files"].get(unquote(m.group(1)))
        return route.fulfill(status=200 if data else 404, body=data or b"", headers={"content-type": "image/jpeg", "access-control-allow-origin": "*"})
    m = re.match(r"^/storage/v1/object/posters/(.+)$", path)
    if m and req.method == "POST":
        if not active_admin(uid):
            return respond(route, {"statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy"}, 403)
        data = raw_body
        ct = req.headers.get("content-type") or ""
        if "multipart/form-data" in ct:  # Supabase envoie les fichiers en formulaire multipart
            boundary = ct.split("boundary=")[1].encode()
            for part in data.split(b"--" + boundary):
                head, _, content = part.partition(b"\r\n\r\n")
                if b"filename" in head or b"image/" in head:
                    data = content.rstrip(b"\r\n-")
                    break
        DB["files"][unquote(m.group(1))] = data
        return respond(route, {"Key": f"posters/{m.group(1)}", "Id": str(uuid.uuid4())})
    if path == "/storage/v1/object/posters" and req.method == "DELETE":
        return respond(route, [])

    # ── RPC ──
    if path.startswith("/rest/v1/rpc/"):
        fn = path.rsplit("/", 1)[1]
        if fn == "get_public_catalog": return respond(route, catalog())
        if fn == "get_public_settings": return respond(route, [{k: DB["app_settings"][k] for k in ("catalog_name", "cinema_name", "tagline", "contact_note", "logo_path", "accent_color", "show_prices", "show_recent", "recent_count")}])
        if fn == "is_initialized": return respond(route, len(DB["admin_profiles"]) > 0)
        if fn == "my_admin_profile":
            p = prof(uid)
            return respond(route, [{k: p[k] for k in ("user_id", "email", "display_name", "role", "status")}] if p else [])
        if fn == "activate_my_account":
            p = prof(uid)
            if not p: return err(route, "42501", "Aucune invitation pour ce compte.")
            if p["status"] == "invited": p.update(status="active", activated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ"))
            return respond(route, p["status"])
        if fn == "update_my_display_name":
            prof(uid)["display_name"] = body.get("p_name") or None
            return respond(route, None)
        if not active_admin(uid):
            return err(route, "42501", "Accès réservé aux administrateurs actifs.", 401)
        owner = prof(uid)["role"] == "owner"
        if fn == "adjust_stock":
            try: return respond(route, apply_delta(uid, body["p_visual_id"], body["p_format_id"], body["p_location_id"], body["p_delta"], body["p_reason"], body.get("p_note")))
            except ValueError as e: return err(route, "23514", str(e))
        if fn == "set_stock_quantity":
            v = vis(body["p_visual_id"])
            s = next((x for x in v["stocks"] if x["format_id"] == body["p_format_id"] and x["location_id"] == body["p_location_id"]), {"quantity": 0})
            d = body["p_quantity"] - s["quantity"]
            return respond(route, apply_delta(uid, v["id"], body["p_format_id"], body["p_location_id"], d, "inventory_correction", body.get("p_note")) if d else s["quantity"])
        if fn == "transfer_stock":
            try:
                apply_delta(uid, body["p_visual_id"], body["p_format_id"], body["p_from_location_id"], -body["p_quantity"], "transfer", "vers ...")
                apply_delta(uid, body["p_visual_id"], body["p_format_id"], body["p_to_location_id"], body["p_quantity"], "transfer", "depuis ...")
            except ValueError as e: return err(route, "23514", str(e))
            return respond(route, None)
        if fn == "create_poster":
            p = body["p"]
            f = p["film"]
            fid = f.get("id") or next((x["id"] for x in DB["films"] if f.get("tmdb_id") and x["tmdb_id"] == f.get("tmdb_id")), None)
            if not fid:
                fid = f"film-{len(DB['films'])}"
                DB["films"].append({"id": fid, "tmdb_id": f.get("tmdb_id"), "title": f["title"], "original_title": f.get("original_title"), "release_date": f.get("release_date"),
                                    "release_year": f.get("release_year"), "overview": f.get("overview"), "genres": f.get("genres") or [], "runtime": f.get("runtime"),
                                    "director": f.get("director"), "tmdb_poster_path": f.get("tmdb_poster_path")})
            tp = p["visual"].get("tmdb_file_path")
            dup = next((v for v in DB["visuals"] if v["film_id"] == fid and tp and v["tmdb_file_path"] == tp), None)
            if dup: return respond(route, {"status": "duplicate", "visual_id": dup["id"], "film_id": fid})
            vid = str(uuid.uuid4())
            DB["visuals"].append({"id": vid, "film_id": fid, "reference_code": f"AF-{len(DB['visuals']) + 1:04d}", "label": p["visual"].get("label"), "source": p["visual"]["source"],
                                  "tmdb_file_path": tp, "tmdb_language": p["visual"].get("tmdb_language"), "image_path": p["visual"].get("image_path"), "thumb_path": p["visual"].get("thumb_path"),
                                  "status": p["visual"]["status"], "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stocks": [], "prices": p.get("prices", [])})
            for line in p["stock"]:
                if line["quantity"] > 0: apply_delta(uid, vid, line["format_id"], line["location_id"], line["quantity"], "stock_in", "Création de l'affiche")
            return respond(route, {"status": "created", "visual_id": vid, "film_id": fid})
        if fn in ("transfer_ownership", "admin_set_role"):
            if not owner: return err(route, "42501", "Action réservée à l'administrateur principal.")
            t = prof(body["p_user_id"])
            if t["status"] != "active": return err(route, "22023", "Ce compte doit d'abord accepter son invitation et se connecter.")
            if fn == "transfer_ownership":
                t["role"] = "owner"
                if not body.get("p_keep_me_owner"): prof(uid)["role"] = "admin"
            else: t["role"] = body["p_role"]
            return respond(route, None)
        return respond(route, None)

    # ── Tables ──
    table = path.rsplit("/", 1)[1]
    if not active_admin(uid):
        return respond(route, [] if not single else None, 200 if not single else 406)
    if table == "poster_visuals":
        if req.method == "PATCH":
            v = vis(q["id"][0].split(".", 1)[1]); v.update(body); return respond(route, [])
        data = [dict(v, film=film(v["film_id"])) for v in DB["visuals"]]
        return respond(route, data)
    if table == "formats":
        if req.method == "PATCH":
            next(f for f in DB["formats"] if str(f["id"]) == q["id"][0].split(".", 1)[1]).update(body); return respond(route, [])
        if req.method == "POST":
            row = dict(body, id=len(DB["formats"]) + 1, default_price_cents=None, is_active=True); DB["formats"].append(row); return respond(route, row if single else [row], 201)
        return respond(route, DB["formats"])
    if table == "locations":
        if req.method == "POST":
            row = {"id": str(uuid.uuid4()), "name": body["name"], "notes": None, "sort_order": 0, "is_active": True, "created_at": "2026"}
            DB["locations"].append(row); return respond(route, row if single else [row], 201)
        if req.method == "PATCH":
            next(l for l in DB["locations"] if l["id"] == q["id"][0].split(".", 1)[1]).update(body); return respond(route, [])
        return respond(route, DB["locations"])
    if table == "app_settings":
        if req.method == "PATCH":
            if prof(uid)["role"] != "owner": return respond(route, [])
            DB["app_settings"].update(body); return respond(route, [])
        return respond(route, DB["app_settings"] if single else [DB["app_settings"]])
    if table == "admin_profiles":
        rows = DB["admin_profiles"] if prof(uid)["role"] == "owner" else [prof(uid)]
        return respond(route, rows)
    if table == "stock_movements":
        rows = DB["movements"]
        if "visual_id" in q: rows = [m for m in rows if m["visual_id"] == q["visual_id"][0].split(".", 1)[1]]
        return respond(route, rows[: int(q.get("limit", ["50"])[0])])
    if table == "prices":
        if req.method == "POST":
            v = vis(body["visual_id"]); v["prices"] = [p for p in v["prices"] if p["format_id"] != body["format_id"]] + [{"format_id": body["format_id"], "price_cents": body["price_cents"]}]
        return respond(route, [])
    return respond(route, [])


# ───────────────────────── /api simulées ─────────────────────────
TMDB_MOVIE = {"id": 27205, "title": "Inception", "original_title": "Inception", "release_date": "2010-07-16", "overview": "Dom Cobb est un voleur expérimenté…", "genres": ["Action"],
              "runtime": 148, "director": "Christopher Nolan", "poster_path": "/inc-fr1.jpg",
              "posters": [{"file_path": f"/inc-{l}{n}.jpg", "iso_639_1": None if l == "xx" else l, "width": 1000, "height": 1500, "vote_average": 5, "vote_count": 3}
                          for l, n in [("fr", 1), ("fr", 2), ("xx", 1), ("en", 1), ("en", 2), ("de", 1), ("ja", 1)]]}
for p in TMDB_MOVIE["posters"]:
    COLORS[p["file_path"]] = ((20 + len(p["file_path"]) * 7 % 90, 50, 120), "Inception", f"version {p['iso_639_1'] or 'sans texte'}")
SETUP_STATE = {"calls": []}


def handle_api(route: Route):
    req = route.request
    u = urlparse(req.url)
    uid = uid_from(req.headers)
    body = json.loads(req.post_data) if req.post_data else {}
    CALLS.append(("API", u.path, body, uid))
    if u.path == "/api/tmdb":
        if not active_admin(uid): return respond(route, {"error": "Accès réservé"}, 403)
        qq = parse_qs(u.query)
        if qq["action"][0] == "search":
            return respond(route, {"page": 1, "total_pages": 1, "results": [{"id": 27205, "title": "Inception", "original_title": "Inception", "release_date": "2010-07-16", "poster_path": "/inc-fr1.jpg"},
                                                                          {"id": 157336, "title": "Interstellar", "original_title": "Interstellar", "release_date": "2014-11-05", "poster_path": "/p0a.jpg"}]})
        return respond(route, TMDB_MOVIE)
    if u.path == "/api/setup":
        if req.method == "GET": return respond(route, {"initialized": bool(DB["admin_profiles"]), "setupEnabled": not DB["admin_profiles"]})
        if body.get("setupCode") != "code-secret-123": return respond(route, {"error": "Code d’initialisation incorrect."}, 403)
        USERS[OWNER]["password"] = body["password"]
        DB["admin_profiles"].append({"user_id": OWNER, "email": body["email"], "display_name": body.get("displayName") or None, "role": "owner", "status": "active",
                                     "invited_at": "2026-11-15T10:00:00Z", "activated_at": "2026-11-15T10:00:00Z", "last_invite_sent_at": None, "disabled_at": None, "created_at": "2026-11-15"})
        return respond(route, {"ok": True})
    if u.path == "/api/admins":
        if not (active_admin(uid) and prof(uid)["role"] == "owner"): return respond(route, {"error": "Action réservée à l’administrateur principal."}, 403)
        if body["action"] == "invite":
            DB["admin_profiles"].append({"user_id": LIDO, "email": body["email"], "display_name": None, "role": "admin", "status": "invited",
                                         "invited_at": "2026-11-15T11:00:00Z", "activated_at": None, "last_invite_sent_at": "2026-11-15T11:00:00Z", "disabled_at": None, "created_at": "2026-11-16"})
            return respond(route, {"ok": True, "message": f"Invitation envoyée à {body['email']}."})
        if body["action"] in ("disable", "enable"):
            p = prof(body["userId"]); p["status"] = "disabled" if body["action"] == "disable" else "active"
            return respond(route, {"ok": True, "message": "Compte désactivé." if body["action"] == "disable" else "Compte réactivé."})
        return respond(route, {"ok": True, "message": "OK"})
    return respond(route, {"error": "?"}, 404)


def poster_jpg(path, w=342):
    col, title, label = COLORS.get(path, ((90, 90, 90), "Affiche", ""))
    h = int(w * 1.5)
    im = Image.new("RGB", (w, h), col)
    d = ImageDraw.Draw(im)
    for k in range(0, h, 6):
        d.line([(0, k), (w, k)], fill=tuple(max(0, c - int(40 * k / h)) for c in col), width=6)
    d.ellipse([w * .2, h * .18, w * .8, h * .18 + w * .6], outline=(240, 220, 170), width=4)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", int(w / 11))
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", int(w / 22))
    except OSError:
        font = small = ImageFont.load_default()
    words, lines, cur = title.upper().split(), [], ""
    for wd in words:
        if len(cur + " " + wd) > 12 and cur: lines.append(cur); cur = wd
        else: cur = (cur + " " + wd).strip()
    lines.append(cur)
    y0 = int(h * .68)
    for ln in lines[:3]:
        d.text((w / 2, y0), ln, fill=(250, 245, 230), font=font, anchor="mm"); y0 += int(w / 9)
    d.text((w / 2, h - w / 12), label.upper(), fill=(230, 210, 160), font=small, anchor="mm")
    b = io.BytesIO(); im.save(b, "JPEG", quality=85)
    return b.getvalue()


def handle_img(route: Route):
    path = "/" + route.request.url.split("/t/p/", 1)[1].split("/", 1)[1]
    if "missing" in path:
        return route.fulfill(status=404, body="")
    route.fulfill(status=200, content_type="image/jpeg", body=poster_jpg(path), headers={"access-control-allow-origin": "*"})


CDN_MAP = [
    (r"@supabase/supabase-js@2\.117\.3/dist/umd/supabase\.js$", "@supabase/supabase-js/dist/umd/supabase.js"),
    (r"pdfmake@0\.2\.23/build/pdfmake\.min\.js$", "pdfmake/build/pdfmake.min.js"),
    (r"pdfmake@0\.2\.23/build/vfs_fonts\.js$", "pdfmake/build/vfs_fonts.js"),
    (r"cropperjs@1\.6\.2/dist/cropper\.min\.js$", "cropperjs/dist/cropper.min.js"),
    (r"cropperjs@1\.6\.2/dist/cropper\.min\.css$", "cropperjs/dist/cropper.min.css"),
    (r"qrcode-generator@1\.4\.4/qrcode\.js$", "qrcode-generator/qrcode.js"),
    (r"@fontsource-variable/(fraunces|manrope)@5\.3\.0/(.+)$", None),
]


def handle_cdn(route: Route):
    url = route.request.url
    for pattern, local in CDN_MAP:
        m = re.search(pattern, url)
        if m:
            p = NM / (local or f"@fontsource-variable/{m.group(1)}/{m.group(2)}")
            if p.exists():
                ct = "text/css" if p.suffix == ".css" else "font/woff2" if p.suffix == ".woff2" else "application/javascript"
                return route.fulfill(status=200, body=p.read_bytes(), headers={"content-type": ct, "access-control-allow-origin": "*"})
    route.fulfill(status=404, body="")


# ───────────────────────── Scénarios ─────────────────────────
errors, checks = [], []


def check(name, cond):
    checks.append((name, bool(cond)))
    print(("  ✓ " if cond else "  ✗ ") + name)


def rpc_calls(name): return [c for c in CALLS if c[1] == f"/rest/v1/rpc/{name}"]


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    def new_page(w, h, mobile, storage=None):
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile, locale="fr-FR", accept_downloads=True)
        ctx.route(f"{SUPA}/**", handle_supabase)
        ctx.route(re.compile(r".*/api/(tmdb|admins|setup)(\?.*)?$"), handle_api)
        ctx.route("https://image.tmdb.org/**", handle_img)
        ctx.route("https://cdn.jsdelivr.net/**", handle_cdn)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        return page

    print("\nVitrine publique (mobile)")
    pg = new_page(390, 844, True)
    resp = pg.goto(BASE + "/")
    pg.wait_for_selector("text=Toutes les affiches")
    pg.wait_for_timeout(800)
    check("CSP de production active (en-tête présent)", "default-src 'self'" in (resp.headers.get("content-security-policy") or ""))
    pg.screenshot(path=OUT / "01-vitrine-mobile.png")
    check("catalogue affiché (La La Land épuisé absent)", pg.locator("a.pcard").count() >= 8 and pg.get_by_text("La La Land").count() == 0)
    visible = pg.locator("body").inner_text()
    check("aucune quantité ni emplacement affichés", "Réserve" not in visible and "Carton" not in visible and "exemplaire" not in visible)
    check("données publiques sans quantité ni emplacement", not re.search(r"quantity|location|Réserve|Carton", json.dumps(catalog())))
    check("aucun lien vers l’administration dans la vitrine", pg.locator("a[href*='espace-interne']").count() == 0 and "Administration" not in visible)
    pg.get_by_label("Rechercher un film").fill("MARIO")
    pg.wait_for_timeout(350)
    check("recherche « MARIO » → 2 visuels", pg.locator("#pub-count").inner_text() == "2 affiches")
    pg.get_by_label("Rechercher un film").fill("amelie")
    pg.wait_for_timeout(350)
    check("recherche sans accent « amelie »", pg.locator("#pub-count").inner_text() == "1 affiche")
    pg.get_by_label("Rechercher un film").fill("2014")
    pg.wait_for_timeout(350)
    check("recherche par année « 2014 »", pg.locator("#pub-count").inner_text() == "2 affiches")
    pg.get_by_label("Effacer la recherche").click()
    pg.get_by_role("radio", name="Grand format").click()
    pg.wait_for_timeout(250)
    check("filtre grand format", pg.locator("#pub-count").inner_text() == "2 affiches")
    pg.select_option("#pub-sort", "release-desc")
    pg.wait_for_timeout(250)
    check("tri + filtre combinés (Dune d’abord… absent du grand format → Mario 2023)", "Mario" in pg.locator("#pub-results a.pcard").first.get_attribute("aria-label"))
    check("état conservé dans l’adresse", "format=large" in pg.url and "tri=release-desc" in pg.url)
    pg.get_by_role("radio", name="Toutes").click()
    pg.locator("a.pcard[href^='/affiche/vis-0a']").first.click()
    pg.wait_for_selector(".detail")
    pg.wait_for_timeout(500)
    check("fiche : adresse /affiche/…", "/affiche/vis-0a" in pg.url)
    check("fiche : autres visuels du film", pg.get_by_text("Autres affiches de ce film (1)").count() == 1)
    check("fiche : formats et prix", pg.get_by_text("15,00").count() >= 1 and pg.get_by_text("Grand format").count() >= 1)
    pg.screenshot(path=OUT / "02-fiche-mobile.png")
    pg.locator("[data-act=zoom]").click()
    check("agrandissement plein écran", pg.locator(".lightbox").count() == 1)
    pg.keyboard.press("Escape")
    pg.go_back()
    pg.wait_for_timeout(300)
    check("bouton précédent du navigateur → fiche fermée", pg.locator(".detail").count() == 0 and "/affiche/" not in pg.url)
    pg.go_forward()
    pg.wait_for_timeout(400)
    check("bouton suivant → fiche rouverte", pg.locator(".detail").count() == 1)
    pg.reload()
    pg.wait_for_selector(".detail")
    check("lien direct / actualisation d’une fiche", pg.locator(".detail h2").inner_text().startswith("Interstellar"))

    print("\nAdministration : adresse privée et initialisation")
    ad = new_page(390, 844, True)
    r = ad.goto(BASE + "/espace-interne")
    ad.wait_for_selector("text=Se connecter")
    check("/espace-interne : page de connexion sans session", ad.locator("h1").inner_text() == "Ciné Affiches")
    check("non-indexation : en-tête X-Robots-Tag", "noindex" in (r.headers.get("x-robots-tag") or ""))
    check("non-indexation : balise robots", ad.locator("#meta-robots").get_attribute("content").startswith("noindex"))
    ad.wait_for_timeout(500)
    check("lien de première installation proposé (aucun administrateur)", ad.get_by_text("Première installation").count() == 1)
    ad.screenshot(path=OUT / "03-connexion.png")
    ad.get_by_text("Première installation").click()
    ad.wait_for_selector("text=Créer le compte principal")
    ad.screenshot(path=OUT / "04-initialisation.png")
    ad.get_by_label("Code d’initialisation", exact=False).fill("mauvais-code")
    ad.get_by_label("Votre nom").fill("Matthias")
    ad.get_by_label("Votre adresse e-mail").fill("matthias.perso@exemple.fr")
    ad.get_by_label("Mot de passe", exact=True).fill("MonMotDePasse1")
    ad.get_by_label("Confirmer le mot de passe").fill("MonMotDePasse1")
    ad.get_by_role("button", name="Créer le compte principal").click()
    ad.wait_for_selector("text=Code d’initialisation incorrect")
    check("code d’initialisation erroné refusé", True)
    ad.get_by_label("Code d’initialisation", exact=False).fill("code-secret-123")
    ad.get_by_role("button", name="Créer le compte principal").click()
    ad.wait_for_selector("text=Compte principal créé")
    check("Test 1 : compte principal personnel créé", prof(OWNER) and prof(OWNER)["role"] == "owner")
    ad.get_by_label("Mot de passe", exact=True).fill("MonMotDePasse1")
    ad.get_by_label("Afficher le mot de passe").click()
    check("afficher / masquer le mot de passe", ad.get_by_label("Mot de passe", exact=True).get_attribute("type") == "text")
    ad.get_by_role("button", name="Se connecter").click()
    ad.get_by_role("heading", name="Tableau de bord").wait_for()
    ad.wait_for_timeout(400)
    check("Test 1 : tableau de bord après connexion", ad.locator(".stat b").first.inner_text() == "29")
    check("statistiques : 7 références, 1 épuisée", ad.locator(".stat b").nth(1).inner_text() == "7" and ad.locator(".stat b").nth(3).inner_text() == "1")
    ad.screenshot(path=OUT / "05-tableau-de-bord.png", full_page=True)

    print("\nVente rapide (Test 7) et rupture (Test 8)")
    ad.get_by_label("Rechercher dans le stock").fill("mario")
    ad.wait_for_timeout(300)
    check("recherche rapide « mario » → 2 cartes", ad.locator("[data-results] .vcard").count() == 2)
    ad.get_by_label("Retirer un exemplaire (Grand format, Carton 2)").first.click()
    ad.wait_for_selector("text=Retirer du stock")
    ad.screenshot(path=OUT / "06-retrait.png")
    ad.get_by_role("button", name="Vente", exact=True).click()
    ad.wait_for_selector("text=Vente : −1")
    sale = rpc_calls("adjust_stock")[-1][2]
    check("Test 7 : −1 au bon format et emplacement, motif vente", sale["p_delta"] == -1 and sale["p_format_id"] == 2 and sale["p_location_id"] == "loc-c2" and sale["p_reason"] == "sale")
    check("Test 7 : historique mis à jour", DB["movements"][0]["reason"] == "sale" and DB["movements"][0]["quantity_after"] == 3)
    # Rupture : vider Dune (3 exemplaires en Réserve A)
    ad.get_by_label("Rechercher dans le stock").fill("dune")
    ad.wait_for_timeout(300)
    ad.get_by_label("Retirer un exemplaire (Petit format, Réserve A)").first.click()
    ad.get_by_label("Augmenter : Quantité à retirer").click()
    ad.get_by_label("Augmenter : Quantité à retirer").click()
    ad.get_by_role("button", name="Vente", exact=True).click()
    ad.wait_for_selector("text=reste 0")
    ad.wait_for_timeout(300)
    check("Test 8 : reste dans l’administration, statut « Épuisée »", ad.locator("[data-results] .badge.danger", has_text="Épuisée").count() == 1)
    check("Test 8 : disparu de la vitrine", not any(v["title"].startswith("Dune") for v in catalog()))
    ad.get_by_role("button", name="Remettre en stock").click()
    ad.wait_for_selector("text=Ajouter au stock")
    ad.get_by_role("button", name="Ajouter au stock").click()
    ad.wait_for_selector("text=Entrée de stock : +1")
    check("Test 9 : retour en stock → de nouveau visible publiquement", any(v["title"].startswith("Dune") for v in catalog()))

    print("\nAjout d’une affiche TMDB (Tests 4 et 6)")
    ad.goto(BASE + "/espace-interne/ajouter")
    ad.get_by_label("Rechercher un film sur TMDB").fill("Incep")
    ad.wait_for_selector("text=Résultats TMDB")
    ad.wait_for_timeout(400)
    ad.screenshot(path=OUT / "07-ajout-recherche.png")
    ad.locator("[data-tmdb='27205']").click()
    ad.wait_for_selector("text=Affiches françaises")
    ad.wait_for_timeout(600)
    check("galerie : FR, sans texte, anglais (pas seulement l’affiche principale)", all(ad.get_by_text(t).count() for t in ["Affiches françaises", "Affiches sans texte", "Affiches anglaises"]))
    check("galerie : autres langues repliées puis visibles", ad.get_by_text("Voir les autres langues (2 visuels, 2 langues)").count() == 1)
    ad.get_by_text("Voir les autres langues").click()
    check("galerie : Allemand et Japonais", ad.get_by_text("Langue : Allemand").count() == 1 and ad.get_by_text("Langue : Japonais").count() == 1)
    ad.screenshot(path=OUT / "08-galerie.png", full_page=True)
    ad.locator("[data-zoom='/inc-fr2.jpg']").click()
    ad.get_by_role("button", name="Choisir ce visuel", exact=True).click()
    ad.wait_for_selector("text=Quantités et emplacements")
    ad.get_by_label("Augmenter : Quantité ligne 1").click()
    ad.locator("[data-line='1'] [data-l-loc]").select_option("loc-c2")
    ad.get_by_label("Augmenter : Quantité ligne 2").click()
    ad.get_by_role("button", name="Ajouter une ligne (autre emplacement)").click()
    ad.locator("[data-line='2'] [data-l-format]").select_option("2")
    ad.locator("[data-line='2'] [data-l-loc]").select_option("loc-a")
    ad.wait_for_timeout(200)
    ad.screenshot(path=OUT / "09-formulaire.png", full_page=True)
    ad.get_by_role("button", name=re.compile("Enregistrer l’affiche · 4 ex.")).click()
    ad.wait_for_selector("text=Ajouter un autre visuel de ce film")
    p = rpc_calls("create_poster")[-1][2]["p"]
    check("Test 4 : informations du film récupérées automatiquement", p["film"]["tmdb_id"] == 27205 and p["film"]["director"] == "Christopher Nolan")
    check("Test 4 : visuel exact choisi", p["visual"]["tmdb_file_path"] == "/inc-fr2.jpg")
    check("Test 4 : formats et plusieurs emplacements", sorted((l["format_id"], l["location_id"], l["quantity"]) for l in p["stock"]) == [(1, "loc-a", 2), (2, "loc-a", 1), (2, "loc-c2", 1)])
    check("Test 4 : l’affiche apparaît dans la vitrine", any(v["title"] == "Inception" for v in catalog()))
    ad.screenshot(path=OUT / "10-enregistree.png")
    ad.get_by_role("button", name="Ajouter un autre visuel de ce film").click()
    ad.wait_for_selector("text=Affiches françaises")
    check("Test 6 : « autre visuel » → galerie directe, visuel déjà en stock signalé", ad.locator(".gtile .owned").count() == 1)
    ad.locator("[data-pick='/inc-fr2.jpg']").click()
    ad.wait_for_selector("text=Visuel déjà enregistré")
    check("doublon : proposition d’ajouter du stock", ad.get_by_role("button", name="Ajouter du stock").count() == 1)
    ad.get_by_role("button", name="Annuler").click()
    ad.locator("[data-pick='/inc-xx1.jpg']").click()
    ad.get_by_role("button", name=re.compile("Enregistrer l’affiche")).click()
    ad.wait_for_selector("text=Ajouter un autre visuel de ce film")
    inc = [v for v in DB["visuals"] if v["film_id"] == DB["visuals"][-1]["film_id"]]
    check("Test 6 : deux visuels, un seul film, stocks indépendants", len(inc) == 2 and len({v["film_id"] for v in inc}) == 1 and sum(s["quantity"] for s in inc[1]["stocks"]) == 1)

    print("\nPhoto personnelle (Test 5)")
    ad.get_by_role("button", name="Ajouter un autre visuel de ce film").click()
    ad.wait_for_selector("text=Visuel introuvable")
    ad.get_by_text("Visuel introuvable ? Ajouter ma propre affiche").click()
    ad.wait_for_selector("text=Prendre une photo")
    check("prise de vue : appareil photo du téléphone proposé", ad.locator("input[capture=environment]").count() == 1)
    photo = Image.new("RGB", (1200, 1700), (180, 40, 60)); ImageDraw.Draw(photo).rectangle([100, 100, 1100, 1600], outline=(255, 230, 180), width=30)
    buf = io.BytesIO(); photo.save(buf, "JPEG"); (OUT / "photo-test.jpg").write_bytes(buf.getvalue())
    ad.locator("input[data-file]").set_input_files(str(OUT / "photo-test.jpg"))
    ad.wait_for_selector(".cropper-container", timeout=15000)
    ad.wait_for_timeout(500)
    ad.screenshot(path=OUT / "11-recadrage.png")
    ad.get_by_label("Pivoter à droite").click()
    ad.get_by_label("Pivoter à gauche").click()
    ad.get_by_role("button", name="Valider le cadrage").click()
    ad.wait_for_selector("text=Photo personnelle")
    ad.get_by_role("button", name=re.compile("Enregistrer l’affiche")).click()
    ad.wait_for_selector("text=Ajouter un autre visuel de ce film")
    p = rpc_calls("create_poster")[-1][2]["p"]
    files = list(DB["files"].items())
    check("Test 5 : photo + miniature envoyées (JPEG compressé)", len(files) == 2 and all(b[:2] == b"\xff\xd8" for _, b in files) and max(len(b) for _, b in files) < 600_000)
    full = Image.open(io.BytesIO(next(b for k, b in files if k.endswith("full.jpg"))))
    check("Test 5 : recadrage 2:3 et taille ≤ 1600 px", abs(full.width / full.height - 2 / 3) < 0.02 and max(full.size) <= 1600)
    check("Test 5 : infos TMDB du film conservées, seul le visuel est personnel", p["visual"]["source"] == "photo" and "id" in p["film"])
    check("Test 5 : visible dans le catalogue", any(v["source"] == "photo" for v in catalog()))

    print("\nFiche, déplacement (Test 10) et correction")
    ad.goto(BASE + "/espace-interne/affiche/vis-0a")
    ad.wait_for_selector("text=Visuels de ce film")
    ad.wait_for_timeout(400)
    ad.locator(".sline", has_text="Carton 2").get_by_role("button", name="Déplacer").click()
    ad.wait_for_selector("text=Déplacer des exemplaires")
    ad.get_by_label("Diminuer : Quantité à déplacer").click()
    ad.locator("[data-locpick='to'] [data-loc='loc-a']").click()
    ad.get_by_role("dialog", name="Déplacer des exemplaires").get_by_role("button", name="Déplacer", exact=True).click()
    ad.wait_for_selector("text=3 exemplaires déplacés")
    t = rpc_calls("transfer_stock")[-1][2]
    v0 = vis("vis-0a")
    large = {s["location_id"]: s["quantity"] for s in v0["stocks"] if s["format_id"] == 2}
    check("Test 10 : 3 affiches déplacées du carton vers la réserve", t["p_quantity"] == 3 and t["p_from_location_id"] == "loc-c2" and t["p_to_location_id"] == "loc-a")
    check("Test 10 : total identique (4), quantités par emplacement à jour", large == {"loc-c2": 1, "loc-a": 3})
    check("Test 10 : historique « Transfert d’emplacement »", DB["movements"][0]["reason"] == "transfer" and DB["movements"][1]["reason"] == "transfer")
    ad.locator(".sline", has_text="Réserve A").first.get_by_role("button", name="Corriger").click()
    ad.get_by_label("Augmenter : Quantité comptée").click()
    ad.get_by_role("button", name="Enregistrer la correction").click()
    ad.wait_for_selector("text=Quantité corrigée")
    check("correction d’inventaire", rpc_calls("set_stock_quantity")[-1][2]["p_quantity"] == 4)
    ad.screenshot(path=OUT / "12-fiche-mobile.png", full_page=True)

    print("\nRéglages, QR code, inventaire PDF (Test 11)")
    ad.goto(BASE + "/espace-interne/reglages")
    ad.wait_for_selector("text=QR code de la vitrine")
    ad.wait_for_selector("[data-qr] svg", timeout=10000)
    check("QR code de la vitrine généré", ad.locator("[data-qr] svg").count() == 1)
    with ad.expect_download() as dl:
        ad.get_by_role("button", name="Affichette à imprimer (PDF)").click()
    (OUT / "affichette-qr.pdf").write_bytes(Path(dl.value.path()).read_bytes())
    check("affichette QR (PDF) téléchargée", (OUT / "affichette-qr.pdf").read_bytes()[:4] == b"%PDF")
    DB["visuals"].append({"id": "vis-miss", "film_id": "film-1", "reference_code": "AF-0099", "label": "Image introuvable", "source": "tmdb", "tmdb_file_path": "/missing.jpg",
                          "tmdb_language": "fr", "image_path": None, "thumb_path": None, "status": "published", "created_at": "2026-01-01T00:00:00Z",
                          "stocks": [{"id": "s-miss", "visual_id": "vis-miss", "format_id": 1, "location_id": "loc-c2", "quantity": 2}], "prices": []})
    ad.goto(BASE + "/espace-interne/inventaire")
    ad.wait_for_selector("text=Générer le PDF")
    ad.get_by_role("button", name="Générer le PDF").click()
    ad.wait_for_selector("text=PDF prêt", timeout=60000)
    with ad.expect_download() as dl:
        ad.locator("[data-dl]").click()
    pdf = Path(dl.value.path()).read_bytes()
    (OUT / "inventaire.pdf").write_bytes(pdf)
    check("Test 11 : PDF généré dans le navigateur, avec miniatures", pdf[:4] == b"%PDF" and len(pdf) > 30000)
    check("image indisponible signalée sans bloquer la génération", ad.get_by_text("miniature indisponible").count() >= 1)
    ad.screenshot(path=OUT / "13-inventaire.png")
    ad.get_by_role("radio", name="Par emplacement").click()
    ad.locator("label.switch", has_text="Avec prix").click()
    ad.get_by_role("button", name="Générer le PDF").click()
    ad.wait_for_selector("[data-ready]:not(.hidden)", timeout=60000)
    with ad.expect_download() as dl2:
        ad.locator("[data-dl]").click()
    (OUT / "inventaire-par-emplacement.pdf").write_bytes(Path(dl2.value.path()).read_bytes())
    check("inventaire trié par emplacement, avec prix", (OUT / "inventaire-par-emplacement.pdf").read_bytes()[:4] == b"%PDF")

    print("\nInvitation du Lido, activation, transfert (Test 2)")
    ad.goto(BASE + "/espace-interne/administrateurs")
    ad.wait_for_selector("text=Inviter un administrateur")
    ad.get_by_label("Adresse e-mail à inviter").fill("contact@lido.example")
    ad.get_by_role("button", name="Envoyer l’invitation").click()
    ad.wait_for_selector("text=Invitation en attente")
    check("invitation : statut « Invitation en attente »", prof(LIDO)["status"] == "invited")
    check("pas de transfert possible avant activation", ad.locator("[data-id='%s'] [data-act=transfer]" % LIDO).count() == 0)
    ad.screenshot(path=OUT / "14-administrateurs.png", full_page=True)
    lido = new_page(390, 844, True)
    lido.goto(f"{BASE}/espace-interne/activation#access_token={jwt(LIDO)}&expires_at={int(time.time()) + 3600}&expires_in=3600&refresh_token=r-lido&token_type=bearer&type=invite")
    lido.wait_for_selector("text=Activer mon compte", timeout=15000)
    lido.screenshot(path=OUT / "15-activation.png")
    lido.get_by_label("Votre nom").fill("Cinéma Le Lido")
    lido.get_by_label("Mot de passe", exact=True).fill("LidoMotDePasse2")
    lido.get_by_label("Confirmer le mot de passe").fill("LidoMotDePasse2")
    lido.get_by_role("button", name="Activer mon compte").click()
    lido.get_by_role("heading", name="Tableau de bord").wait_for()
    check("Test 2 : le compte du Lido est activé et accède au tableau de bord", prof(LIDO)["status"] == "active" and USERS[LIDO]["password"] == "LidoMotDePasse2")
    check("administrateur ordinaire : pas de gestion des comptes dans le menu", lido.locator("a[href='/espace-interne/administrateurs']").count() == 0)
    ad.reload()
    ad.wait_for_selector("text=Transférer le rôle principal")
    before = (len(DB["visuals"]), len(DB["movements"]), json.dumps([v["stocks"] for v in DB["visuals"]]))
    ad.locator("[data-id='%s'] [data-act=transfer]" % LIDO).click()
    ad.wait_for_selector("text=Aucune donnée n’est modifiée")
    ad.get_by_role("button", name="Transférer", exact=True).click()
    ad.wait_for_selector("text=Cinéma Le Lido est maintenant administrateur principal")
    check("Test 2 : transfert du rôle principal (atomique, données intactes)", prof(LIDO)["role"] == "owner" and prof(OWNER)["role"] == "admin" and before == (len(DB["visuals"]), len(DB["movements"]), json.dumps([v["stocks"] for v in DB["visuals"]])))
    ad.wait_for_timeout(600)
    check("ancien principal : redirigé, plus d’accès à la gestion des comptes", "/reglages" in ad.url and ad.locator("a[href='/espace-interne/administrateurs']").count() == 0)
    lido.goto(BASE + "/espace-interne/administrateurs")
    lido.wait_for_selector("text=Inviter un administrateur")
    lido.locator("[data-id='%s'] [data-act=disable]" % OWNER).click()
    lido.get_by_role("dialog", name="Désactiver ce compte ?").get_by_role("button", name="Désactiver").click()
    lido.locator(".toast", has_text="Compte désactivé").wait_for()
    check("Test 2 : ancien compte désactivé par le Lido, données conservées", prof(OWNER)["status"] == "disabled" and len(DB["movements"]) > 5)
    ad.goto(BASE + "/espace-interne")
    ad.wait_for_selector("text=Compte désactivé")
    check("compte désactivé : accès révoqué à l’ouverture", ad.get_by_text("Contactez l’administrateur principal").count() == 1)

    print("\nMot de passe oublié (Test 3)")
    lido.goto(BASE + "/espace-interne/mot-de-passe-oublie")
    lido.get_by_label("Adresse e-mail").fill("contact@lido.example")
    lido.get_by_role("button", name="Envoyer le lien").click()
    lido.wait_for_selector("text=un e-mail avec un lien")
    rec = [c for c in CALLS if c[1] == "/auth/v1/recover"][-1]
    check("Test 3 : demande de lien envoyée pour la bonne adresse", rec[2].get("email") == "contact@lido.example")
    lido.goto(f"{BASE}/espace-interne/nouveau-mot-de-passe#access_token={jwt(LIDO)}&expires_at={int(time.time()) + 3600}&expires_in=3600&refresh_token=r-lido&token_type=bearer&type=recovery")
    lido.wait_for_selector("text=Nouveau mot de passe", timeout=15000)
    lido.get_by_label("Nouveau mot de passe").fill("Nouveau-Mdp-2026")
    lido.get_by_label("Confirmer le mot de passe").fill("Nouveau-Mdp-2026")
    lido.get_by_role("button", name="Enregistrer le mot de passe").click()
    lido.wait_for_selector("text=Mot de passe modifié. Connectez-vous")
    check("Test 3 : nouveau mot de passe enregistré, retour à la connexion", USERS[LIDO]["password"] == "Nouveau-Mdp-2026" and "/espace-interne" in lido.url)
    lido.get_by_label("Adresse e-mail").fill("contact@lido.example")
    lido.get_by_label("Mot de passe", exact=True).fill("Nouveau-Mdp-2026")
    lido.get_by_role("button", name="Se connecter").click()
    lido.get_by_role("heading", name="Tableau de bord").wait_for()
    check("Test 3 : reconnexion avec le nouveau mot de passe", True)
    lido.goto(BASE + "/espace-interne/stock")
    lido.reload()
    lido.get_by_role("heading", name="Stock des affiches").wait_for()
    check("actualisation d’une page privée : session conservée", lido.get_by_role("heading", name="Stock des affiches").count() == 1)

    print("\nOrdinateur (captures)")
    d = new_page(1440, 900, False)
    d.goto(BASE + "/")
    d.wait_for_selector("text=Toutes les affiches"); d.wait_for_timeout(900)
    d.screenshot(path=OUT / "20-vitrine-ordinateur.png")
    d.locator("a.pcard[href^='/affiche/vis-2a']").first.click(); d.wait_for_timeout(800)
    d.screenshot(path=OUT / "21-fiche-ordinateur.png")
    d.goto(BASE + "/espace-interne")
    d.get_by_label("Adresse e-mail").fill("contact@lido.example")
    d.get_by_label("Mot de passe", exact=True).fill("Nouveau-Mdp-2026")
    d.get_by_role("button", name="Se connecter").click()
    d.get_by_role("heading", name="Tableau de bord").wait_for(); d.wait_for_timeout(600)
    d.screenshot(path=OUT / "22-tableau-ordinateur.png", full_page=True)
    d.goto(BASE + "/espace-interne/affiche/vis-0a"); d.wait_for_selector("text=Visuels de ce film"); d.wait_for_timeout(700)
    d.screenshot(path=OUT / "23-fiche-admin-ordinateur.png", full_page=True)
    d.goto(BASE + "/espace-interne/administrateurs"); d.wait_for_selector(".admin-row"); d.wait_for_timeout(400)
    d.screenshot(path=OUT / "24-administrateurs-ordinateur.png", full_page=True)
    d.goto(BASE + "/espace-interne/reglages"); d.wait_for_selector("[data-qr] svg"); d.wait_for_timeout(400)
    d.screenshot(path=OUT / "25-reglages-ordinateur.png", full_page=True)
    browser.close()

ignored = ("websocket", "realtime", "Failed to load resource")
real = [e for e in errors if not any(x.lower() in e.lower() for x in ignored)]
print("\nErreurs JavaScript / CSP :", real or "aucune")
print(f"\n{sum(c for _, c in checks)}/{len(checks)} vérifications réussies")
sys.exit(0 if all(c for _, c in checks) and not real else 1)
