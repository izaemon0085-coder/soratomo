// 🦉 フクロウの安全チェック（工程 1-2）
// リポジトリに入っているファイルに、合言葉・パスワード・カギらしいものが書きこまれていないかを見る。
// 見つけたら止める（終了コード 1）。外部パッケージなし。
// どうしても必要な見本の行には、行の中に「owl:allow」と書くと見のがす（理由もいっしょに書くこと）
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

// 入れてはいけないファイル（保存データ・カギのファイル）
const BAD_FILES = [
  [/(^|\/)\.env(\.|$)/, '.env（合言葉を書くファイル）'],
  [/\.(pem|key|p12|pfx)$/i, 'カギのファイル'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)$/, 'SSH のカギ'],
  [/(^|\/)data\/.+\.json$/, '保存データ（data/ の中）'],
  [/(^|\/)db\.json$/, '保存データ（db.json）'],
];
// 中身に書いてはいけないもの（形で見分ける）
const BAD_TEXT = [
  [new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----'), '秘密のカギ'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS のアクセスキー'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub のトークン'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub のトークン'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/, 'AI サービスのカギ'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack のトークン'],
  [/\btg_[A-Za-z0-9_-]{30,}\b/, 'ともはね のゲームの合言葉'],
  [/\b(LINK_SECRET|TOMOHANE_SECRET|PASSWORD|API_KEY)\s*=\s*['"]?[A-Za-z0-9_+/=-]{16,}/, '環境変数に入れる合言葉'],
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const found = [];
for (const f of files) {
  for (const [re, label] of BAD_FILES) if (re.test(f)) found.push(`${f}：${label}は入れないでくだされ`);
  let text;
  try {
    if (statSync(f).size > 1024 * 1024) continue;
    text = readFileSync(f, 'utf8');
  } catch { continue; }
  if (text.includes('\0')) continue; // 画像などは見ない
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('owl:allow')) return;
    for (const [re, label] of BAD_TEXT) if (re.test(line)) found.push(`${f}:${i + 1}：${label}のようなものがあります`);
  });
}

if (found.length) {
  console.log('🦉 ほう……あぶないものを見つけましたぞ。送る前に消してくだされ。');
  for (const x of found) console.log(`  ・${x}`);
  console.log('もう送ってしまった本物の合言葉は、消すだけでなく「新しいものに取りかえる」のが大事ですぞ。');
  process.exit(1);
}
console.log(`🦉 ほう、${files.length} 個のファイルを見ました。あぶないものはありませんでしたぞ。`);
