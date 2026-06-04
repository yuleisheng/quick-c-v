const joinView = document.querySelector("#joinView");
const editorView = document.querySelector("#editorView");
const joinForm = document.querySelector("#joinForm");
const codeInput = document.querySelector("#codeInput");
const joinError = document.querySelector("#joinError");
const roomLabel = document.querySelector("#roomLabel");
const statusPill = document.querySelector("#status");
const passcodeButton = document.querySelector("#passcodeButton");
const passcodePopover = document.querySelector("#passcodePopover");
const savedAt = document.querySelector("#savedAt");
const charCount = document.querySelector("#charCount");
const textEditor = document.querySelector("#textEditor");
const leaveButton = document.querySelector("#leaveButton");
const uploadButton = document.querySelector("#uploadButton");
const mediaInput = document.querySelector("#mediaInput");
const mediaPanel = document.querySelector("#mediaPanel");
const mediaGrid = document.querySelector("#mediaGrid");
const uploadStatus = document.querySelector("#uploadStatus");
const previewDialog = document.querySelector("#previewDialog");
const previewBody = document.querySelector("#previewBody");
const previewCloseButton = document.querySelector("#previewCloseButton");

const CODE_REGEX = /^[A-Z0-9]{1,32}$/;
let socket;
let roomCode = "";
let reconnectTimer;
let suppressNextSend = false;
let mediaItems = [];

function normalizeCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function setStatus(label, mode = "") {
  statusPill.textContent = label;
  statusPill.className = mode ? `status ${mode}` : "status";
}

function setSavedAt(value) {
  if (!value) {
    savedAt.textContent = "Not saved yet";
    return;
  }

  const date = new Date(value);
  savedAt.textContent = Number.isNaN(date.getTime())
    ? "Saved"
    : `Saved ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function updateCount() {
  const count = textEditor.value.length;
  const imageCount = mediaItems.filter((item) => item.type === "image").length;
  const videoCount = mediaItems.filter((item) => item.type === "video").length;
  const parts = [`${count.toLocaleString()} ${count === 1 ? "char" : "chars"}`];

  if (imageCount > 0) {
    parts.push(`${imageCount.toLocaleString()} ${imageCount === 1 ? "image" : "images"}`);
  }

  if (videoCount > 0) {
    parts.push(`${videoCount.toLocaleString()} ${videoCount === 1 ? "video" : "videos"}`);
  }

  charCount.textContent = parts.join(" · ");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function setUploadStatus(message = "") {
  uploadStatus.textContent = message;
}

function iconSvg(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");

  const paths = {
    download: ["M12 3v11", "M7 9l5 5 5-5", "M5 21h14"],
    remove: ["M18 6 6 18", "M6 6l12 12"]
  };

  for (const data of paths[name] || []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.append(path);
  }

  return svg;
}

function openPreview(item) {
  previewBody.replaceChildren();

  const preview = document.createElement(item.type === "video" ? "video" : "img");
  preview.src = item.url;
  preview.className = "preview-media";

  if (item.type === "video") {
    preview.controls = true;
    preview.autoplay = true;
  } else {
    preview.alt = item.name || "Synced image";
  }

  previewBody.append(preview);
  previewDialog.showModal();
}

function closePreview() {
  previewDialog.close();
  previewBody.replaceChildren();
}

async function deleteMedia(item) {
  setUploadStatus("Removing");

  try {
    const response = await fetch(`/api/room/${encodeURIComponent(roomCode)}/media/${encodeURIComponent(item.id)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Could not remove media.");
    }

    renderMedia(mediaItems.filter((mediaItem) => mediaItem.id !== item.id));
    setUploadStatus("Removed");
  } catch (error) {
    setUploadStatus(error.message);
  }
}

function renderMedia(items = []) {
  mediaItems = items;
  mediaGrid.replaceChildren();
  mediaPanel.hidden = mediaItems.length === 0;

  for (const item of mediaItems) {
    const card = document.createElement("article");
    card.className = "media-item";

    const previewButton = document.createElement("button");
    previewButton.className = "media-open";
    previewButton.type = "button";
    previewButton.setAttribute("aria-label", `Preview ${item.name || "media"}`);

    const preview = document.createElement(item.type === "video" ? "video" : "img");
    preview.src = item.url;
    preview.className = "media-preview";

    if (item.type === "video") {
      preview.preload = "metadata";
    } else {
      preview.alt = item.name || "Synced image";
      preview.loading = "lazy";
    }

    const actions = document.createElement("div");
    actions.className = "media-actions";

    const download = document.createElement("a");
    download.className = "media-action";
    download.href = item.url;
    download.download = item.name || "quickcv-media";
    download.setAttribute("aria-label", `Download ${item.name || "media"}`);
    download.title = "Download";
    download.append(iconSvg("download"));

    const remove = document.createElement("button");
    remove.className = "media-action";
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${item.name || "media"}`);
    remove.title = "Remove";
    remove.append(iconSvg("remove"));

    actions.append(download, remove);

    const meta = document.createElement("div");
    meta.className = "media-meta";

    const name = document.createElement("span");
    name.className = "media-name";
    name.textContent = item.name || "Untitled";

    const size = document.createElement("span");
    size.textContent = formatBytes(item.size);

    meta.append(name, size);
    previewButton.append(preview, meta);
    card.append(previewButton, actions);
    previewButton.addEventListener("click", () => openPreview(item));
    download.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteMedia(item);
    });
    mediaGrid.append(card);
  }

  updateCount();
}

function showJoin() {
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.close();
  }
  roomCode = "";
  renderMedia([]);
  setUploadStatus("");
  passcodePopover.hidden = true;
  passcodeButton.setAttribute("aria-expanded", "false");
  editorView.hidden = true;
  joinView.hidden = false;
  joinError.textContent = "";
  codeInput.focus();
}

function showEditor(code) {
  joinView.hidden = true;
  editorView.hidden = false;
  roomLabel.textContent = code;
  textEditor.focus();
}

async function loadRoom(code) {
  const response = await fetch(`/api/room/${encodeURIComponent(code)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Could not join that room.");
  }
  return payload;
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  if (!roomCode) {
    return;
  }

  setStatus("Connecting", "saving");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws?code=${encodeURIComponent(roomCode)}`);

  socket.addEventListener("open", () => {
    setStatus("Live");
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      if (textEditor.value !== message.text) {
        suppressNextSend = true;
        textEditor.value = message.text;
        updateCount();
      }
      setSavedAt(message.updatedAt);
      renderMedia(message.media || []);
      setStatus("Live");
    }

    if (message.type === "error") {
      setStatus("Error", "offline");
      joinError.textContent = message.error;
    }
  });

  socket.addEventListener("close", () => {
    if (!roomCode) {
      return;
    }
    setStatus("Offline", "offline");
    reconnectTimer = setTimeout(connectSocket, 1200);
  });

  socket.addEventListener("error", () => {
    setStatus("Offline", "offline");
  });
}

function sendUpdate() {
  if (suppressNextSend) {
    suppressNextSend = false;
    return;
  }

  updateCount();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Offline", "offline");
    return;
  }

  setStatus("Saving", "saving");
  socket.send(JSON.stringify({
    type: "update",
    text: textEditor.value
  }));
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  joinError.textContent = "";
  const code = normalizeCode(codeInput.value);
  codeInput.value = code;

  if (!CODE_REGEX.test(code)) {
    joinError.textContent = "Use 1-32 letters or numbers.";
    codeInput.focus();
    return;
  }

  try {
    setStatus("Connecting", "saving");
    const room = await loadRoom(code);
    roomCode = room.code;
    textEditor.value = room.text;
    renderMedia(room.media || []);
    updateCount();
    setSavedAt(room.updatedAt);
    showEditor(roomCode);
    connectSocket();
    window.history.replaceState(null, "", `#${roomCode}`);
  } catch (error) {
    joinError.textContent = error.message;
  }
});

textEditor.addEventListener("input", sendUpdate);

uploadButton.addEventListener("click", () => {
  mediaInput.click();
});

passcodeButton.addEventListener("click", () => {
  const isHidden = passcodePopover.hidden;
  passcodePopover.hidden = !isHidden;
  passcodeButton.setAttribute("aria-expanded", String(isHidden));
});

document.addEventListener("click", (event) => {
  if (passcodePopover.hidden || event.target.closest(".passcode-control")) {
    return;
  }

  passcodePopover.hidden = true;
  passcodeButton.setAttribute("aria-expanded", "false");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    passcodePopover.hidden = true;
    passcodeButton.setAttribute("aria-expanded", "false");
  }
});

previewCloseButton.addEventListener("click", closePreview);

previewDialog.addEventListener("click", (event) => {
  if (event.target === previewDialog) {
    closePreview();
  }
});

previewDialog.addEventListener("close", () => {
  previewBody.replaceChildren();
});

mediaInput.addEventListener("change", async () => {
  const file = mediaInput.files[0];
  mediaInput.value = "";
  setUploadStatus("");

  if (!file || !roomCode) {
    return;
  }

  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    setUploadStatus("Images and videos only");
    return;
  }

  uploadButton.disabled = true;
  setUploadStatus("Uploading");

  try {
    const form = new FormData();
    form.set("file", file);

    const response = await fetch(`/api/room/${encodeURIComponent(roomCode)}/media`, {
      method: "POST",
      body: form
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Upload failed.");
    }

    renderMedia([...mediaItems.filter((item) => item.id !== payload.id), payload]);
    setUploadStatus("Uploaded");
  } catch (error) {
    setUploadStatus(error.message);
  } finally {
    uploadButton.disabled = false;
  }
});

leaveButton.addEventListener("click", () => {
  window.history.replaceState(null, "", window.location.pathname);
  showJoin();
});

codeInput.addEventListener("input", () => {
  const normalized = normalizeCode(codeInput.value);
  if (codeInput.value !== normalized) {
    codeInput.value = normalized;
  }
});

window.addEventListener("beforeunload", () => {
  if (socket) {
    socket.close();
  }
});

const hashCode = normalizeCode(window.location.hash.slice(1));
if (CODE_REGEX.test(hashCode)) {
  codeInput.value = hashCode;
  joinForm.requestSubmit();
} else {
  codeInput.focus();
}
