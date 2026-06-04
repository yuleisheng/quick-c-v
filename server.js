const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { DatabaseSync } = require("node:sqlite");
const { WebSocket, WebSocketServer } = require("ws");
const { DEFAULT_PORT, parsePortArgs, parsePortValue } = require("./lib/config");
const { getLanUrls } = require("./lib/network");

const HOST = process.env.HOST || "0.0.0.0";
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const CODE_REGEX = /^[A-Z0-9]{1,32}$/;
const SERVER_STATE_PATH = path.join(__dirname, "data", "server.json");
const MEDIA_TYPES = new Map([
  ["image/avif", { kind: "image", extension: ".avif" }],
  ["image/gif", { kind: "image", extension: ".gif" }],
  ["image/heic", { kind: "image", extension: ".heic" }],
  ["image/heif", { kind: "image", extension: ".heif" }],
  ["image/jpeg", { kind: "image", extension: ".jpg" }],
  ["image/png", { kind: "image", extension: ".png" }],
  ["image/webp", { kind: "image", extension: ".webp" }],
  ["video/mp4", { kind: "video", extension: ".mp4" }],
  ["video/mpeg", { kind: "video", extension: ".mpeg" }],
  ["video/quicktime", { kind: "video", extension: ".mov" }],
  ["video/webm", { kind: "video", extension: ".webm" }]
]);

function normalizeCode(input) {
  return String(input || "")
    .trim()
    .toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function mediaInfoFor(mimeType) {
  return MEDIA_TYPES.get(String(mimeType || "").toLowerCase());
}

function fileTypeFor(mimeType) {
  return mediaInfoFor(mimeType)?.kind || "";
}

function displayNameFor(originalName, fallback) {
  const displayName = path.basename(String(originalName || ""))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (displayName || fallback).slice(0, 180);
}

function mediaUrlFor(fileName) {
  return `/uploads/${encodeURIComponent(fileName)}`;
}

function uploadedFilePath(uploadDir, fileName) {
  const root = path.resolve(uploadDir);
  const filePath = path.resolve(root, fileName);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid upload path.");
  }
  return filePath;
}

function createStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      file_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (code) REFERENCES rooms(code) ON DELETE CASCADE
    )
  `);

  const findRoom = db.prepare("SELECT code, text, updated_at AS updatedAt FROM rooms WHERE code = ?");
  const insertRoom = db.prepare("INSERT INTO rooms (code, text, updated_at) VALUES (?, '', ?)");
  const saveRoom = db.prepare(`
    INSERT INTO rooms (code, text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
  `);
  const insertMedia = db.prepare(`
    INSERT INTO media (id, code, file_name, original_name, mime_type, kind, size, created_at)
    VALUES (@id, @code, @fileName, @originalName, @mimeType, @kind, @size, @createdAt)
  `);
  const findMedia = db.prepare(`
    SELECT
      id,
      code,
      file_name AS fileName,
      original_name AS originalName,
      mime_type AS mimeType,
      kind,
      size,
      created_at AS createdAt
    FROM media
    WHERE code = ? AND id = ?
  `);
  const deleteMedia = db.prepare("DELETE FROM media WHERE code = ? AND id = ?");
  const listMedia = db.prepare(`
    SELECT
      id,
      file_name AS fileName,
      original_name AS originalName,
      mime_type AS mimeType,
      kind,
      size,
      created_at AS createdAt
    FROM media
    WHERE code = ?
    ORDER BY created_at ASC
  `);

  return {
    getRoom(code) {
      let room = findRoom.get(code);
      if (!room) {
        insertRoom.run(code, nowIso());
        room = findRoom.get(code);
      }
      return {
        ...room,
        media: listMedia.all(code).map((item) => ({
          id: item.id,
          type: item.kind,
          url: mediaUrlFor(item.fileName),
          name: item.originalName,
          mimeType: item.mimeType,
          size: item.size,
          createdAt: item.createdAt
        }))
      };
    },
    saveRoom(code, text) {
      const updatedAt = nowIso();
      saveRoom.run(code, text, updatedAt);
      return this.getRoom(code);
    },
    addMedia(code, file) {
      this.getRoom(code);
      const item = {
        id: file.generatedId,
        code,
        fileName: file.filename,
        originalName: displayNameFor(file.originalname, file.filename),
        mimeType: file.mimetype,
        kind: fileTypeFor(file.mimetype),
        size: file.size,
        createdAt: nowIso()
      };
      insertMedia.run(item);
      return this.getRoom(code);
    },
    removeMedia(code, id) {
      const media = findMedia.get(code, id);
      if (!media) {
        return { room: this.getRoom(code), media: undefined };
      }

      deleteMedia.run(code, id);
      return {
        room: this.getRoom(code),
        media: {
          id: media.id,
          type: media.kind,
          url: mediaUrlFor(media.fileName),
          fileName: media.fileName,
          name: media.originalName,
          mimeType: media.mimeType,
          size: media.size,
          createdAt: media.createdAt
        }
      };
    },
    close() {
      db.close();
    }
  };
}

function writeServerState(port) {
  fs.mkdirSync(path.dirname(SERVER_STATE_PATH), { recursive: true });
  fs.writeFileSync(
    SERVER_STATE_PATH,
    JSON.stringify({ port, host: HOST, updatedAt: nowIso() }, null, 2)
  );
}

function validatePasscodeParam(req, res, next) {
  const code = normalizeCode(req.params.code);
  if (!CODE_REGEX.test(code)) {
    res.status(400).json({ error: "Passcodes must be 1-32 letters or numbers." });
    return;
  }

  req.roomCode = code;
  next();
}

function applyUpload(upload, fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (error) => {
      if (!error) {
        next();
        return;
      }

      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Uploads must be 100 MB or smaller." });
        return;
      }

      res.status(400).json({ error: "Could not upload that file." });
    });
  };
}

function createApp(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(__dirname, "data", "sync.db");
  const uploadDir = options.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
  const store = createStore(dbPath);
  const rooms = new Map();
  const publicDir = path.join(__dirname, "public");
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination(req, file, callback) {
        callback(null, uploadDir);
      },
      filename(req, file, callback) {
        const mediaInfo = mediaInfoFor(file.mimetype);
        if (!mediaInfo) {
          callback(new Error("Unsupported media type"));
          return;
        }

        const id = crypto.randomUUID();
        file.generatedId = id;
        callback(null, `${id}${mediaInfo.extension}`);
      }
    }),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1
    },
    fileFilter(req, file, callback) {
      callback(null, Boolean(mediaInfoFor(file.mimetype)));
    }
  });

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "600kb" }));
  app.use("/uploads", express.static(uploadDir, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
  }));
  app.use(express.static(publicDir));

  app.get("/api/room/:code", validatePasscodeParam, (req, res) => {
    const room = store.getRoom(req.roomCode);
    res.json(room);
  });

  app.post("/api/room/:code/media", validatePasscodeParam, applyUpload(upload, "file"), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Upload an image or video file." });
      return;
    }

    const room = store.addMedia(req.roomCode, req.file);
    broadcast(req.roomCode, {
      type: "snapshot",
      text: room.text,
      media: room.media,
      updatedAt: room.updatedAt
    });
    res.status(201).json(room.media[room.media.length - 1]);
  });

  app.delete("/api/room/:code/media/:id", validatePasscodeParam, (req, res) => {
    const removed = store.removeMedia(req.roomCode, req.params.id);
    if (!removed.media) {
      res.status(404).json({ error: "Media not found." });
      return;
    }

    fs.rm(uploadedFilePath(uploadDir, removed.media.fileName), { force: true }, () => {});
    broadcast(req.roomCode, {
      type: "snapshot",
      text: removed.room.text,
      media: removed.room.media,
      updatedAt: removed.room.updatedAt
    });
    res.status(204).end();
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: MAX_TEXT_BYTES + 1024
  });

  function clientsFor(code) {
    if (!rooms.has(code)) {
      rooms.set(code, new Set());
    }
    return rooms.get(code);
  }

  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function broadcast(code, payload) {
    for (const client of clientsFor(code)) {
      send(client, payload);
    }
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const code = normalizeCode(url.searchParams.get("code"));

    if (!CODE_REGEX.test(code)) {
      ws.close(1008, "Invalid passcode");
      return;
    }

    const clients = clientsFor(code);
    clients.add(ws);

    const room = store.getRoom(code);
    send(ws, {
      type: "snapshot",
      text: room.text,
      media: room.media,
      updatedAt: room.updatedAt
    });

    ws.on("message", (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage);
      } catch {
        send(ws, { type: "error", error: "Invalid JSON message." });
        return;
      }

      if (message.type !== "update" || typeof message.text !== "string") {
        send(ws, { type: "error", error: "Expected an update message with text." });
        return;
      }

      if (Buffer.byteLength(message.text, "utf8") > MAX_TEXT_BYTES) {
        send(ws, { type: "error", error: "Text is too large for this tiny sync app." });
        return;
      }

      const saved = store.saveRoom(code, message.text);
      broadcast(code, {
        type: "snapshot",
        text: saved.text,
        media: saved.media,
        updatedAt: saved.updatedAt
      });
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (clients.size === 0) {
        rooms.delete(code);
      }
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  server.on("close", () => {
    wss.close();
    store.close();
  });

  return { app, server, store, normalizeCode };
}

if (require.main === module) {
  let port;
  try {
    port = parsePortArgs(process.argv.slice(2)) || parsePortValue(process.env.PORT) || DEFAULT_PORT;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const { server } = createApp();
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    writeServerState(actualPort);

    console.log(`Quick C V is running at http://localhost:${actualPort}`);
    const lanUrls = getLanUrls(actualPort);
    if (lanUrls.length) {
      console.log("Open this on other devices on the same network:");
      for (const url of lanUrls) {
        console.log(`  ${url}`);
      }
    }
  });
}

module.exports = {
  createApp,
  normalizeCode
};
