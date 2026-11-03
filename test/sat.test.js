import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMission } from '../sat.js';
import { createApp } from '../server.js';
import { hmacHex, signText } from '../public/hmac.js';

// random は 0.5（デブリは115秒にあらわれ、160秒にくる。酒田の地上局は 1.05 rad から）
// 鳥海山の真上は 27.5秒ごろ（日なた）、地上局と通じるのは 12〜36秒ごろ
function setup(player = null) {
  let t = 1_800_000_000_000;
  const m = createMission({ now: () => t, random: () => 0.5, player });
  const seq = { op: 0, partner: 0 };
  const secret = { op: m.keys.op, partner: null };
  const send = (who, cmd, over = {}) => {
    const msg = { who, seq: ++seq[who], at: t, cmd, ...over };
    msg.mac = over.mac ?? hmacHex(secret[who], signText(msg));
    return m.command(msg);
  };
  return {
    m, send, secret,
    to: (sec) => { t = 1_800_000_000_000 + sec * 1000; m.advance(); },
  };
}

test('署名：ちがう署名・使い回し・時刻ずれは受けとらない', () => {
  const { m, send } = setup();
  assert.throws(() => send('op', { type: 'camera', on: true }, { mac: 'x'.repeat(64) }), /署名がちがいます/);
  send('op', { type: 'camera', on: true });
  assert.throws(() => send('op', { type: 'camera', on: false }, { seq: 1 }), /使い回し/);
  assert.throws(() => send('op', { type: 'camera', on: false }, { at: 0 }), /時刻/);
  assert.throws(() => send('partner', { type: 'burn' }), /管制官ではありません/);
  assert.equal(m.view().camera, true);
});

test('写真：鳥海山の上で撮れる → 地上局と通じるあいだに送る', () => {
  const { m, send, to } = setup();
  send('op', { type: 'camera', on: true });
  assert.throws(() => send('op', { type: 'send' }), /まだ写真/);
  to(29);
  assert.equal(m.view().photo, 'taken');
  send('op', { type: 'camera', on: false });
  send('op', { type: 'send' });
  to(36);
  assert.equal(m.view().photo, 'sent');
  assert.ok(m.view().lines.some((l) => l.agent === 'mogu' && /とどいた/.test(l.text)));
});

test('写真：地上局と通じていないときは送れない', () => {
  const { m, send, to } = setup();
  send('op', { type: 'camera', on: true });
  to(29);
  to(45);
  assert.equal(m.view().pass, false);
  assert.throws(() => send('op', { type: 'send' }), /地上局と通じていません/);
});

test('デブリ：1人のときはフクロウが10秒かけて確かめてから噴射', () => {
  const { m, send, to } = setup();
  to(116);
  assert.ok(m.view().debris);
  send('op', { type: 'burn' });
  to(121);
  assert.equal(m.view().debris.avoided, false, 'まだ確かめている');
  to(127);
  assert.equal(m.view().debris.avoided, true);
  assert.equal(m.view().fuel, 2);
});

test('デブリ：2人のときは、もう1人が押したらすぐ噴射。同じ人の2回はだめ', () => {
  const { m, send, secret, to } = setup();
  const { code } = send('op', { type: 'invite' });
  secret.partner = m.join(code, 'ともだち').secret;
  assert.throws(() => m.join(code, 'もう1人'), /コードがちがうか|もう2人/);
  to(116);
  send('op', { type: 'burn' });
  assert.throws(() => send('op', { type: 'burn' }), /同意を待って/);
  send('partner', { type: 'burn' });
  assert.equal(m.view().debris.avoided, true);
  assert.match(m.view().log.map((e) => e.who).join(), /＋ともだち/);
});

test('デブリをよけないと、ソーラーパネルに当たって充電が半分', () => {
  const { m, to } = setup();
  to(161);
  assert.equal(m.view().debris.hit, true);
  assert.equal(m.view().solarDamaged, true);
});

test('電池：影でカメラをつけっぱなしにすると、ヤマネコが気づく。0 で衛星が眠る', () => {
  const { m, send, to } = setup();
  to(75); // 1回目の影（いつもの減りを覚える）
  send('op', { type: 'camera', on: true });
  to(185); // 2回目の影
  assert.ok(m.view().lines.some((l) => l.agent === 'yamaneko' && /いつもより電池の減り/.test(l.text)));
  m.state.battery = 1;
  to(188);
  assert.equal(m.view().done, 'sleep');
});

test('ミッション達成：写真を撮って送って、デブリをよける。ブラックボックスは書きかえると分かる', () => {
  const { m, send, to } = setup({ gameId: 's_1', name: 'さいとう' });
  send('op', { type: 'camera', on: true });
  to(29);
  send('op', { type: 'camera', on: false });
  send('op', { type: 'send' });
  to(116);
  send('op', { type: 'burn' });
  to(127);
  assert.equal(m.view().done, 'success');
  assert.ok(m.view().lines.some((l) => l.agent === 'usagi' && /さいとうさん/.test(l.text)));
  assert.equal(m.verifyLog(), true);
  const copy = m.allLog().map((e) => ({ ...e }));
  copy[0].result = 'なにもなかった';
  assert.equal(m.verifyLog(copy), false);
});

// ---- サーバー：ともはねでログイン → 遊んだ回数とミッション達成が ともはね に ----
let server;
let base;
let clock = 1_800_000_000_000;
const reported = [];
const fake = async (url, opts = {}) => {
  const u = new URL(url);
  if (opts.headers?.['X-Link-Secret'] !== 'test-secret') return { ok: false, json: async () => ({}) };
  if (u.pathname === '/api/link/soratomo-ticket/good-ticket-1234567890') return { ok: true, json: async () => ({ gameId: 's_abc', name: 'さいとう', ageGroup: 'child' }) };
  if (u.pathname === '/api/link/soratomo-results') { reported.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  return { ok: false, json: async () => ({}) };
};
before(async () => {
  server = http.createServer(createApp({ tomohaneUrl: 'http://tomohane.test', linkSecret: 'test-secret', fetchImpl: fake, dataFile: null, now: () => clock, missionOptions: { random: () => 0.5 } }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('ともはねでログイン → ミッション達成は1回だけ数える', async () => {
  const cb = await fetch(`${base}/auth/callback?ticket=good-ticket-1234567890`, { redirect: 'manual' });
  const cookie = cb.headers.get('set-cookie').split(';')[0];
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  const { id, secret } = await post('/api/start', {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(reported.at(-1), { gameId: 's_abc', missions: 0, plays: 1 });
  let seq = 0;
  const cmd = (c) => { const m = { id, who: 'op', seq: ++seq, at: clock, cmd: c }; m.mac = hmacHex(secret, signText(m)); return post('/api/command', m); };
  const start = clock;
  await cmd({ type: 'camera', on: true });
  clock = start + 29000; await fetch(`${base}/api/game?id=${id}`);
  await cmd({ type: 'camera', on: false });
  await cmd({ type: 'send' });
  clock = start + 116000; await fetch(`${base}/api/game?id=${id}`);
  await cmd({ type: 'burn' });
  clock = start + 127000;
  assert.equal((await (await fetch(`${base}/api/game?id=${id}`)).json()).done, 'success');
  await fetch(`${base}/api/game?id=${id}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(reported.at(-1), { gameId: 's_abc', missions: 1, plays: 1 });
  assert.equal(reported.filter((r) => r.missions === 1).length, 1, '何度見ても1回だけ');
  const best = (await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).bestS;
  assert.ok(best > 125 && best < 127, `達成のタイム ${best}秒`);
});
