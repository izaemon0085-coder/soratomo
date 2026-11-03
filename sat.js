// そらとも の頭脳：小さな人工衛星（キューブサット）の運用ゲーム
// 本物の宇宙と同じ「むずかしさ」を、やさしく：
// ・電池：日なたで充電、地球の影に入ると減る。カメラや送信は電気を食う。0 になると衛星が眠る（ゲームおわり）
// ・通信できる時間：衛星が酒田の地上局の上を通るあいだだけ、写真を送れる
// ・命令の署名：ころともと同じ（番号が前より大きく、時刻が5秒以内のものだけ）
// ・危ない命令（エンジン噴射）は2人の同意。1人のときはフクロウが10秒かけて確かめる（急がない）
// ・いつもの値と比べる：電池の減りがいつもより速いと、ヤマネコが気づく
// ・ブラックボックス：命令の記録を、あとで書きかえると分かる形で残す
// 1周（本物は約90分）を、ゲームでは2分にちぢめている
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hmacHex, signText } from './public/hmac.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const ORBIT_S = 120; // 1周の秒数
export const GAME_S = ORBIT_S * 3; // 3周まで
export const EARTH_TURN_S = ORBIT_S * 6; // 地上局が（衛星から見て）1回りする秒数
const PASS = (30 * Math.PI) / 180; // 地上局と通じる角度（±30°）
const PHOTO = (7 * Math.PI) / 180; // 鳥海山を撮れる角度（±7°）
const EARTH_R = 0.6; // 地球の大きさ（軌道を1として）
const SEND_S = 6; // 写真を送るのにかかる秒数
const STEP = 0.25;
const SOLO_CHECK_S = 10; // 1人のとき、フクロウが確かめる時間
const AGREE_S = 30;
const MAX_SKEW_MS = 5000;
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createMission({ now = () => Date.now(), random = Math.random, player = null } = {}) {
  const startedAt = now();
  const keys = { op: randomBytes(24).toString('base64url'), partner: null };
  const lastSeq = { op: 0, partner: 0 };
  let partnerName = null;
  let invite = null; // { code, until }
  const s = {
    t: 0, battery: 60, fuel: 3, camera: false, save: false,
    photo: 'none', sending: 0, solarDamaged: false,
    debris: { warnAt: 90 + random() * 50, hit: false, avoided: false }, // あらわれる時刻（秒）
    burn: null, // { by, at, solo }
    done: null, // 'success' | 'sleep' | 'timeup'
    usualDrain: null, drainWarned: false, shadowWas: false,
  };
  s.debris.arriveAt = s.debris.warnAt + 45;
  const stationStart = 0.9 + random() * 0.3; // 酒田の地上局のはじめの角度（日なたの側）
  const lines = [];
  const log = [];
  const talk = (agent, text) => {
    lines.unshift({ agent, text, t: Math.round(s.t) });
    lines.length = Math.min(lines.length, 6);
  };
  const record = (who, what, result) => {
    const prev = log.length ? log[log.length - 1].hash : '0'.repeat(64);
    const e = { n: log.length + 1, t: Math.round(s.t), who, what, result, prev };
    e.hash = sha(JSON.stringify([e.n, e.t, who, what, result, prev]));
    log.push(e);
  };
  const verifyLog = (entries = log) => entries.every((e, i) => (i === 0 || e.prev === entries[i - 1].hash) && sha(JSON.stringify([e.n, e.t, e.who, e.what, e.result, e.prev])) === e.hash);

  // ---- 位置 ----
  const satAngle = (t) => (2 * Math.PI * t) / ORBIT_S;
  const stationAngle = (t) => stationStart + (2 * Math.PI * t) / EARTH_TURN_S;
  const inShadow = (t) => Math.cos(satAngle(t)) < 0 && Math.abs(Math.sin(satAngle(t))) < EARTH_R;
  const gap = (t) => Math.abs(wrap(satAngle(t) - stationAngle(t)));
  const inPass = (t) => gap(t) < PASS;
  const overTarget = (t) => Math.abs(wrap(satAngle(t) - (stationAngle(t) + 0.15))) < PHOTO; // 鳥海山は酒田のすぐとなり

  // ---- 時間がすすむ ----
  function step() {
    const t = s.t;
    const shadow = inShadow(t);
    // 電池
    let drain = s.save ? 0.12 : 0.35;
    if (s.camera) drain += 0.6;
    if (s.sending > 0) drain += 0.8;
    const charge = shadow ? 0 : s.solarDamaged ? 0.6 : 1.2;
    s.battery = Math.min(100, s.battery + (charge - drain) * STEP);
    // 🐱 いつもの値と比べる：影の中での電池の減り
    if (shadow) {
      if (!s.shadowWas) s.drainWarned = false;
      if (s.usualDrain === null && !s.camera && s.sending === 0) s.usualDrain = drain;
      if (s.usualDrain !== null && drain > s.usualDrain * 1.8 && !s.drainWarned) {
        s.drainWarned = true;
        talk('yamaneko', `影の中で、いつもより電池の減りが ${(drain / s.usualDrain).toFixed(1)}倍 速い。カメラや送信がつけっぱなしでは？ 省電力も考えよう。`);
      }
    } else if (s.shadowWas && !s.done) {
      talk('yamaneko', '影をぬけた。日なたで充電がはじまったよ。');
    }
    s.shadowWas = shadow;
    if (s.battery <= 0) {
      s.battery = 0;
      s.done = 'sleep';
      record('衛星', '電池が0', '眠った');
      talk('fukurou', 'ほう…電池が切れて、衛星が眠ってしまいましたな。影に入る前に、電気を節約するのがコツですぞ。');
      return;
    }
    // 写真を撮る（カメラがついていて、鳥海山の上で、日なた）
    if (s.photo === 'none' && s.camera && overTarget(t) && !shadow) {
      s.photo = 'taken';
      record('衛星', '鳥海山の写真', '撮れた');
      talk('usagi', '鳥海山の写真が撮れたよ ♪ 次は、酒田の地上局へ送ろう！ カメラは消して電気を節約してね。');
    }
    // 写真を送る（地上局と通じるあいだだけ）
    if (s.sending > 0) {
      if (!inPass(t)) {
        s.sending = 0;
        talk('mogu', '地上局が見えなくなって、送るのがとぎれたよ。次に通じたとき、もう一度送ってね。');
      } else {
        s.sending -= STEP;
        if (s.sending <= 0) {
          s.sending = 0;
          s.photo = 'sent';
          record('衛星', '写真を送る', '酒田にとどいた');
          talk('mogu', '写真が酒田の地上局にとどいたよ！ 鳥海山、きれいに写ってる。');
        }
      }
    }
    // デブリ
    const d = s.debris;
    if (!d.warned && t >= d.warnAt) {
      d.warned = true;
      record('地上', 'デブリ接近', `あと${Math.round(d.arriveAt - t)}秒`);
      talk('fukurou', `ほう、デブリ（宇宙のごみ）が近づいてきますぞ。あと${Math.round(d.arriveAt - t)}秒。エンジン噴射でよけましょう（2人の同意が必要）。`);
    }
    // エンジン噴射：1人のときは、フクロウが10秒かけて確かめる
    if (s.burn && !s.burn.done && s.burn.solo && t - s.burn.at >= SOLO_CHECK_S) doBurn('フクロウの確認');
    if (s.burn && !s.burn.done && !s.burn.solo && t - s.burn.at > AGREE_S) {
      s.burn = null;
      talk('fukurou', 'もう1人の同意が30秒のうちに来なかったので、噴射は取りやめましたぞ。');
    }
    if (d.warned && !d.avoided && !d.hit && t >= d.arriveAt) {
      d.hit = true;
      s.solarDamaged = true;
      record('衛星', 'デブリ', 'ソーラーパネルに当たった（充電が半分）');
      talk('fukurou', 'デブリがソーラーパネルをかすめましたぞ。充電が半分になりました。次はよけましょう。');
    }
    // ミッション
    if (s.photo === 'sent' && d.avoided && !s.done) {
      s.done = 'success';
      record('地上', 'ミッション', '達成');
      talk('usagi', `ミッション達成！ ${Math.round(t)}秒。${player ? `${player.name}さん、` : ''}宇宙の運用、おみごと ♪`);
    }
    s.t += STEP;
    if (s.t >= GAME_S && !s.done) {
      s.done = 'timeup';
      record('地上', '3周', '時間切れ');
      talk('fukurou', '3周たちましたな。今回はここまで。電池・通信の時間・デブリ、だんだん読めてきたでしょう。');
    }
  }
  function doBurn(by) {
    s.burn.done = true;
    if (s.fuel <= 0) return talk('fukurou', '燃料がもうありませんぞ。');
    s.fuel -= 1;
    s.battery = Math.max(0, s.battery - 8);
    const d = s.debris;
    if (d.warned && !d.hit && !d.avoided) {
      d.avoided = true;
      record(by, 'エンジン噴射', 'デブリをよけた');
      talk('fukurou', `噴射！ デブリをよけましたぞ（${by}）。燃料はあと${s.fuel}回分。`);
    } else {
      record(by, 'エンジン噴射', 'よけるものがなかった');
      talk('fukurou', `噴射しましたが、よけるものはありませんでしたな。燃料はあと${s.fuel}回分。むだづかいに注意ですぞ。`);
    }
  }

  // 実際の時刻に合わせて進める（だれかが見たときに、まとめて）
  function advance() {
    const target = Math.min((now() - startedAt) / 1000, GAME_S);
    while (!s.done && s.t + STEP <= target) step();
  }

  // ---- 命令（署名つき） ----
  function command(msg) {
    advance();
    const who = msg?.who;
    if (!['op', 'partner'].includes(who) || !keys[who]) throw new HttpError(401, 'この衛星の管制官ではありません');
    const { seq, at, cmd, mac } = msg;
    if (!Number.isInteger(seq) || !Number.isFinite(at) || typeof cmd?.type !== 'string' || typeof mac !== 'string') throw new HttpError(400, '命令の形がちがいます');
    const want = Buffer.from(hmacHex(keys[who], signText(msg)));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      record(who === 'op' ? '管制官' : partnerName, cmd.type, '署名がちがう → 受けとらない');
      throw new HttpError(401, '署名がちがいます');
    }
    if (seq <= lastSeq[who]) throw new HttpError(409, '古い命令です（使い回しは受けとらない）');
    if (Math.abs(now() - at) > MAX_SKEW_MS) throw new HttpError(409, '時刻がずれています');
    lastSeq[who] = seq;
    if (s.done) throw new HttpError(409, 'このミッションはおわりました');
    const name = who === 'op' ? (player?.name ?? '管制官') : partnerName;
    switch (cmd.type) {
      case 'camera':
        s.camera = Boolean(cmd.on);
        record(name, `カメラ ${s.camera ? 'オン' : 'オフ'}`, 'ok');
        break;
      case 'save':
        s.save = Boolean(cmd.on);
        record(name, `省電力 ${s.save ? 'オン' : 'オフ'}`, 'ok');
        break;
      case 'send':
        if (s.photo !== 'taken') throw new HttpError(409, s.photo === 'sent' ? 'もう送りました' : 'まだ写真がありません');
        if (!inPass(s.t)) throw new HttpError(409, 'いまは地上局と通じていません（酒田の上を通るときに）');
        s.sending = SEND_S;
        record(name, '写真を送る', 'はじめた');
        talk('mogu', `写真を送りはじめたよ。${SEND_S}秒かかる。地上局が見えているうちに！`);
        break;
      case 'burn': {
        if (s.burn && !s.burn.done) {
          // もう1人が同意する
          if (s.burn.solo || s.burn.who === who) throw new HttpError(409, s.burn.solo ? 'フクロウが確かめています' : 'もう1人の同意を待っています');
          record(`${s.burn.name}＋${name}`, 'エンジン噴射', '2人の同意');
          doBurn(`${s.burn.name}と${name}`);
          break;
        }
        const solo = !keys.partner;
        s.burn = { who, name, at: s.t, solo, done: false };
        record(name, 'エンジン噴射をもとめる', solo ? 'フクロウが10秒で確かめる' : 'もう1人の同意を待つ（30秒）');
        talk('fukurou', solo
          ? 'ほう、エンジン噴射ですな。1人のときは、わたしが10秒かけて確かめますぞ。あわてず待ちましょう。'
          : `${name} がエンジン噴射をもとめていますぞ。もう1人が30秒以内に「エンジン噴射」を押すと噴射します。`);
        break;
      }
      case 'invite': {
        if (who !== 'op') throw new HttpError(403, '管制官だけができます');
        invite = { code: String(randomInt(0, 10000)).padStart(4, '0'), until: now() + 120000 };
        return { ok: true, code: invite.code };
      }
      default:
        throw new HttpError(400, '知らない命令です');
    }
    return { ok: true };
  }

  // 協力する人（2人目の管制官）：管制官が出した4けたのコードで入る
  function join(code, name) {
    const nm = String(name ?? '').trim().slice(0, 20);
    if (!nm) throw new HttpError(400, '名前を入れてください');
    if (!invite || now() > invite.until || String(code) !== invite.code) throw new HttpError(403, 'コードがちがうか、時間切れです');
    if (keys.partner) throw new HttpError(409, 'もう2人そろっています');
    invite = null;
    keys.partner = randomBytes(24).toString('base64url');
    partnerName = nm;
    record(nm, '協力する管制官', '入った');
    talk('fukurou', `${nm} が協力する管制官として入りましたぞ。エンジン噴射は、2人そろって押しましょう。`);
    return { secret: keys.partner };
  }

  function view() {
    advance();
    const t = s.t;
    return {
      t: Math.round(t * 10) / 10, gameS: GAME_S, orbit: Math.floor(t / ORBIT_S) + 1,
      sat: satAngle(t), station: stationAngle(t), target: stationAngle(t) + 0.15, earthR: EARTH_R,
      shadow: inShadow(t), pass: inPass(t),
      battery: Math.round(s.battery), fuel: s.fuel, camera: s.camera, save: s.save,
      photo: s.photo, sending: s.sending, solarDamaged: s.solarDamaged,
      debris: s.debris.warned ? { left: Math.max(0, Math.round(s.debris.arriveAt - t)), avoided: s.debris.avoided, hit: s.debris.hit } : null,
      burn: s.burn && !s.burn.done ? { name: s.burn.name, solo: s.burn.solo, left: Math.max(0, Math.ceil((s.burn.solo ? SOLO_CHECK_S : AGREE_S) - (t - s.burn.at))) } : null,
      missions: [
        { label: '鳥海山の写真を撮る', done: s.photo !== 'none' },
        { label: '写真を酒田の地上局へ送る', done: s.photo === 'sent' },
        { label: 'デブリをよける', done: s.debris.avoided },
      ],
      done: s.done, player: player?.name ?? null, partner: partnerName,
      lines, log: log.slice(-12).reverse(), logOk: verifyLog(),
    };
  }

  return { command, join, view, advance, verifyLog, keys, state: s, allLog: () => log, inviteCode: () => invite?.code ?? null };
}
