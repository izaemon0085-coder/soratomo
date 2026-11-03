// 🐰 ウサギの変更まとめ（工程 1-5）
// 版（v0.1.0 など）を付けたとき、前の版からのコミットを、分かりやすいリリースノートにまとめる。
// 使い方：node .github/agents/usagi-notes.mjs v0.1.0 > notes.md
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tag = process.argv[2];
if (!tag) {
  console.error('版の名前（例：v0.1.0）を渡してください');
  process.exit(1);
}
let prev = '';
try { prev = git('describe', '--tags', '--abbrev=0', `${tag}^`); } catch { /* はじめての版 */ }
const range = prev ? `${prev}..${tag}` : tag;
const commits = git('log', range, '--no-merges', '--format=%h%x09%s').split('\n').filter(Boolean)
  .map((l) => { const [hash, ...s] = l.split('\t'); return { hash, subject: s.join('\t') }; });

// コミットの最初のことばで、なかま分けする
const GROUPS = [
  ['✨ 新しくできたこと', /^(Add|Start|Create|New|Introduce)\b/i],
  ['🔗 つながったアプリ', /^Link\b/i],
  ['🔧 直したこと', /^(Fix|Correct|Repair)\b/i],
  ['🧰 しくみ・テスト', /^(Run|Name|Test|CI|Build|Refactor|Move|Rename|Update)\b/i],
];
const groups = new Map(GROUPS.map(([title]) => [title, []]));
const other = [];
for (const c of commits) {
  const g = GROUPS.find(([, re]) => re.test(c.subject));
  (g ? groups.get(g[0]) : other).push(c);
}

const out = [
  `🐰 **ウサギから**：${tag} ができたよ〜！ ${prev ? `${prev} から` : 'はじめから'} ${commits.length} 個の変更があったよ ♪`,
  '',
];
for (const [title, list] of [...groups, ['🌷 そのほか', other]]) {
  if (!list.length) continue;
  out.push(`### ${title}`, ...list.map((c) => `- ${c.subject}（${c.hash}）`), '');
}
out.push('<sub>（ウサギはまとめるだけ。版を出すと決めたのは人だよ）</sub>');
console.log(out.join('\n'));
