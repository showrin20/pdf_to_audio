// Thin helper around the Origin Private File System (OPFS).
// All reads/writes for the pipeline go through here so the storage layout
// stays in one place.

async function getRoot() {
  return navigator.storage.getDirectory();
}

async function getDir(path, { create = true } = {}) {
  const root = await getRoot();
  if (!path) return root;
  const parts = path.split("/").filter(Boolean);
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

function splitPath(path) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  return { dirPath: parts.join("/"), name };
}

// Streams a Blob/File/ReadableStream into OPFS without buffering it whole in memory.
export async function writeStream(path, source) {
  const { dirPath, name } = splitPath(path);
  const dir = await getDir(dirPath);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  if (source instanceof Blob) {
    const reader = source.stream().getReader();
    await pump(reader, writable);
  } else if (source instanceof ReadableStream) {
    const reader = source.getReader();
    await pump(reader, writable);
  } else {
    // ArrayBuffer / string / typed array.
    await writable.write(source);
  }
  await writable.close();
}

async function pump(reader, writable) {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writable.write(value);
  }
}

// Appends text/bytes to an existing (or new) file.
export async function appendFile(path, chunk) {
  const { dirPath, name } = splitPath(path);
  const dir = await getDir(dirPath);
  const handle = await dir.getFileHandle(name, { create: true });
  const existing = await handle.getFile();
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.write({ type: "write", position: existing.size, data: chunk });
  await writable.close();
}

export async function writeText(path, text) {
  return writeStream(path, new Blob([text]));
}

export async function writeJSON(path, value) {
  return writeText(path, JSON.stringify(value));
}

export async function readFile(path) {
  const { dirPath, name } = splitPath(path);
  const dir = await getDir(dirPath, { create: false });
  const handle = await dir.getFileHandle(name, { create: false });
  return handle.getFile();
}

export async function readText(path) {
  const file = await readFile(path);
  return file.text();
}

export async function readJSON(path) {
  return JSON.parse(await readText(path));
}

export async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function remove(path, { recursive = false } = {}) {
  const { dirPath, name } = splitPath(path);
  try {
    const dir = await getDir(dirPath, { create: false });
    await dir.removeEntry(name, { recursive });
  } catch {
    // Already gone — fine.
  }
}

export async function listDir(path) {
  const dir = await getDir(path, { create: false });
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  return names.sort();
}

// Wipes the whole pipeline workspace (used when starting a fresh document).
export async function resetAll() {
  const root = await getRoot();
  for await (const name of root.keys()) {
    await root.removeEntry(name, { recursive: true });
  }
}
