// そらとも（β版）：小さな人工衛星の運用ゲーム。ともはねのゲームとして遊ぶ
// ・「ともはねでログイン」：ともはねが出した通行証を、ともはねに確かめる。パスワードはここに置かない
// ・ともはねに知らせるのは、ミッション達成の数と遊んだ回数だけ
// ・ログインしなくても遊べる（記録は残らない）。協力する人（2人目）は、管制官が出す4けたのコードで入る
// 外部パッケージなし
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMission, HttpError } from './sat.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const COOKIE = 'soratomo_session';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
export const TOMOHANE_URL = (process.env.TOMOHANE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const LINK_SECRET = process.env.LINK_SECRET || 'tomohane-dev-link-secret';
const GAME_KEEP_MS = 30 * 60 * 1000;

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};

// SORATOMO_DATA で、遊んだ記録の置き場所を変えられる（ふだんは data/。git に入らない）
export function createApp({
  tomohaneUrl = TOMOHANE_URL, linkSecret = LINK_SECRET, fetchImpl = fetch, missionOptions = {}, now = () => Date.now(),
  dataFile = join(process.env.SORATOMO_DATA || join(ROOT, 'data'), 'players.json'),
} = {}) {
  const players = dataFile && existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : {};
  const save = () => {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    writeFileSync(dataFile, JSON.stringify(players, null, 2));
  };
  const report = (p) => fetchImpl(`${tomohaneUrl}/api/link/soratomo-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Link-Secret': linkSecret },
    body: JSON.stringify({ gameId: p.gameId, missions: p.missions, plays: p.plays }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {}); // つながらなくても、ゲームは止めない

  const sessions = new Map(); // トークン → ともはねのゲーム用の番号
  const who = (req) => players[sessions.get(readCookie(req, COOKIE))] ?? null;
  const games = new Map(); // ゲームの番号 → { mission, player, createdAt, counted }
  const gameOf = (id) => {
    const g = games.get(String(id ?? ''));
    if (!g) throw new HttpError(404, 'ゲームが見つかりません（30分すぎると消えます）');
    return g;
  };
  // ミッション達成を、いちどだけ数える
  const settle = (g) => {
    const v = g.mission.view();
    if (v.done === 'success' && !g.counted && g.player) {
      g.counted = true;
      const p = players[g.player.gameId];
      if (p) {
        p.missions = Math.min(p.missions + 1, p.plays);
        if (p.bestS == null || v.t < p.bestS) p.bestS = v.t;
        save();
        report(p);
      }
    }
    return v;
  };
  const cleanup = () => {
    for (const [id, g] of games) if (now() - g.createdAt > GAME_KEEP_MS) games.delete(id);
  };

  const routes = [
    ['GET', '/api/health', () => ({ ok: true })],
    ['GET', '/api/time', () => ({ now: now() })],
    ['GET', '/api/config', () => ({ tomohaneUrl })],
    ['GET', '/api/me', ({ req }) => {
      const p = who(req);
      return p && { name: p.name, missions: p.missions, plays: p.plays, bestS: p.bestS ?? null };
    }],
    // 新しいミッション。命令のカギは、この画面にだけわたす
    ['POST', '/api/start', ({ req }) => {
      cleanup();
      if (games.size > 500) throw new HttpError(503, 'いま混んでいます。少ししてからどうぞ');
      const p = who(req);
      const player = p && { gameId: p.gameId, name: p.name };
      const mission = createMission({ ...missionOptions, now, player });
      const id = randomBytes(9).toString('base64url');
      games.set(id, { mission, player, createdAt: now(), counted: false });
      if (p) {
        p.plays += 1;
        save();
        report(p);
      }
      return { id, secret: mission.keys.op };
    }],
    ['GET', '/api/game', ({ url }) => settle(gameOf(url.searchParams.get('id')))],
    ['POST', '/api/command', ({ body }) => {
      const g = gameOf(body.id);
      const r = g.mission.command(body);
      settle(g);
      return r;
    }],
    // 協力する人：4けたのコードで入る（ゲームの番号は知らなくてよい）
    ['POST', '/api/join', ({ body }) => {
      for (const [id, g] of games) {
        if (g.mission.inviteCode() && g.mission.inviteCode() === String(body.code)) return { id, ...g.mission.join(body.code, body.name) };
      }
      throw new HttpError(403, 'コードがちがうか、時間切れです');
    }],
  ];

  const sendJson = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };

  async function callback(req, res, url) {
    const ticket = url.searchParams.get('ticket') || '';
    if (!/^[\w-]{16,64}$/.test(ticket)) throw new HttpError(400, '通行証がありません');
    let info;
    try {
      const r = await fetchImpl(`${tomohaneUrl}/api/link/soratomo-ticket/${ticket}`, { headers: { 'X-Link-Secret': linkSecret }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error();
      info = await r.json();
    } catch {
      throw new HttpError(401, '通行証を確かめられませんでした。ともはねからもう一度どうぞ');
    }
    if (!info?.gameId || !info?.name) throw new HttpError(401, 'ともはねからの情報が足りません');
    players[info.gameId] ??= { gameId: info.gameId, missions: 0, plays: 0, bestS: null };
    players[info.gameId].name = String(info.name).slice(0, 40);
    save();
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, info.gameId);
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`, Location: '/' });
    res.end();
  }

  async function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'URL が正しくありません'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not Found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/auth/callback' && req.method === 'GET') return await callback(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && origin !== 'null') {
          let host = null;
          try { host = new URL(origin).host; } catch { /* noop */ }
          if (host !== req.headers.host) throw new HttpError(403, 'ほかのページからは操作できません');
        }
        const route = routes.find(([m, p]) => m === req.method && p === url.pathname);
        if (!route) throw new HttpError(404, 'API が見つかりません');
        const body = req.method === 'POST' ? await readJson(req) : {};
        return sendJson(res, 200, await route[2]({ req, body, url }));
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラーが発生しました' : err.message });
    }
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3800;
  if (!process.env.LINK_SECRET) console.warn('⚠️ LINK_SECRET が未設定です（開発用の値を使います）。本番では ともはね と同じ値を設定してください');
  http.createServer(createApp()).listen(port, () => console.log(`そらとも（β版）起動: http://localhost:${port}/`));
}
