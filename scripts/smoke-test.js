const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { createApp } = require("../server");

const dbPath = path.join(os.tmpdir(), `quick-c-v-test-${process.pid}.db`);
const uploadDir = path.join(os.tmpdir(), `quick-c-v-test-uploads-${process.pid}`);
const { server } = createApp({ dbPath, uploadDir });
const sockets = new Set();

function listen() {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

function waitForOpen(ws) {
  return withTimeout(new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  }), "Timed out waiting for WebSocket to open.");
}

function nextSnapshot(ws) {
  return withTimeout(new Promise((resolve) => {
    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(raw);
      if (message.type === "snapshot") {
        ws.off("message", onMessage);
        resolve(message);
      }
    });
  }), "Timed out waiting for a snapshot message.");
}

function nextSnapshotWhere(ws, predicate) {
  return withTimeout(new Promise((resolve) => {
    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(raw);
      if (message.type === "snapshot" && predicate(message)) {
        ws.off("message", onMessage);
        resolve(message);
      }
    });
  }), "Timed out waiting for the expected snapshot message.");
}

function withTimeout(promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForFileMissing(filePath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (!fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Expected ${filePath} to be removed.`);
}

async function main() {
  const port = await listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  const invalid = await fetch(`${baseUrl}/api/room/not-ok!`);
  if (invalid.status !== 400) {
    throw new Error("Expected invalid room code to return 400.");
  }

  const room = await fetch(`${baseUrl}/api/room/abc123`).then((response) => response.json());
  if (room.code !== "ABC123" || room.text !== "") {
    throw new Error("Room fetch did not normalize/create the room.");
  }

  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?code=ABC123`);
  const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?code=ABC123`);
  sockets.add(wsA);
  sockets.add(wsB);
  const initialA = nextSnapshot(wsA);
  const initialB = nextSnapshot(wsB);
  await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

  await Promise.all([initialA, initialB]);
  const receivedByB = nextSnapshot(wsB);
  wsA.send(JSON.stringify({ type: "update", text: "hello from smoke test" }));

  const snapshot = await receivedByB;
  if (snapshot.text !== "hello from smoke test") {
    throw new Error("WebSocket clients did not receive the synced update.");
  }

  const mediaReceivedByB = nextSnapshotWhere(wsB, (message) => message.media && message.media.length === 1);
  const tinyPng = new Blob([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  ], { type: "image/png" });
  const form = new FormData();
  form.set("file", tinyPng, "pixel.png");
  const upload = await fetch(`${baseUrl}/api/room/ABC123/media`, {
    method: "POST",
    body: form
  }).then((response) => response.json());
  if (upload.type !== "image" || !upload.url) {
    throw new Error("Image upload did not return media metadata.");
  }

  const mediaSnapshot = await mediaReceivedByB;
  if (mediaSnapshot.media[0].name !== "pixel.png") {
    throw new Error("WebSocket clients did not receive synced media metadata.");
  }

  const videoReceivedByB = nextSnapshotWhere(wsB, (message) => message.media && message.media.length === 2);
  const tinyVideo = new Blob([Buffer.from("tiny video placeholder")], { type: "video/mp4" });
  const videoForm = new FormData();
  videoForm.set("file", tinyVideo, "clip.mp4");
  const videoUpload = await fetch(`${baseUrl}/api/room/ABC123/media`, {
    method: "POST",
    body: videoForm
  }).then((response) => response.json());
  if (videoUpload.type !== "video" || !videoUpload.url) {
    throw new Error("Video upload did not return media metadata.");
  }

  const videoSnapshot = await videoReceivedByB;
  if (videoSnapshot.media[1].name !== "clip.mp4") {
    throw new Error("WebSocket clients did not receive synced video metadata.");
  }

  const deleteReceivedByB = nextSnapshotWhere(wsB, (message) => message.media && message.media.length === 1);
  const uploadFileName = path.basename(new URL(upload.url, baseUrl).pathname);
  const uploadPath = path.join(uploadDir, uploadFileName);
  if (!fs.existsSync(uploadPath)) {
    throw new Error("Uploaded image file was not written to disk.");
  }

  const deletion = await fetch(`${baseUrl}/api/room/ABC123/media/${upload.id}`, {
    method: "DELETE"
  });
  if (deletion.status !== 204) {
    throw new Error("Media deletion did not return 204.");
  }

  const deleteSnapshot = await deleteReceivedByB;
  if (deleteSnapshot.media.length !== 1 || deleteSnapshot.media[0].name !== "clip.mp4") {
    throw new Error("WebSocket clients did not receive synced media deletion.");
  }
  await waitForFileMissing(uploadPath);

  wsA.terminate();
  wsB.terminate();
  sockets.delete(wsA);
  sockets.delete(wsB);
  await new Promise((resolve) => server.close(resolve));

  const persisted = createApp({ dbPath });
  const secondPort = await new Promise((resolve) => {
    persisted.server.listen(0, "127.0.0.1", () => resolve(persisted.server.address().port));
  });
  const restored = await fetch(`http://127.0.0.1:${secondPort}/api/room/ABC123`).then((response) => response.json());
  if (restored.text !== "hello from smoke test") {
    throw new Error("Room text was not persisted across server restarts.");
  }
  if (!restored.media || restored.media.length !== 1 || restored.media[0].name !== "clip.mp4") {
    throw new Error("Media metadata was not persisted across server restarts.");
  }
  await new Promise((resolve) => persisted.server.close(resolve));

  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {}
  }
  fs.rmSync(uploadDir, { recursive: true, force: true });

  console.log("Smoke test passed.");
}

main().catch(async (error) => {
  console.error(error);
  for (const ws of sockets) {
    ws.terminate();
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(uploadDir, { recursive: true, force: true });
  process.exitCode = 1;
});
