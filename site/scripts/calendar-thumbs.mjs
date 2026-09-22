/**
 * 記事の中に差し込む「配信カレンダー」カードの絵を用意する。
 *
 * **ビルド時に自動で走る**（package.json の prebuild）。手で実行してもよい。
 *   cd site && node scripts/calendar-thumbs.mjs
 *
 * ■ 何のためにあるか（2026-09-22・運用者の指定）
 * 記事の小段落2の表の直下に、配信カレンダーへの導線が自動で入る
 * （`plugins/rehype-section-ads.ts` の `calendarBlock`）。これを
 * **トップの「配信カレンダー」の棚と同じ絵＋タイトル**のカードにした。
 *
 * 絵の原本は `src/assets/services/<キー>.png`（1200×1200・`scripts/service-cards.mjs` が描く）。
 * トップや左の枠は Astro の画像処理（`Thumb.astro`）で縮めて出しているが、
 * **rehype が組むHTMLはその処理を通らない。** 原本の 1200px をそのまま記事に載せると重いので、
 * ここで小さい版を `public/calendar-thumbs/<キー>.webp` に書き出す。
 *
 * ★ **原本を描き直したら、この出力も次のビルドで勝手に追従する**（毎回まるごと作り直す）。
 * ★ 表示は 72px なので 2倍の 144px で書く（`.prose .section-calendar-thumb` と揃える）。
 * ★ 出力は生成物なので git に入れない（site/.gitignore）。
 * ★ **落ちないこと。** 原本が無い・壊れていても、カードは色のタイルになるだけ
 *   （rehype 側が絵の有無を見ている）。ビルドは止めない。
 */
import sharp from 'sharp'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src', 'assets', 'services')
const outDir = join(here, '..', 'public', 'calendar-thumbs')
const SIZE = 144

mkdirSync(outDir, { recursive: true })

let made = 0
for (const name of existsSync(srcDir) ? readdirSync(srcDir) : []) {
  if (!name.endsWith('.png')) continue
  const key = name.replace(/\.png$/, '')
  try {
    await sharp(join(srcDir, name))
      .resize(SIZE, SIZE, { fit: 'cover' })
      .webp({ quality: 85 })
      .toFile(join(outDir, `${key}.webp`))
    made++
  } catch (err) {
    console.warn(`カレンダーの絵: ${name} を縮められませんでした（${err.message}）`)
  }
}
console.log(`カレンダーの絵: ${made}枚`)
