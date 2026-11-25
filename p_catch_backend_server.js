const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "pcatch-db.json");

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Serve p_catch.html if placed next to server.js
app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "p_catch.html");
  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlPath);
  }
  return res.status(200).json({ ok: true, service: "P CATCH Backend Server" });
});

function createDefaultDb() {
  return {
    posts: [],
    verifiedUsers: ["husshusshussstudioteam"],
    accounts: [],
    updatedAt: Date.now()
  };
}

function ensureDbFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(createDefaultDb(), null, 2), "utf8");
    }
  } catch (err) {
    console.error("Fehler beim Initialisieren der Datenbankdatei:", err);
  }
}

function readDb() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const verifiedSet = new Set([
      "husshusshussstudioteam",
      ...(Array.isArray(parsed.verifiedUsers) ? parsed.verifiedUsers : [])
    ]);
    return {
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      verifiedUsers: Array.from(verifiedSet),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      updatedAt: Number(parsed.updatedAt) || Date.now()
    };
  } catch (err) {
    console.error("Fehler beim Lesen der Datenbank:", err);
    return createDefaultDb();
  }
}

function writeDb(dbData) {
  ensureDbFile();
  const payload = {
    posts: Array.isArray(dbData.posts) ? dbData.posts : [],
    verifiedUsers: Array.from(
      new Set([
        "husshusshussstudioteam",
        ...(Array.isArray(dbData.verifiedUsers) ? dbData.verifiedUsers : [])
      ])
    ),
    accounts: Array.isArray(dbData.accounts) ? dbData.accounts : [],
    updatedAt: Date.now()
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function mergePosts(existingPosts, incomingPosts) {
  const map = new Map();
  const all = [...(Array.isArray(existingPosts) ? existingPosts : []), ...(Array.isArray(incomingPosts) ? incomingPosts : [])];

  for (const item of all) {
    if (!item || !item.id) continue;
    const normalized = {
      ...item,
      postType: item.postType === "text" ? "text" : "image",
      authorName: item.authorName || "Gast",
      authorMannchen: item.authorMannchen || "amber",
      likes: Number(item.likes) || 0,
      replies: Array.isArray(item.replies) ? item.replies : [],
      tags: Array.isArray(item.tags) ? item.tags : [],
      pinned: Boolean(item.pinned),
      createdAt: Number(item.createdAt) || Date.now()
    };

    const prev = map.get(normalized.id);
    if (!prev) {
      map.set(normalized.id, normalized);
    } else {
      const replyMap = new Map();
      for (const r of [...(prev.replies || []), ...(normalized.replies || [])]) {
        if (r && r.id) replyMap.set(r.id, r);
      }
      map.set(normalized.id, {
        ...prev,
        ...normalized,
        likes: Math.max(Number(prev.likes) || 0, Number(normalized.likes) || 0),
        pinned: Boolean(prev.pinned || normalized.pinned),
        replies: Array.from(replyMap.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function mergeAccounts(existingAccounts, incomingAccounts) {
  const map = new Map();
  for (const acc of Array.isArray(existingAccounts) ? existingAccounts : []) {
    if (acc && acc.username) {
      map.set(String(acc.username).toLowerCase(), acc);
    }
  }
  for (const acc of Array.isArray(incomingAccounts) ? incomingAccounts : []) {
    if (!acc || !acc.username) continue;
    const key = String(acc.username).toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, acc);
    } else {
      map.set(key, {
        ...prev,
        ...acc,
        passwordHash: acc.passwordHash || prev.passwordHash || "",
        mannchenId: acc.mannchenId || prev.mannchenId || "amber",
        updatedAt: Math.max(Number(prev.updatedAt) || 0, Number(acc.updatedAt) || 0)
      });
    }
  }
  return Array.from(map.values());
}

// GET /api/state -> Gibt alle gespeicherten Beiträge, Accounts & Verifizierungen zurück
app.get("/api/state", (req, res) => {
  try {
    const db = readDb();
    res.json(db);
  } catch (err) {
    console.error("GET /api/state Fehler:", err);
    res.status(500).json({ error: "Konnte Zustand nicht laden" });
  }
});

// POST /api/state -> Speichert/synchronisiert den gesamten Zustand dauerhaft auf der Festplatte
app.post("/api/state", (req, res) => {
  try {
    const current = readDb();
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const nextPosts = Array.isArray(body.posts)
      ? (body.explicitReplacePosts === true ? body.posts : mergePosts(current.posts, body.posts))
      : current.posts;

    const nextVerified = Array.isArray(body.verifiedUsers)
      ? Array.from(new Set(["husshusshussstudioteam", ...current.verifiedUsers, ...body.verifiedUsers]))
      : current.verifiedUsers;

    const nextAccounts = Array.isArray(body.accounts)
      ? mergeAccounts(current.accounts, body.accounts)
      : current.accounts;

    const saved = writeDb({
      posts: nextPosts,
      verifiedUsers: nextVerified,
      accounts: nextAccounts
    });

    res.json(saved);
  } catch (err) {
    console.error("POST /api/state Fehler:", err);
    res.status(500).json({ error: "Konnte Zustand nicht speichern" });
  }
});

// POST /api/posts -> Fügt einen neuen Beitrag direkt und dauerhaft hinzu
app.post("/api/posts", (req, res) => {
  try {
    const post = req.body;
    if (!post || !post.id || !post.title) {
      return res.status(400).json({ error: "Ungültiger Beitrag" });
    }
    const current = readDb();
    const updatedPosts = mergePosts(current.posts, [post]);
    const saved = writeDb({
      ...current,
      posts: updatedPosts
    });
    return res.status(201).json({ ok: true, post, updatedAt: saved.updatedAt });
  } catch (err) {
    console.error("POST /api/posts Fehler:", err);
    return res.status(500).json({ error: "Fehler beim Speichern des Beitrags" });
  }
});

// POST /api/posts/:id/replies -> Fügt eine Antwort zu einem Beitrag hinzu
app.post("/api/posts/:id/replies", (req, res) => {
  try {
    const postId = req.params.id;
    const reply = req.body;
    if (!reply || !reply.id || !reply.text) {
      return res.status(400).json({ error: "Ungültige Antwort" });
    }
    const current = readDb();
    const found = current.posts.find(p => p.id === postId);
    if (!found) {
      return res.status(404).json({ error: "Beitrag nicht gefunden" });
    }
    found.replies = Array.isArray(found.replies) ? found.replies : [];
    if (!found.replies.some(r => r.id === reply.id)) {
      found.replies.push(reply);
    }
    const saved = writeDb(current);
    return res.status(201).json({ ok: true, post: found, updatedAt: saved.updatedAt });
  } catch (err) {
    console.error("POST /api/posts/:id/replies Fehler:", err);
    return res.status(500).json({ error: "Fehler beim Speichern der Antwort" });
  }
});

// POST /api/posts/:id/like -> Erhöht Likes dauerhaft
app.post("/api/posts/:id/like", (req, res) => {
  try {
    const postId = req.params.id;
    const current = readDb();
    const found = current.posts.find(p => p.id === postId);
    if (!found) {
      return res.status(404).json({ error: "Beitrag nicht gefunden" });
    }
    found.likes = (Number(found.likes) || 0) + 1;
    const saved = writeDb(current);
    return res.json({ ok: true, likes: found.likes, updatedAt: saved.updatedAt });
  } catch (err) {
    console.error("POST /api/posts/:id/like Fehler:", err);
    return res.status(500).json({ error: "Fehler beim Liken" });
  }
});

// DELETE /api/posts/:id -> Löscht einen Beitrag nur bei explizitem DELETE-Request
app.delete("/api/posts/:id", (req, res) => {
  try {
    const postId = req.params.id;
    const current = readDb();
    const filtered = current.posts.filter(p => p.id !== postId);
    const saved = writeDb({
      ...current,
      posts: filtered
    });
    return res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (err) {
    console.error("DELETE /api/posts/:id Fehler:", err);
    return res.status(500).json({ error: "Fehler beim Löschen des Beitrags" });
  }
});

ensureDbFile();
app.listen(PORT, () => {
  console.log(`P CATCH Backend läuft auf http://localhost:${PORT}`);
  console.log(`Datenbankdatei: ${DB_FILE}`);
});