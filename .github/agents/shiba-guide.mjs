// 🐕 シバの案内（工程 1-4）
// プルリクエストでテストが落ちたとき、「どのテストが・どこで落ちたか」をやさしくコメントする。
// 使い方：node .github/agents/shiba-guide.mjs test-output.txt
// 環境変数：GITHUB_TOKEN・GITHUB_REPOSITORY・PR_NUMBER・RUN_URL（GitHub Actions が渡す）
import { readFileSync } from 'node:fs';

const out = (() => { try { return readFileSync(process.argv[2] || 'test-output.txt', 'utf8'); } catch { return ''; } })();
const lines = out.split(/\r?\n/);

// 落ちたテストの名前（spec 形式の「✖ 名前 (12ms)」と、TAP 形式の「not ok 3 - 名前」の両方を読む）
const failed = new Set();
for (const l of lines) {
  const spec = l.match(/^\s*✖\s+(.+?)\s+\(\d[\d.]*m?s\)\s*$/);
  const tap = l.match(/^\s*not ok \d+ - (.+?)\s*$/);
  const name = (spec?.[1] ?? tap?.[1])?.trim();
  if (name && name !== 'failing tests:') failed.add(name);
}
// エラーのはじめの数行
const errors = lines.filter((l) => /AssertionError|Error:|error:|expected|actual/.test(l)).slice(0, 8).map((l) => l.trim());

const list = [...failed].slice(0, 10).map((n) => `- ${n}`).join('\n') || '- （名前を読みとれなかったっす。下の記録を見てほしいっす）';
const body = [
  '🐕 **シバっす！ テストが落ちちゃったっす。** でもだいじょうぶ、ここを直せば通るっす！',
  '',
  '**落ちたテスト**',
  list,
  ...(errors.length ? ['', '**エラーのはじめ**', '```', ...errors, '```'] : []),
  '',
  '**ためし方**：パソコンで `npm test` を動かすと、同じものが見られるっす。直したら、もう一度送ればOKっす。',
  process.env.RUN_URL ? `**くわしい記録**：${process.env.RUN_URL}` : '',
  '',
  '<sub>（シバは案内だけするっす。直す・マージするかを決めるのは人っす）</sub>',
].join('\n');

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env;
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) {
  console.log(body);
  process.exit(0);
}
const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  body: JSON.stringify({ body }),
});
console.log(res.ok ? '🐕 コメントしたっす！' : `🐕 コメントできなかったっす（${res.status}）`);
