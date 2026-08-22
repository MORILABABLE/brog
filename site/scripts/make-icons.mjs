/**
 * favicon.svg から PNG 版のアイコンを書き出す。
 *
 * ロゴを差し替えたとき（public/favicon.svg を上書きしたとき）に実行する。
 * ビルドには含まれない手動スクリプト。
 *
 *   cd site && node scripts/make-icons.mjs
 *
 * sharp は Astro の依存として既に入っているので、追加インストールは要らない。
 */
import sharp from 'sharp'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const source = join(publicDir, 'favicon.svg')

/** 出力するサイズ。増やしたらこの配列に足して BaseLayout.astro にも link を追加する。 */
const OUTPUTS = [
  { file: 'favicon-32.png', size: 32 },
  { file: 'apple-touch-icon.png', size: 180 },
]

const svg = readFileSync(source)

for (const { file, size } of OUTPUTS) {
  const out = join(publicDir, file)
  // density を上げないと SVG が小さくラスタライズされて輪郭がぼける
  await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(out)
  console.log(`${file}  ${size}x${size}  ${(statSync(out).size / 1024).toFixed(1)}KB`)
}

console.log('\npublic/og-default.png は画像編集ソフトで作る。手順は docs/APPEARANCE.md。')
