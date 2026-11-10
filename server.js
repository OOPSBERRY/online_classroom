import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_ROOMS_PER_KIND, ROOM_CAPACITY, ROOM_KINDS, SEAT_COUNT, PHRASES, cleanLook, cleanNick, cleanRegion, parseRoomId } from './public/js/data.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const ACTIONS = new Set(['raise', 'bow', 'clap', 'throw', 'jump']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const EMPTY_ROOM_LIFETIME = 60 * 1000;

const rooms = new Map();
let nextId = 1;

function createRoom(id) {
  const room = { ...parseRoomId(id), players: new Map(), emptySince: Date.now() };
  rooms.set(id, room);
  return room;
}

for (const kind of Object.keys(ROOM_KINDS)) createRoom(`${kind}-1`);

// 자리가 남은 반 중 가장 북적이는 반을 고른다. 모두 찼으면 비어 있는 가장 작은 번호로 새 반을 연다.
function assignRoom(kind) {
  const sameKind = [...rooms.values()].filter((room) => room.kind === kind);
  const open = sameKind.filter((room) => room.players.size < ROOM_CAPACITY);
  if (open.length) return open.sort((a, b) => b.players.size - a.players.size || a.number - b.number)[0];
  if (sameKind.length >= MAX_ROOMS_PER_KIND) return null;
  let number = 1;
  while (rooms.has(`${kind}-${number}`)) number++;
  return createRoom(`${kind}-${number}`);
}

// 전송량을 줄이려고 파일은 한 번 읽어 압축해 두고, 브라우저가 이미 가진 파일은 다시 보내지 않는다.
const fileCache = new Map();

async function loadFile(filePath, relative) {
  if (fileCache.has(filePath)) return fileCache.get(filePath);
  const body = await readFile(filePath);
  const type = MIME[extname(filePath)] || 'application/octet-stream';
  const compressible = /^(text\/|application\/json|image\/svg)/.test(type);
  // 이름이 바뀌지 않는 큰 파일(3D 도구, 글꼴)은 오래 보관하게 하고, 나머지는 바뀌었는지만 확인하게 한다.
  const longLived = /^[\\/](vendor|fonts)[\\/]/.test(relative);
  const file = {
    body,
    type,
    etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
    cache: longLived ? 'public, max-age=2592000' : 'public, max-age=0, must-revalidate',
    br: compressible ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
    gzip: compressible ? gzipSync(body, { level: 9 }) : null,
  };
  fileCache.set(filePath, file);
  return file;
}

function sendFile(req, res, file) {
  const headers = { 'content-type': file.type, 'cache-control': file.cache, etag: file.etag, vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const accept = req.headers['accept-encoding'] || '';
  let body = file.body;
  if (file.br && /\bbr\b/.test(accept)) {
    body = file.br;
    headers['content-encoding'] = 'br';
  } else if (file.gzip && /\bgzip\b/.test(accept)) {
    body = file.gzip;
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/rooms') {
    const list = [...rooms.values()]
      .sort((a, b) => a.number - b.number)
      .map((room) => ({ id: room.id, name: room.name, kind: room.kind, count: room.players.size, capacity: ROOM_CAPACITY }));
    sendJson(res, 200, list);
    return;
  }
  if (pathname === '/api/assign') {
    const kind = searchParams.get('kind');
    const room = Object.hasOwn(ROOM_KINDS, kind ?? '') ? assignRoom(kind) : null;
    if (room) sendJson(res, 200, { id: room.id });
    else sendJson(res, 503, { error: 'no room' });
    return;
  }
  try {
    const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const filePath = join(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR + sep)) throw new Error('outside public');
    sendFile(req, res, await loadFile(filePath, relative));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('찾을 수 없어요');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

function broadcast(room, message, except) {
  const text = JSON.stringify(message);
  for (const player of room.players.values()) {
    if (player !== except && player.socket.readyState === player.socket.OPEN) player.socket.send(text);
  }
}

function publicPlayer(player) {
  return { id: player.id, look: player.look, nick: player.nick, region: player.region, x: player.x, z: player.z, r: player.r, s: player.s };
}

const finite = (value, min, max) => (Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null);

function handle(player, room, msg) {
  switch (msg.t) {
    case 'pos': {
      const x = finite(msg.x, -8, 8);
      const z = finite(msg.z, -9, 9);
      const r = finite(msg.r, -10, 10);
      if (x === null || z === null || r === null) return;
      const seat = Number.isInteger(msg.s) && msg.s >= 0 && msg.s < SEAT_COUNT ? msg.s : -1;
      Object.assign(player, { x, z, r, s: seat });
      broadcast(room, { t: 'pos', id: player.id, x, z, r, s: seat }, player);
      break;
    }
    case 'act':
      if (ACTIONS.has(msg.a)) broadcast(room, { t: 'act', id: player.id, a: msg.a }, player);
      break;
    case 'say':
      if (Number.isInteger(msg.i) && msg.i >= 0 && msg.i < PHRASES.length) broadcast(room, { t: 'say', id: player.id, i: msg.i }, player);
      break;
    case 'look':
      player.look = cleanLook(msg.look);
      player.nick = cleanNick(msg.nick);
      broadcast(room, { t: 'look', id: player.id, look: player.look, nick: player.nick }, player);
      break;
  }
}

// 없어졌거나 가득 찬 반에 들어오려 하면 같은 종류의 다른 반으로 보낸다.
function sendElsewhere(socket, kind) {
  const other = kind ? assignRoom(kind) : null;
  socket.send(JSON.stringify(other ? { t: 'redirect', room: other.id } : { t: 'full' }));
  socket.close();
}

wss.on('connection', (socket, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const parsed = parseRoomId(searchParams.get('room'));
  const room = parsed && rooms.get(parsed.id);
  if (!room || room.players.size >= ROOM_CAPACITY) {
    sendElsewhere(socket, parsed?.kind);
    return;
  }

  const player = { id: nextId++, socket, look: cleanLook(), nick: [0, 0], region: -1, x: 2.3, z: 2.9, r: Math.PI, s: -1, joined: false, alive: true, tokens: 40, refilled: Date.now() };
  socket.on('pong', () => { player.alive = true; });

  socket.on('message', (raw) => {
    // 초당 메시지 수를 제한한다.
    const now = Date.now();
    player.tokens = Math.min(60, player.tokens + ((now - player.refilled) / 1000) * 40);
    player.refilled = now;
    if (player.tokens < 1) return;
    player.tokens -= 1;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;

    if (!player.joined) {
      if (msg.t !== 'hello') return;
      if (room.players.size >= ROOM_CAPACITY || rooms.get(room.id) !== room) {
        sendElsewhere(socket, room.kind);
        return;
      }
      player.look = cleanLook(msg.look);
      player.nick = cleanNick(msg.nick);
      player.region = cleanRegion(msg.region);
      player.joined = true;
      socket.send(JSON.stringify({ t: 'welcome', id: player.id, players: [...room.players.values()].map(publicPlayer) }));
      room.players.set(player.id, player);
      broadcast(room, { t: 'join', player: publicPlayer(player) }, player);
      return;
    }
    handle(player, room, msg);
  });

  socket.on('close', () => {
    if (room.players.delete(player.id)) {
      broadcast(room, { t: 'leave', id: player.id });
      if (room.players.size === 0) room.emptySince = Date.now();
    }
  });
  socket.on('error', () => socket.terminate());
  socket.player = player;
});

// 끊긴 연결 정리
setInterval(() => {
  for (const socket of wss.clients) {
    const player = socket.player;
    if (!player) continue;
    if (!player.alive) { socket.terminate(); continue; }
    player.alive = false;
    socket.ping();
  }
}, 30000);

// 나중에 열린 반은 한동안 비어 있으면 닫는다. 1반은 늘 남겨 둔다.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.number > 1 && room.players.size === 0 && now - room.emptySince > EMPTY_ROOM_LIFETIME) rooms.delete(room.id);
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`교실 문이 열렸어요 → http://localhost:${PORT}`);
});
