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

function nextMessageWhere(ws, predicate, timeoutMessage) {
  return withTimeout(new Promise((resolve) => {
    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(raw);
      if (predicate(message)) {
        ws.off("message", onMessage);
        resolve(message);
      }
    });
  }), timeoutMessage);
}

function waitForClose(ws) {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return withTimeout(new Promise((resolve) => {
    ws.once("close", resolve);
  }), "Timed out waiting for WebSocket to close.");
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

  const initialChannels = await fetch(`${baseUrl}/api/channels`).then((response) => response.json());
  const initialChannel = initialChannels.channels.find((channel) => channel.code === "ABC123");
  if (!initialChannel || initialChannel.textLength !== 0 || initialChannel.mediaCount !== 0) {
    throw new Error("Host channel board did not list the created room.");
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

  const deletionReceivedByA = nextSnapshotWhere(wsA, (message) => message.text === "");
  wsB.send(JSON.stringify({ type: "update", text: "" }));
  const deletionSnapshot = await deletionReceivedByA;
  if (deletionSnapshot.text !== "") {
    throw new Error("WebSocket clients did not receive the synced text deletion.");
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

  const dmgReceivedByB = nextSnapshotWhere(wsB, (message) => message.media && message.media.length === 3);
  const tinyDmg = new Blob([Buffer.from("tiny dmg placeholder")], { type: "application/octet-stream" });
  const dmgForm = new FormData();
  dmgForm.set("file", tinyDmg, "installer.dmg");
  const dmgUpload = await fetch(`${baseUrl}/api/room/ABC123/media`, {
    method: "POST",
    body: dmgForm
  }).then((response) => response.json());
  if (
    dmgUpload.type !== "file" ||
    dmgUpload.mimeType !== "application/x-apple-diskimage" ||
    !dmgUpload.url.endsWith(".dmg")
  ) {
    throw new Error("DMG upload did not return file metadata.");
  }

  const dmgSnapshot = await dmgReceivedByB;
  if (dmgSnapshot.media[2].name !== "installer.dmg") {
    throw new Error("WebSocket clients did not receive synced DMG metadata.");
  }

  const channelsWithMedia = await fetch(`${baseUrl}/api/channels`).then((response) => response.json());
  const channelWithMedia = channelsWithMedia.channels.find((channel) => channel.code === "ABC123");
  if (
    !channelWithMedia ||
    channelWithMedia.mediaCount !== 3 ||
    channelWithMedia.mediaSize <= 0 ||
    channelWithMedia.connectedCount !== 2
  ) {
    throw new Error("Host channel board did not report media and live clients.");
  }

  const unsupportedForm = new FormData();
  unsupportedForm.set("file", new Blob([Buffer.from("not allowed")], {
    type: "application/octet-stream"
  }), "archive.bin");
  const unsupportedUpload = await fetch(`${baseUrl}/api/room/ABC123/media`, {
    method: "POST",
    body: unsupportedForm
  });
  if (unsupportedUpload.status !== 400) {
    throw new Error("Generic binary upload should not be accepted without a DMG extension.");
  }

  const deleteReceivedByB = nextSnapshotWhere(wsB, (message) => message.media && message.media.length === 2);
  const uploadFileName = path.basename(new URL(upload.url, baseUrl).pathname);
  const uploadPath = path.join(uploadDir, uploadFileName);
  if (!fs.existsSync(uploadPath)) {
    throw new Error("Uploaded image file was not written to disk.");
  }

  const videoFileName = path.basename(new URL(videoUpload.url, baseUrl).pathname);
  const videoPath = path.join(uploadDir, videoFileName);
  if (!fs.existsSync(videoPath)) {
    throw new Error("Uploaded video file was not written to disk.");
  }

  const dmgFileName = path.basename(new URL(dmgUpload.url, baseUrl).pathname);
  const dmgPath = path.join(uploadDir, dmgFileName);
  if (!fs.existsSync(dmgPath)) {
    throw new Error("Uploaded DMG file was not written to disk.");
  }

  const deletion = await fetch(`${baseUrl}/api/room/ABC123/media/${upload.id}`, {
    method: "DELETE"
  });
  if (deletion.status !== 204) {
    throw new Error("Media deletion did not return 204.");
  }

  const deleteSnapshot = await deleteReceivedByB;
  if (
    deleteSnapshot.media.length !== 2 ||
    !deleteSnapshot.media.some((item) => item.name === "clip.mp4") ||
    !deleteSnapshot.media.some((item) => item.name === "installer.dmg")
  ) {
    throw new Error("WebSocket clients did not receive synced media deletion.");
  }
  await waitForFileMissing(uploadPath);

  wsA.terminate();
  wsB.terminate();
  sockets.delete(wsA);
  sockets.delete(wsB);
  await new Promise((resolve) => server.close(resolve));

  const persisted = createApp({ dbPath, uploadDir });
  const secondPort = await new Promise((resolve) => {
    persisted.server.listen(0, "127.0.0.1", () => resolve(persisted.server.address().port));
  });
  const persistedBaseUrl = `http://127.0.0.1:${secondPort}`;
  const restored = await fetch(`${persistedBaseUrl}/api/room/ABC123`).then((response) => response.json());
  if (restored.text !== "") {
    throw new Error("Room text was not persisted across server restarts.");
  }
  if (
    !restored.media ||
    restored.media.length !== 2 ||
    !restored.media.some((item) => item.name === "clip.mp4") ||
    !restored.media.some((item) => item.name === "installer.dmg")
  ) {
    throw new Error("Media metadata was not persisted across server restarts.");
  }

  const wsC = new WebSocket(`ws://127.0.0.1:${secondPort}/ws?code=ABC123`);
  sockets.add(wsC);
  const restoredInitial = nextSnapshot(wsC);
  await waitForOpen(wsC);
  await restoredInitial;

  const deletedMessageReceived = nextMessageWhere(
    wsC,
    (message) => message.type === "channelDeleted",
    "Timed out waiting for a channel deletion message."
  );
  const deletedSocketClosed = waitForClose(wsC);
  const channelDeletion = await fetch(`${persistedBaseUrl}/api/channels/ABC123`, {
    method: "DELETE"
  });
  if (channelDeletion.status !== 204) {
    throw new Error("Channel deletion did not return 204.");
  }

  const deletedMessage = await deletedMessageReceived;
  if (deletedMessage.code !== "ABC123") {
    throw new Error("WebSocket clients did not receive the deleted channel code.");
  }
  await deletedSocketClosed;
  sockets.delete(wsC);
  await waitForFileMissing(videoPath);
  await waitForFileMissing(dmgPath);

  const channelsAfterDelete = await fetch(`${persistedBaseUrl}/api/channels`).then((response) => response.json());
  if (channelsAfterDelete.channels.some((channel) => channel.code === "ABC123")) {
    throw new Error("Deleted channel was still listed on the host channel board.");
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
