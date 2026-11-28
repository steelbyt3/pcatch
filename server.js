"use strict";

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "pcatch-db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const SECRET_FILE = path.join(DATA_DIR, "secret.key");

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
const TEAM_NAME = "husshusshussstudioteam";
const TEAM_ACTOR_ID = "team-husshusshussstudioteam";
// Team-Zugangsdaten liegen jetzt NUR noch hier auf dem Server (nicht mehr in der HTML-Datei).
// Am besten per Umgebungsvariable überschreiben: TEAM_UNLOCK_CODE, TEAM_EMAIL, TEAM_CODE
const TEAM_UNLOCK_CODE = process.env.TEAM_UNLOCK_CODE || "HUSS-UNLOCK-2026";
const TEAM_EMAIL = (process.env.TEAM_EMAIL || "huss-team@husshusshussstudio.de").toLowerCase();
const TEAM_CODE = process.env.TEAM_CODE || "HUSS-PCATCH-2026";

const MANNCHEN_IDS = ["amber", "cyan", "emerald", "rose"];
const GUEST_NAMES = ["Gast", "Guest", "Gość"];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const TOKEN_TTL = { user: 180 * DAY, guest: 365 * DAY, team: 7 * DAY };

const MESSAGES = {
  auth: "Nicht angemeldet.",
  forbidden: "Dazu hast du keine Berechtigung.",
  "not-found": "Nicht gefunden.",
  "username-required": "Bitte gib einen Benutzernamen ein.",
  "reserved-name": "Dieser Name ist exklusiv für das husshusshussstudioteam reserviert.",
  "name-taken": "Dieser Benutzername ist zu ähnlich zu einem bereits vergebenen Namen.",
  "wrong-password": "Falsches Passwort für diesen Account.",
  "password-required": "Für diesen Account ist ein Passwort nötig.",
  "wrong-code": "Zugangscode falsch.",
  "wrong-team": "Zugriff verweigert: E-Mail oder zweiter Team-Code ist falsch.",
  "too-many": "Zu viele Fehlversuche. Bitte warte ein paar Minuten.",
  "rate-limit": "Zu viele Anfragen. Bitte kurz warten.",
  "title-required": "Bitte gib einen Titel ein.",
  "text-required": "Bitte schreibe einen Community-Text.",
  "image-required": "Bitte wähle eine Bilddatei oder gib eine Bild-URL ein.",
  "bad-image": "Das Bild konnte nicht verarbeitet werden.",
  "too-large": "Die Datei ist zu groß.",
  "bad-request": "Ungültige Anfrage."
};

function fail(res, status, code) {
  return res.status(status).json({ error: MESSAGES[code] || code, code });
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function cleanMultiline(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function userActorId(username) {
  return "user-" + String(username).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Passwörter (scrypt-Hash mit Salt, nie im Klartext gespeichert oder ausgeliefert)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(String(password), parts[1], expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Bilder: Data-URLs werden als Dateien in data/uploads gespeichert
// ---------------------------------------------------------------------------
function detectImageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function saveDataUrlImage(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  if (!/^data:image\/(png|jpe?g|webp|gif);base64$/i.test(dataUrl.slice(0, comma))) return null;
  const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const ext = detectImageExt(buf);
  if (!ext) return null;
  const name = crypto.randomBytes(12).toString("hex") + "." + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return "/uploads/" + name;
}

// ---------------------------------------------------------------------------
// Datenbank (JSON-Datei, im Speicher gehalten, atomar geschrieben)
// ---------------------------------------------------------------------------
function normalizePost(p) {
  const likedBy = Array.isArray(p.likedBy) ? Array.from(new Set(p.likedBy.map(String))) : [];
  return {
    ...p,
    id: String(p.id),
    postType: p.postType === "text" ? "text" : "image",
    authorName: p.authorName || "Gast",
    authorMannchen: p.authorMannchen || "amber",
    likedBy,
    likes: likedBy.length > 0 ? likedBy.length : (Number(p.likes) || 0),
    replies: Array.isArray(p.replies) ? p.replies.filter(r => r && r.id) : [],
    tags: Array.isArray(p.tags) ? p.tags : [],
    pinned: Boolean(p.pinned),
    createdAt: Number(p.createdAt) || Date.now()
  };
}

function loadDb() {
  ensureDirs();
  let parsed = {};
  if (fs.existsSync(DB_FILE)) {
    try {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch (err) {
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      console.error("Datenbank unlesbar, Kopie gesichert unter:", backup, err.message);
      try { fs.copyFileSync(DB_FILE, backup); } catch {}
      parsed = {};
    }
  }

  const result = {
    posts: (Array.isArray(parsed.posts) ? parsed.posts : []).filter(p => p && p.id).map(normalizePost),
    verifiedUsers: Array.from(new Set([TEAM_NAME, ...(Array.isArray(parsed.verifiedUsers) ? parsed.verifiedUsers.map(String) : [])])),
    accounts: [],
    rev: Number(parsed.rev) || 0,
    updatedAt: Number(parsed.updatedAt) || Date.now()
  };

  let changed = false;

  // Accounts übernehmen; Klartext-Passwörter aus älteren Versionen werden einmalig gehasht
  for (const acc of Array.isArray(parsed.accounts) ? parsed.accounts : []) {
    if (!acc || typeof acc.username !== "string" || !acc.username.trim()) continue;
    let passwordHash = typeof acc.passwordHash === "string" ? acc.passwordHash : "";
    if (passwordHash && !passwordHash.startsWith("scrypt$")) {
      passwordHash = hashPassword(passwordHash);
      changed = true;
    }
    result.accounts.push({
      username: acc.username.trim(),
      passwordHash,
      mannchenId: MANNCHEN_IDS.includes(acc.mannchenId) ? acc.mannchenId : "amber",
      createdAt: Number(acc.createdAt) || Number(acc.updatedAt) || Date.now(),
      updatedAt: Number(acc.updatedAt) || Date.now()
    });
  }

  // Alte Beiträge mit Base64-Bild im JSON in echte Bilddateien auslagern
  for (const post of result.posts) {
    if (typeof post.imageUrl === "string" && post.imageUrl.startsWith("data:image/")) {
      const url = saveDataUrlImage(post.imageUrl);
      if (url) {
        post.imageUrl = url;
        changed = true;
      }
    }
  }

  db = result;
  if (changed) saveDb();
  return result;
}

let db = null;

function saveDb() {
  db.rev += 1;
  db.updatedAt = Date.now();
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

function publicAccount(acc) {
  return { username: acc.username, mannchenId: acc.mannchenId, hasPassword: Boolean(acc.passwordHash) };
}

function findAccount(username) {
  const lower = String(username).toLowerCase();
  return db.accounts.find(a => a.username.toLowerCase() === lower);
}

function findPost(id) {
  return db.posts.find(p => p.id === id);
}

function removeUploadIfUnused(imageUrl) {
  if (typeof imageUrl !== "string" || !imageUrl.startsWith("/uploads/")) return;
  if (db.posts.some(p => p.imageUrl === imageUrl)) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(imageUrl)), () => {});
}

// ---------------------------------------------------------------------------
// Tokens (signiert, überleben Server-Neustarts)
// ---------------------------------------------------------------------------
function loadSecret() {
  if (process.env.PCATCH_SECRET) return process.env.PCATCH_SECRET;
  try {
    const s = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (s) return s;
  } catch {}
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

let SECRET = null;

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL[payload.mode] })).toString("base64url");
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionFor(identity) {
  const token = signToken({
    mode: identity.mode,
    name: identity.name,
    actorId: identity.actorId,
    mannchenId: identity.mannchenId
  });
  return {
    mode: identity.mode,
    name: identity.name,
    actorId: identity.actorId,
    mannchenId: identity.mannchenId,
    token
  };
}

function authenticate(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const payload = match ? verifyToken(match[1]) : null;
  if (!payload) return fail(res, 401, "auth");

  if (payload.mode === "team") {
    req.identity = { mode: "team", name: TEAM_NAME, actorId: TEAM_ACTOR_ID, mannchenId: "crown" };
  } else if (payload.mode === "user") {
    const acc = findAccount(payload.name);
    if (!acc) return fail(res, 401, "auth");
    req.identity = { mode: "user", name: acc.username, actorId: userActorId(acc.username), mannchenId: acc.mannchenId };
  } else if (payload.mode === "guest") {
    const name = GUEST_NAMES.includes(payload.name) ? payload.name : "Gast";
    const mannchenId = MANNCHEN_IDS.includes(payload.mannchenId) ? payload.mannchenId : "amber";
    req.identity = { mode: "guest", name, actorId: String(payload.actorId), mannchenId };
  } else {
    return fail(res, 401, "auth");
  }
  next();
}

function requireTeam(req, res, next) {
  if (!req.identity || req.identity.mode !== "team") return fail(res, 403, "forbidden");
  next();
}

// ---------------------------------------------------------------------------
// Begrenzungen gegen Missbrauch
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter(ts => now - ts < windowMs);
  if (recent.length >= max) {
    rateBuckets.set(key, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  return false;
}

const failures = new Map();
const FAIL_LIMIT = 8;
const FAIL_WINDOW = 10 * 60 * 1000;
function isLocked(key) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > FAIL_WINDOW) {
    failures.delete(key);
    return false;
  }
  return entry.count >= FAIL_LIMIT;
}
function noteFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > FAIL_WINDOW) {
    failures.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}
function clearFailures(key) {
  failures.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, list] of rateBuckets) {
    const recent = list.filter(ts => now - ts < 60 * 60 * 1000);
    if (recent.length) rateBuckets.set(key, recent); else rateBuckets.delete(key);
  }
  for (const [key, entry] of failures) {
    if (now - entry.first > FAIL_WINDOW) failures.delete(key);
  }
}, 10 * 60 * 1000).unref();

function clientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

function wrap(fn) {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Beiträge bauen/prüfen
// ---------------------------------------------------------------------------
function buildPost(input, identity, options = {}) {
  const postType = input.postType === "text" ? "text" : "image";
  const title = cleanText(input.title, 90);
  if (!title) return { error: "title-required" };

  const description = cleanMultiline(input.description, 1200);
  if (postType === "text" && !description) return { error: "text-required" };

  const category = cleanText(input.category, 30) || "Allgemein";
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map(tag => cleanText(tag, 30).replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 10);

  let imageUrl = "";
  if (postType === "image") {
    const raw = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
    if (raw.startsWith("data:")) {
      imageUrl = saveDataUrlImage(raw);
      if (!imageUrl) return { error: "bad-image" };
    } else if (/^https?:\/\/[^\s"'<>]{1,1990}$/i.test(raw)) {
      imageUrl = raw;
    } else {
      return { error: "image-required" };
    }
  }

  let createdAt = Date.now();
  if (options.createdAt) {
    const ts = Number(options.createdAt);
    if (Number.isFinite(ts) && ts > 0 && ts <= Date.now()) createdAt = ts;
  }

  return {
    post: {
      id: options.id || newId("post"),
      postType,
      title,
      category,
      description,
      imageUrl,
      tags,
      authorName: identity.name,
      authorMannchen: identity.mannchenId,
      ownerId: identity.actorId,
      pinned: false,
      likes: 0,
      likedBy: [],
      replies: [],
      createdAt
    }
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: "16mb" }));

app.use("/uploads", express.static(UPLOAD_DIR, {
  maxAge: "30d",
  immutable: true,
  index: false,
  dotfiles: "ignore",
  setHeaders: res => res.setHeader("X-Content-Type-Options", "nosniff")
}));

app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "p_catch.html");
  if (fs.existsSync(htmlPath)) {
    res.set("Cache-Control", "no-cache");
    return res.sendFile(htmlPath);
  }
  return res.status(200).json({ ok: true, service: "P CATCH Backend Server" });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "pcatch" });
});

// --- Zustand (öffentlich lesbar; enthält keine Passwörter und keine Account-Liste) ---
app.get("/api/state", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.query.since !== undefined && Number(req.query.since) === db.rev) {
    return res.json({ unchanged: true, rev: db.rev });
  }
  res.json({
    posts: db.posts,
    verifiedUsers: db.verifiedUsers,
    rev: db.rev,
    updatedAt: db.updatedAt
  });
});

// Der alte "gesamten Zustand hochladen"-Weg ist abgeschaltet (er konnte fremde Beiträge überschreiben)
app.post("/api/state", (req, res) => {
  res.status(410).json({ error: "Veraltete Seite – bitte neu laden.", code: "gone" });
});

// --- Gast ---
app.post("/api/guest", wrap((req, res) => {
  if (rateLimited("guest|" + clientKey(req), 60, 10 * 60 * 1000)) return fail(res, 429, "rate-limit");
  const body = req.body || {};
  const identity = {
    mode: "guest",
    name: GUEST_NAMES.includes(body.name) ? body.name : "Gast",
    actorId: "guest-" + crypto.randomBytes(6).toString("hex"),
    mannchenId: MANNCHEN_IDS.includes(body.mannchenId) ? body.mannchenId : "amber"
  };
  res.json({ ok: true, session: sessionFor(identity) });
}));

// --- Mitglieder-Login (legt den Account beim ersten Login an) ---
app.post("/api/login", wrap((req, res) => {
  const body = req.body || {};
  const username = cleanText(body.username, 32);
  const password = typeof body.password === "string" ? body.password.slice(0, 40) : "";
  const mannchenId = MANNCHEN_IDS.includes(body.mannchenId) ? body.mannchenId : null;

  if (!username) return fail(res, 400, "username-required");
  if (username.toLowerCase() === TEAM_NAME.toLowerCase()) return fail(res, 403, "reserved-name");

  const key = `login|${clientKey(req)}|${username.toLowerCase()}`;
  if (isLocked(key)) return fail(res, 429, "too-many");

  const now = Date.now();
  let acc = findAccount(username);

  if (!acc) {
    if (db.accounts.some(a => userActorId(a.username) === userActorId(username))) {
      return fail(res, 409, "name-taken");
    }
    acc = {
      username,
      passwordHash: password ? hashPassword(password) : "",
      mannchenId: mannchenId || "amber",
      createdAt: now,
      updatedAt: now
    };
    db.accounts.push(acc);
  } else {
    if (acc.passwordHash) {
      if (!password) {
        return fail(res, 401, "password-required");
      }
      if (!checkPassword(password, acc.passwordHash)) {
        noteFailure(key);
        return fail(res, 401, "wrong-password");
      }
    } else if (password) {
      acc.passwordHash = hashPassword(password);
    }
    clearFailures(key);
    if (mannchenId) acc.mannchenId = mannchenId;
    acc.updatedAt = now;
  }

  saveDb();
  const identity = { mode: "user", name: acc.username, actorId: userActorId(acc.username), mannchenId: acc.mannchenId };
  res.json({ ok: true, session: sessionFor(identity), account: publicAccount(acc) });
}));

// --- Einmalige Übernahme alter, nur lokal gespeicherter Accounts (inkl. Passwort) ---
app.post("/api/accounts/import", wrap((req, res) => {
  if (rateLimited("import|" + clientKey(req), 10, 10 * 60 * 1000)) return fail(res, 429, "rate-limit");
  const list = Array.isArray(req.body && req.body.accounts) ? req.body.accounts.slice(0, 50) : [];
  const now = Date.now();
  const accounts = [];
  let created = 0;

  for (const raw of list) {
    if (!raw) continue;
    const username = cleanText(raw.username, 32);
    if (!username || username.toLowerCase() === TEAM_NAME.toLowerCase()) continue;
    if (findAccount(username)) continue;
    if (db.accounts.some(a => userActorId(a.username) === userActorId(username))) continue;
    const password = typeof raw.password === "string" ? raw.password.slice(0, 40) : "";
    const acc = {
      username,
      passwordHash: password ? hashPassword(password) : "",
      mannchenId: MANNCHEN_IDS.includes(raw.mannchenId) ? raw.mannchenId : "amber",
      createdAt: now,
      updatedAt: now
    };
    db.accounts.push(acc);
    accounts.push(publicAccount(acc));
    created += 1;
  }

  if (created) saveDb();
  res.json({ ok: true, created, accounts });
}));

// --- Team-Login (Schritt 1: Zugangscode prüfen, Schritt 2: E-Mail + zweiter Code) ---
app.post("/api/team/check", wrap((req, res) => {
  const key = "team|" + clientKey(req);
  if (isLocked(key)) return fail(res, 429, "too-many");
  const code = String((req.body && req.body.code) || "").trim();
  if (!safeEqual(code, TEAM_UNLOCK_CODE)) {
    noteFailure(key);
    return fail(res, 403, "wrong-code");
  }
  res.json({ ok: true });
}));

app.post("/api/team/login", wrap((req, res) => {
  const key = "team|" + clientKey(req);
  if (isLocked(key)) return fail(res, 429, "too-many");
  const body = req.body || {};
  const unlockCode = String(body.unlockCode || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  const okUnlock = safeEqual(unlockCode, TEAM_UNLOCK_CODE);
  const okEmail = safeEqual(email, TEAM_EMAIL);
  const okCode = safeEqual(code, TEAM_CODE);
  if (!(okUnlock && okEmail && okCode)) {
    noteFailure(key);
    return fail(res, 403, "wrong-team");
  }
  clearFailures(key);
  const identity = { mode: "team", name: TEAM_NAME, actorId: TEAM_ACTOR_ID, mannchenId: "crown" };
  res.json({ ok: true, session: sessionFor(identity) });
}));

// --- Beiträge ---
app.post("/api/posts", authenticate, wrap((req, res) => {
  if (rateLimited("post|" + req.identity.actorId, 10, 60 * 1000)) return fail(res, 429, "rate-limit");
  const built = buildPost(req.body || {}, req.identity);
  if (built.error) return fail(res, 400, built.error);
  db.posts.unshift(built.post);
  saveDb();
  res.status(201).json({ ok: true, post: built.post, rev: db.rev });
}));

// Übernahme alter, nur lokal gespeicherter Beiträge des eigenen Accounts (ohne Antworten/Likes)
app.post("/api/posts/import", authenticate, wrap((req, res) => {
  const legacy = req.body && req.body.post;
  if (!legacy || typeof legacy.id !== "string" || legacy.id.length > 80) return fail(res, 400, "bad-request");

  if (findPost(legacy.id)) return res.json({ ok: true, existed: true });

  const own = legacy.ownerId === req.identity.actorId;
  const legacyGuest = req.identity.mode === "guest" && typeof legacy.ownerId === "string" && legacy.ownerId.startsWith("guest-");
  if (!own && !legacyGuest) return fail(res, 403, "forbidden");

  if (rateLimited("import-post|" + req.identity.actorId, 200, 10 * 60 * 1000)) return fail(res, 429, "rate-limit");

  const built = buildPost(legacy, req.identity, { id: legacy.id, createdAt: legacy.createdAt });
  if (built.error) return fail(res, 400, built.error);
  db.posts.push(built.post);
  db.posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  saveDb();
  res.status(201).json({ ok: true, post: built.post });
}));

app.post("/api/posts/:id/replies", authenticate, wrap((req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, "not-found");
  if (rateLimited("reply|" + req.identity.actorId, 20, 60 * 1000)) return fail(res, 429, "rate-limit");

  const text = cleanMultiline(req.body && req.body.text, 300);
  if (!text) return fail(res, 400, "bad-request");

  post.replies.push({
    id: newId("reply"),
    authorName: req.identity.name,
    mannchenId: req.identity.mannchenId,
    text,
    createdAt: Date.now()
  });
  saveDb();
  res.status(201).json({ ok: true, post });
}));

// Like pro Account/Gast-Identität umschalten (max. 1 Like pro Identität)
app.post("/api/posts/:id/like", authenticate, wrap((req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, "not-found");

  const actorId = req.identity.actorId;
  const idx = post.likedBy.indexOf(actorId);
  let liked;
  if (idx >= 0) {
    post.likedBy.splice(idx, 1);
    liked = false;
  } else {
    post.likedBy.push(actorId);
    liked = true;
  }
  post.likes = post.likedBy.length;
  saveDb();
  res.json({ ok: true, liked, likes: post.likes, likedBy: post.likedBy, post });
}));

app.post("/api/posts/:id/pin", authenticate, requireTeam, wrap((req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, "not-found");
  post.pinned = typeof (req.body && req.body.pinned) === "boolean" ? req.body.pinned : !post.pinned;
  saveDb();
  res.json({ ok: true, post });
}));

app.delete("/api/posts/:id", authenticate, wrap((req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, "not-found");
  if (req.identity.mode !== "team" && post.ownerId !== req.identity.actorId) return fail(res, 403, "forbidden");

  db.posts = db.posts.filter(p => p.id !== post.id);
  saveDb();
  removeUploadIfUnused(post.imageUrl);
  res.json({ ok: true });
}));

// --- Verifizierte Nutzer (nur Team) ---
app.post("/api/verified", authenticate, requireTeam, wrap((req, res) => {
  const username = cleanText(req.body && req.body.username, 32);
  if (!username) return fail(res, 400, "bad-request");
  const lower = username.toLowerCase();
  const verified = !(req.body && req.body.verified === false);

  if (verified) {
    if (!db.verifiedUsers.some(u => u.toLowerCase() === lower)) db.verifiedUsers.push(username);
  } else if (lower !== TEAM_NAME.toLowerCase()) {
    db.verifiedUsers = db.verifiedUsers.filter(u => u.toLowerCase() !== lower);
  }
  saveDb();
  res.json({ ok: true, verifiedUsers: db.verifiedUsers });
}));

// --- Fehlerbehandlung ---
app.use("/api", (req, res) => fail(res, 404, "not-found"));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return fail(res, 413, "too-large");
  if (err instanceof SyntaxError) return fail(res, 400, "bad-request");
  console.error("Serverfehler:", err);
  res.status(500).json({ error: "Serverfehler", code: "server-error" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
ensureDirs();
SECRET = loadSecret();
loadDb();

app.listen(PORT, () => {
  console.log(`P CATCH Backend läuft auf http://localhost:${PORT}`);
  console.log(`Datenbankdatei: ${DB_FILE}`);
  console.log(`Bilder-Ordner:  ${UPLOAD_DIR}`);
});
