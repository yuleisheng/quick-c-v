const joinView = document.querySelector("#joinView");
const editorView = document.querySelector("#editorView");
const joinForm = document.querySelector("#joinForm");
const codeInput = document.querySelector("#codeInput");
const joinError = document.querySelector("#joinError");
const hostBoard = document.querySelector("#hostBoard");
const channelList = document.querySelector("#channelList");
const hostBoardRefresh = document.querySelector("#hostBoardRefresh");
const roomLabel = document.querySelector("#roomLabel");
const statusPill = document.querySelector("#status");
const passcodeButton = document.querySelector("#passcodeButton");
const passcodePopover = document.querySelector("#passcodePopover");
const savedAt = document.querySelector("#savedAt");
const charCount = document.querySelector("#charCount");
const textEditor = document.querySelector("#textEditor");
const addTaskButton = document.querySelector("#addTaskButton");
const taskPanel = document.querySelector("#taskPanel");
const taskList = document.querySelector("#taskList");
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
const canManageTasks = isLocalhostName(window.location.hostname);
let socket;
let roomCode = "";
let reconnectTimer;
let channelRefreshTimer;
let dragDepth = 0;
let mediaItems = [];
let taskItems = [];
let currentTasksText = "[]";
let hasPendingTaskChanges = false;

function normalizeCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isLocalhostName(value) {
  const host = String(value || "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
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
  const taskCount = taskItems.length;
  const completedCount = taskItems.filter((item) => item.done).length;
  const imageCount = mediaItems.filter((item) => item.type === "image").length;
  const videoCount = mediaItems.filter((item) => item.type === "video").length;
  const fileCount = mediaItems.filter((item) => item.type === "file").length;
  const parts = [`${count.toLocaleString()} ${count === 1 ? "char" : "chars"}`];

  if (taskCount > 0) {
    parts.push(`${taskCount.toLocaleString()} ${taskCount === 1 ? "task" : "tasks"}`);
  }

  if (completedCount > 0) {
    parts.push(`${completedCount.toLocaleString()} done`);
  }

  if (imageCount > 0) {
    parts.push(`${imageCount.toLocaleString()} ${imageCount === 1 ? "image" : "images"}`);
  }

  if (videoCount > 0) {
    parts.push(`${videoCount.toLocaleString()} ${videoCount === 1 ? "video" : "videos"}`);
  }

  if (fileCount > 0) {
    parts.push(`${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}`);
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

function formatChannelUpdatedAt(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Updated";
  }

  return `Updated ${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function channelSummary(channel) {
  const textLength = Number(channel.textLength) || 0;
  const taskCount = Number(channel.taskCount) || 0;
  const mediaCount = Number(channel.mediaCount) || 0;
  const parts = [];

  parts.push(`${textLength.toLocaleString()} ${textLength === 1 ? "char" : "chars"}`);
  if (taskCount > 0) {
    parts.push(`${taskCount.toLocaleString()} ${taskCount === 1 ? "task" : "tasks"}`);
  }
  parts.push(`${mediaCount.toLocaleString()} ${mediaCount === 1 ? "file" : "files"}`);

  return parts.join(" · ");
}

function setUploadStatus(message = "") {
  uploadStatus.textContent = message;
}

function isDmgFile(file) {
  return Boolean(file) && (
    file.type === "application/x-apple-diskimage" ||
    String(file.name || "").toLowerCase().endsWith(".dmg")
  );
}

function isSupportedUploadFile(file) {
  return Boolean(file) && (
    file.type.startsWith("image/") ||
    file.type.startsWith("video/") ||
    isDmgFile(file)
  );
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function setDragActive(isActive) {
  editorView.classList.toggle("is-dragging", isActive);
}

function resetDragState() {
  dragDepth = 0;
  setDragActive(false);
}

function createTaskId() {
  try {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch {}

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTaskText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s*\n+\s*/g, " ");
}

function createTask(text = "", done = false, id = createTaskId()) {
  return {
    id,
    text: normalizeTaskText(text),
    done: Boolean(done)
  };
}

function sanitizeTask(task) {
  if (!task || typeof task !== "object") {
    return createTask();
  }

  return createTask(task.text, task.done, String(task.id || createTaskId()).slice(0, 120));
}

function serializeTasks(tasks = taskItems) {
  return JSON.stringify(tasks.map((task) => ({
    id: task.id,
    text: normalizeTaskText(task.text),
    done: Boolean(task.done)
  })));
}

function placeCaretAtEnd(element) {
  element.focus();

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusTaskDescription(id) {
  window.requestAnimationFrame(() => {
    const description = Array.from(taskList.querySelectorAll("[data-task-description]"))
      .find((element) => element.dataset.taskDescription === id);
    if (description) {
      placeCaretAtEnd(description);
    }
  });
}

function sendCurrentTasks() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Offline", "offline");
    return false;
  }

  setStatus("Saving", "saving");
  socket.send(JSON.stringify({
    type: "tasksUpdate",
    tasks: taskItems
  }));
  return true;
}

function sendTasksUpdate() {
  currentTasksText = serializeTasks();
  hasPendingTaskChanges = true;
  updateCount();
  sendCurrentTasks();
}

function renderTaskRow(task) {
  const row = document.createElement("div");
  row.className = task.done ? "task-row is-done" : "task-row";
  row.dataset.taskId = task.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = task.done;
  checkbox.setAttribute("aria-label", "Complete task");

  const description = document.createElement("span");
  description.className = "task-description";
  description.textContent = task.text;
  description.spellcheck = true;
  description.dataset.placeholder = "Task description";
  description.dataset.taskDescription = task.id;
  if (canManageTasks) {
    description.setAttribute("contenteditable", "true");
    description.setAttribute("role", "textbox");
    description.setAttribute("aria-label", "Task description");
  }

  const remove = document.createElement("button");
  remove.className = "task-remove";
  remove.type = "button";
  remove.title = "Remove";
  remove.setAttribute("aria-label", "Remove task");
  remove.append(iconSvg("remove"));

  checkbox.addEventListener("change", () => {
    task.done = checkbox.checked;
    row.classList.toggle("is-done", task.done);
    sendTasksUpdate();
  });

  if (canManageTasks) {
    description.addEventListener("input", () => {
      task.text = normalizeTaskText(description.textContent);
      sendTasksUpdate();
    });

    description.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addTask("", { afterId: task.id });
      }

      if (event.key === "Backspace" && normalizeTaskText(description.textContent) === "" && taskItems.length > 1) {
        event.preventDefault();
        removeTask(task.id);
      }
    });

    description.addEventListener("paste", (event) => {
      event.preventDefault();
      document.execCommand("insertText", false, normalizeTaskText(event.clipboardData.getData("text/plain")));
    });

    description.addEventListener("blur", () => {
      const normalized = normalizeTaskText(description.textContent);
      if (description.textContent !== normalized) {
        description.textContent = normalized;
      }
    });

    remove.addEventListener("click", () => {
      removeTask(task.id);
    });
  }

  row.append(checkbox, description);
  if (canManageTasks) {
    row.append(remove);
  }
  return row;
}

function renderTasks(tasks = []) {
  taskItems = tasks.map(sanitizeTask);
  taskList.replaceChildren();
  taskPanel.hidden = taskItems.length === 0;

  for (const task of taskItems) {
    taskList.append(renderTaskRow(task));
  }

  currentTasksText = serializeTasks();
  updateCount();
}

function addTask(text = "", options = {}) {
  if (!canManageTasks) {
    return;
  }

  const task = createTask(text);
  const nextItems = [...taskItems];
  const afterIndex = options.afterId
    ? nextItems.findIndex((item) => item.id === options.afterId)
    : -1;
  const insertIndex = afterIndex >= 0 ? afterIndex + 1 : nextItems.length;

  nextItems.splice(insertIndex, 0, task);
  renderTasks(nextItems);
  sendTasksUpdate();
  focusTaskDescription(task.id);
}

function removeTask(id) {
  if (!canManageTasks) {
    return;
  }

  const removedIndex = taskItems.findIndex((task) => task.id === id);
  if (removedIndex < 0) {
    return;
  }

  const nextItems = taskItems.filter((task) => task.id !== id);
  const nextFocusTask = nextItems[Math.min(removedIndex, nextItems.length - 1)];

  renderTasks(nextItems);
  sendTasksUpdate();

  if (nextFocusTask) {
    focusTaskDescription(nextFocusTask.id);
  } else {
    textEditor.focus();
  }
}

addTaskButton.hidden = !canManageTasks;

function iconSvg(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");

  const paths = {
    download: ["M12 3v11", "M7 9l5 5 5-5", "M5 21h14"],
    file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6"],
    remove: ["M18 6 6 18", "M6 6l12 12"],
    trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v5", "M14 11v5"]
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
    setUploadStatus("");
  } catch (error) {
    setUploadStatus(error.message);
  }
}

async function uploadMediaFile(code, file) {
  const form = new FormData();
  form.set("file", file);

  const response = await fetch(`/api/room/${encodeURIComponent(code)}/media`, {
    method: "POST",
    body: form
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Upload failed.");
  }

  return payload;
}

async function uploadMediaFiles(files) {
  const code = roomCode;
  const selectedFiles = Array.from(files || []);
  if (!selectedFiles.length || !code) {
    return;
  }

  if (!selectedFiles.every(isSupportedUploadFile)) {
    setUploadStatus("Images, videos, and DMG files only");
    return;
  }

  uploadButton.disabled = true;

  try {
    for (const [index, file] of selectedFiles.entries()) {
      setUploadStatus(selectedFiles.length > 1 ? `Uploading ${index + 1}/${selectedFiles.length}` : "Uploading");
      const payload = await uploadMediaFile(code, file);
      if (code === roomCode) {
        renderMedia([...mediaItems.filter((item) => item.id !== payload.id), payload]);
      }
    }

    if (code === roomCode) {
      setUploadStatus("");
    }
  } catch (error) {
    setUploadStatus(error.message);
  } finally {
    uploadButton.disabled = false;
  }
}

function renderMedia(items = []) {
  mediaItems = items;
  mediaGrid.replaceChildren();
  mediaPanel.hidden = mediaItems.length === 0;

  for (const item of mediaItems) {
    const card = document.createElement("article");
    card.className = "media-item";

    const previewButton = document.createElement(item.type === "file" ? "a" : "button");
    previewButton.className = "media-open";
    previewButton.setAttribute(
      "aria-label",
      `${item.type === "file" ? "Download" : "Preview"} ${item.name || "file"}`
    );

    if (item.type === "file") {
      previewButton.href = item.url;
      previewButton.download = item.name || "quickcv-file";
    } else {
      previewButton.type = "button";
    }

    let preview;
    if (item.type === "file") {
      preview = document.createElement("div");
      preview.className = "media-preview file-preview";
      preview.append(iconSvg("file"));
    } else {
      preview = document.createElement(item.type === "video" ? "video" : "img");
      preview.src = item.url;
      preview.className = "media-preview";
    }

    if (item.type === "video") {
      preview.preload = "metadata";
    } else if (item.type === "image") {
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
    if (item.type !== "file") {
      previewButton.addEventListener("click", () => openPreview(item));
    }
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

async function deleteChannel(channel) {
  const shouldDelete = window.confirm(
    `Delete channel ${channel.code}? This removes its text and synced files from the host.`
  );
  if (!shouldDelete) {
    return;
  }

  setHostBoardBusy(true);
  joinError.textContent = "";

  try {
    const response = await fetch(`/api/channels/${encodeURIComponent(channel.code)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Could not delete channel.");
    }

    await loadChannels();
  } catch (error) {
    joinError.textContent = error.message;
  } finally {
    setHostBoardBusy(false);
  }
}

function renderChannels(channels = []) {
  channelList.replaceChildren();
  hostBoard.hidden = false;

  if (channels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "channel-empty";
    empty.textContent = "No channels yet";
    channelList.append(empty);
    return;
  }

  for (const channel of channels) {
    const card = document.createElement("article");
    card.className = "channel-card";

    const openButton = document.createElement("button");
    openButton.className = "channel-open";
    openButton.type = "button";

    const details = document.createElement("span");
    details.className = "channel-details";

    const code = document.createElement("strong");
    code.className = "channel-code";
    code.textContent = channel.code;

    const updated = document.createElement("span");
    updated.className = "channel-updated";
    updated.textContent = formatChannelUpdatedAt(channel.updatedAt);

    const meta = document.createElement("span");
    meta.className = "channel-meta";
    meta.textContent = channelSummary(channel);

    const connectedCount = Number(channel.connectedCount) || 0;
    const badge = document.createElement("span");
    badge.className = connectedCount > 0 ? "channel-badge is-live" : "channel-badge";
    badge.textContent = connectedCount > 0
      ? `${connectedCount.toLocaleString()} live`
      : "Idle";

    const deleteButton = document.createElement("button");
    deleteButton.className = "channel-delete";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `Delete channel ${channel.code}`);
    deleteButton.title = "Delete channel";
    deleteButton.append(iconSvg("trash"));

    details.append(code, updated, meta);
    openButton.append(details, badge);
    openButton.addEventListener("click", () => {
      codeInput.value = channel.code;
      joinForm.requestSubmit();
    });
    deleteButton.addEventListener("click", () => {
      deleteChannel(channel);
    });
    card.append(openButton, deleteButton);
    channelList.append(card);
  }
}

function setHostBoardBusy(isBusy) {
  hostBoardRefresh.disabled = isBusy;
  for (const control of channelList.querySelectorAll("button")) {
    control.disabled = isBusy;
  }
}

function stopChannelBoard() {
  clearInterval(channelRefreshTimer);
}

async function loadChannels() {
  if (joinView.hidden) {
    return;
  }

  try {
    const response = await fetch("/api/channels", { cache: "no-store" });

    if (response.status === 403) {
      hostBoard.hidden = true;
      stopChannelBoard();
      return;
    }

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not load channels.");
    }

    renderChannels(payload.channels || []);
  } catch {
    hostBoard.hidden = true;
  }
}

function startChannelBoard() {
  stopChannelBoard();
  loadChannels();
  channelRefreshTimer = setInterval(loadChannels, 5000);
}

function showJoin(message = "") {
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.close();
  }
  resetDragState();
  roomCode = "";
  renderTasks([]);
  hasPendingTaskChanges = false;
  renderMedia([]);
  setUploadStatus("");
  passcodePopover.hidden = true;
  passcodeButton.setAttribute("aria-expanded", "false");
  editorView.hidden = true;
  joinView.hidden = false;
  joinError.textContent = message;
  codeInput.focus();
  startChannelBoard();
}

function showEditor(code) {
  stopChannelBoard();
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
    if (hasPendingTaskChanges) {
      sendCurrentTasks();
    } else {
      setStatus("Live");
    }
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      if (textEditor.value !== message.text) {
        textEditor.value = message.text;
        updateCount();
      }
      const incomingTasksText = serializeTasks(message.tasks || []);
      if (incomingTasksText === currentTasksText) {
        hasPendingTaskChanges = false;
      } else if (hasPendingTaskChanges) {
        sendCurrentTasks();
      } else {
        renderTasks(message.tasks || []);
      }
      setSavedAt(message.updatedAt);
      renderMedia(message.media || []);
      setStatus(hasPendingTaskChanges ? "Saving" : "Live");
    }

    if (message.type === "channelDeleted") {
      const deletedCode = roomCode;
      window.history.replaceState(null, "", window.location.pathname);
      showJoin(message.error || "Channel deleted by host.");
      codeInput.value = deletedCode;
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
    renderTasks(room.tasks || []);
    hasPendingTaskChanges = false;
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

addTaskButton.addEventListener("click", () => {
  addTask();
});

uploadButton.addEventListener("click", () => {
  mediaInput.click();
});

hostBoardRefresh.addEventListener("click", loadChannels);

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

mediaInput.addEventListener("change", () => {
  const files = Array.from(mediaInput.files || []);
  mediaInput.value = "";
  setUploadStatus("");
  uploadMediaFiles(files);
});

editorView.addEventListener("dragenter", (event) => {
  if (!roomCode || !hasDraggedFiles(event)) {
    return;
  }

  event.preventDefault();
  dragDepth += 1;
  setDragActive(true);
});

editorView.addEventListener("dragover", (event) => {
  if (!roomCode || !hasDraggedFiles(event)) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

editorView.addEventListener("dragleave", (event) => {
  if (!hasDraggedFiles(event)) {
    return;
  }

  dragDepth -= 1;
  if (dragDepth <= 0) {
    resetDragState();
  }
});

editorView.addEventListener("drop", (event) => {
  if (!roomCode || !hasDraggedFiles(event)) {
    return;
  }

  event.preventDefault();
  const files = Array.from(event.dataTransfer.files || []);
  resetDragState();
  setUploadStatus("");
  uploadMediaFiles(files);
});

document.addEventListener("dragover", (event) => {
  if (hasDraggedFiles(event)) {
    event.preventDefault();
  }
});

document.addEventListener("drop", (event) => {
  if (hasDraggedFiles(event)) {
    event.preventDefault();
    resetDragState();
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
  startChannelBoard();
  codeInput.focus();
}
