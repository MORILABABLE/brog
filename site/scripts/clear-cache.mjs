/**
 * Astro のキャッシュを消す。**手元で「直したのに反映されない」ときの唯一の対処。**
 *
 *   cd site && npm run dev:fresh      キャッシュを消してから dev
 *   cd site && npm run build:fresh    キャッシュを消してからビルド
 *
 * ■ なぜ要るのか
 * **記事の描画結果（HTML）がキャッシュされる。**
 * `.md` が変わらないかぎり再描画されないので、
 *
 *   - rehype プラグインを直した（plugins/rehype-*.ts）
 *   - プラグインが読む data/ のファイルを更新した
 *     （events / availability / titles …）
 *
 * のどちらも**手元では反映されない**。`.md` は1文字も変わっていないため。
 *
 * ★ **これは何度も踏んでいる。**
 *   plugins/rehype-work-links.ts の冒頭にも同じ注意書きがあり、
 *   2026-09-06 に availability の行を足したときにも踏んだ
 *   （新しく起動した dev だけが古い表を出し、
 *   前日から動いていた dev のほうが正しい表を出す、という形で現れた）。
 *
 * ■ Cloudflare のビルドは毎回まっさら
 * **公開されるものは常に最新。** 手元で確認するときだけ気をつける。
 *
 * ■ 消すもの
 *   .astro/                 コンテンツコレクションの描画結果（data-store.json）
 *   node_modules/.astro/    Vite / Astro の中間生成物
 *
 * ★ `dist/` は消さない。**開いているエディタやサーバがファイルを掴んでいると
 *   Windows で削除に失敗する**（実際に `Device or resource busy` で落ちた）。
 *   ビルドが自分で作り直すので、消す必要もない。
 */
import { rmSync, existsSync } from 'node:fs'

const TARGETS = ['.astro', 'node_modules/.astro']

let removed = 0
for (const dir of TARGETS) {
  if (!existsSync(dir)) continue
  try {
    rmSync(dir, { recursive: true, force: true })
    console.log(`  消した: ${dir}`)
    removed++
  } catch (err) {
    // 消せなくても止めない。**掴まれているだけのことがある。**
    console.warn(`  消せなかった: ${dir} (${err.code ?? err.message})`)
  }
}
if (removed === 0) console.log('  キャッシュはありませんでした。')
