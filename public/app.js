// 管制室：地球と衛星を描き、命令に署名して送る。0.25秒ごとに衛星の様子を見る
import { hmacHex, signText } from '/hmac.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let game = null; // { id, who, secret }
let seq = 0;
let offset = 0;
let view = null;
let timer = null;

async function call(path, body) {
  const res = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}
async function send(cmd) {
  seq = Math.max(seq + 1, Date.now());
  const msg = { id: game.id, who: game.who, seq, at: Date.now() + offset, cmd };
  msg.mac = hmacHex(game.secret, signText(msg));
  try {
    const r = await call('command', msg);
    $('#error').textContent = '';
    await poll();
    return r;
  } catch (e) {
    $('#error').textContent = e.message;
    return null;
  }
}
function tomohaneUrl(path, base) {
  const u = new URL(path, base);
  if (['localhost', '127.0.0.1'].includes(u.hostname) && !['localhost', '127.0.0.1'].includes(location.hostname)) u.hostname = location.hostname;
  return u.href;
}

// ---- 地球と衛星 ----
function draw(v) {
  const c = $('#orbit');
  const g = c.getContext('2d');
  const W = c.width;
  const C = W / 2;
  const R = W * 0.4; // 軌道
  const E = R * v.earthR; // 地球
  const at = (a, r) => [C + Math.cos(a) * r, C - Math.sin(a) * r];
  g.clearRect(0, 0, W, W);
  // 星空
  g.fillStyle = 'rgba(255,255,255,.5)';
  for (let i = 0; i < 60; i++) g.fillRect((i * 97) % W, (i * 233) % W, 2, 2);
  // 地球の影（太陽は右から）
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.fillRect(0, C - E, C, E * 2);
  // 軌道
  g.strokeStyle = 'rgba(111,211,255,.35)';
  g.lineWidth = 2;
  g.setLineDash([6, 8]);
  g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  // 地上局と通じる範囲
  g.fillStyle = v.pass ? 'rgba(126,224,161,.25)' : 'rgba(126,224,161,.10)';
  g.beginPath(); g.moveTo(C, C);
  g.arc(C, C, R + 24, -v.station - Math.PI / 6, -v.station + Math.PI / 6);
  g.closePath(); g.fill();
  // 地球（昼と夜）
  const grad = g.createLinearGradient(C - E, 0, C + E, 0);
  grad.addColorStop(0, '#173a6b'); grad.addColorStop(0.5, '#2f73c4'); grad.addColorStop(1, '#5fb0ff');
  g.fillStyle = grad;
  g.beginPath(); g.arc(C, C, E, 0, Math.PI * 2); g.fill();
  g.font = '28px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('☀️', W - 24, 24);
  // 酒田の地上局・鳥海山
  const [sx, sy] = at(v.station, E);
  const [tx, ty] = at(v.target, E + 4);
  g.fillText('📡', sx, sy);
  g.fillText('🏔️', tx, ty);
  g.font = 'bold 15px system-ui'; g.fillStyle = '#eef1ff';
  const [lx, ly] = at(v.station, E - 30);
  g.fillText('酒田', lx, ly);
  // デブリ（衛星の前から近づく）
  if (v.debris && !v.debris.avoided && !v.debris.hit) {
    const [dx, dy] = at(v.sat + Math.min(1.6, 0.02 + v.debris.left * 0.03), R);
    g.font = '30px system-ui';
    g.fillText('☄️', dx, dy);
  }
  // 衛星
  const [x, y] = at(v.sat, R);
  if (v.pass) { g.strokeStyle = 'rgba(126,224,161,.8)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(sx, sy); g.stroke(); }
  g.font = '40px system-ui';
  g.fillText('🛰️', x, y);
  if (v.camera) { g.font = '18px system-ui'; g.fillText('📷', x + 26, y - 22); }
}

function render(v) {
  view = v;
  draw(v);
  $('#battery').textContent = `${v.battery}%`;
  const bar = $('#battery-bar');
  bar.style.width = `${v.battery}%`;
  bar.className = v.battery < 25 ? 'low' : '';
  $('#sun').textContent = v.shadow ? '🌑 影' : '☀️ 日なた';
  $('#pass').textContent = v.pass ? '📡 通じる' : '－';
  $('#fuel').textContent = `${'🔥'.repeat(v.fuel)}${v.fuel ? '' : 'なし'}`;
  $('#time').textContent = `${v.orbit}周目 ${Math.floor(v.t)}秒`;
  $('#missions').innerHTML = v.missions.map((m) => `<li class="${m.done ? 'done' : ''}">${m.done ? '✅' : '⬜'} ${esc(m.label)}</li>`).join('');
  $('#who-line').textContent = `${v.player ? `管制官：${v.player}` : '管制官'}${v.partner ? `　協力：${v.partner}` : ''}${game.who === 'partner' ? '（あなたは協力する管制官）' : ''}`;
  $('#camera').setAttribute('aria-pressed', String(v.camera));
  $('#save').setAttribute('aria-pressed', String(v.save));
  $('#send').disabled = v.photo !== 'taken' || v.sending > 0;
  $('#send').textContent = v.sending > 0 ? `📡 送っています（あと${Math.ceil(v.sending)}秒）` : v.photo === 'sent' ? '📡 送りました' : '📡 写真を送る';
  $('#burn').textContent = v.burn ? (v.burn.solo ? `🦉 フクロウが確かめ中（${v.burn.left}秒）` : `🔥 ${v.burn.name} が噴射をもとめています（${v.burn.left}秒）`) : v.debris && !v.debris.avoided && !v.debris.hit ? `🔥 エンジン噴射（デブリまで${v.debris.left}秒）` : '🔥 エンジン噴射（2人の同意）';
  $('#invite').hidden = game.who !== 'op' || Boolean(v.partner);
  if (v.partner) $('#invite-code').hidden = true;
  $('#lines').innerHTML = v.lines.map((l) => `<li class="line"><img src="/avatars/${esc(l.agent)}.svg" alt=""><p>${esc(l.text)}</p></li>`).join('') || '<li class="line"><img src="/avatars/fukurou.svg" alt=""><p>ほう、管制室へようこそ。まずはカメラをつけて、鳥海山の上を待ちましょう。</p></li>';
  $('#log-ok').innerHTML = v.logOk ? '<span class="ok small">✔ 鎖はつながっている</span>' : '<span class="ng small">✖ 書きかえられている</span>';
  $('#log').innerHTML = v.log.map((e) => `<li>${e.t}秒　<strong>${esc(e.who)}</strong>：${esc(e.what)} → ${esc(e.result)} <span class="hash">${esc(e.hash.slice(0, 8))}…</span></li>`).join('');
  for (const b of ['#camera', '#save', '#burn', '#send', '#invite']) if (v.done) $(b).disabled = true;
  if (v.done) {
    $('#end').hidden = false;
    const ok = v.done === 'success';
    $('#end-title').textContent = ok ? '🎉 ミッション達成！' : v.done === 'sleep' ? '😴 衛星が眠ってしまった' : '⏱️ 3周たちました';
    $('#end-text').textContent = ok ? `${Math.round(v.t)}秒で、3つのミッションを達成しました。${v.player ? 'ともはね に記録しました。' : ''}` : '電池・通信できる時間・デブリ。次はきっとうまくいきます。';
    clearInterval(timer);
  }
}

async function poll() {
  try { render(await call(`game?id=${encodeURIComponent(game.id)}`)); } catch (e) {
    $('#error').textContent = e.message;
    if (/見つかりません/.test(e.message)) { // 30分すぎて消えたゲーム → はじめの画面へ
      clearInterval(timer);
      try { sessionStorage.removeItem('soratomo-game'); } catch { /* noop */ }
      $('#room').hidden = true;
      $('#start').hidden = false;
    }
  }
}
function enter(g) {
  game = g;
  try { sessionStorage.setItem('soratomo-game', JSON.stringify(g)); } catch { /* noop */ }
  $('#start').hidden = true;
  $('#room').hidden = false;
  $('#end').hidden = true;
  for (const b of ['#camera', '#save', '#burn', '#invite']) $(b).disabled = false;
  clearInterval(timer);
  timer = setInterval(poll, 250);
  poll();
}

$('#go').addEventListener('click', async () => {
  try { enter({ ...(await call('start', {})), who: 'op' }); } catch (e) { $('#start-error').textContent = e.message; }
});
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await call('join', { code: f.get('code'), name: f.get('name') });
    enter({ id: r.id, secret: r.secret, who: 'partner' });
  } catch (err) { $('#start-error').textContent = err.message; }
});
$('#camera').addEventListener('click', () => send({ type: 'camera', on: !view?.camera }));
$('#save').addEventListener('click', () => send({ type: 'save', on: !view?.save }));
$('#send').addEventListener('click', () => send({ type: 'send' }));
$('#burn').addEventListener('click', () => send({ type: 'burn' }));
$('#invite').addEventListener('click', async () => {
  const r = await send({ type: 'invite' });
  if (r?.code) {
    $('#invite-code').textContent = r.code;
    $('#invite-code').hidden = false;
  }
});
$('#again').addEventListener('click', () => {
  try { sessionStorage.removeItem('soratomo-game'); } catch { /* noop */ }
  location.reload();
});

// はじめ
try { offset = (await call('time')).now - Date.now(); } catch { /* noop */ }
try {
  const [cfg, me] = await Promise.all([call('config'), call('me')]);
  $('#back').href = tomohaneUrl('/', cfg.tomohaneUrl);
  $('#me-line').innerHTML = me
    ? `ともはねの <strong>${esc(me.name)}</strong> さん：ミッション達成 ${me.missions}回（${me.plays}回あそんだ）${me.bestS != null ? `・自己ベスト ${Math.round(me.bestS)}秒` : ''}`
    : `<a href="${esc(tomohaneUrl('/api/link/soratomo-start', cfg.tomohaneUrl))}">ともはねでログイン</a>すると、ミッション達成の数が ともはね に残ります（ログインしなくても遊べます）。`;
} catch { /* ともはねがなくても遊べる */ }
try {
  const saved = JSON.parse(sessionStorage.getItem('soratomo-game'));
  if (saved?.id) enter(saved);
} catch { /* noop */ }
