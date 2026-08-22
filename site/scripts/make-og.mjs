/**
 * ヘッダーバナーから OGP画像（SNS共有画像）を作る。
 *
 * バナーを差し替えたあとに実行する。ビルドには含まれない手動スクリプト。
 *
 *   cd site && node scripts/make-og.mjs
 *
 * なぜ変換が要るか:
 *   バナーは横長（現在 1200×463 / 2.59:1）だが、OGPの推奨は 1.91:1。
 *   そのまま出すと SNS 側で左右を切られてキャッチコピーが欠ける。
 *   そこで上下に「バナー自身を拡大してぼかしたもの」を継ぎ足して 1200×628 にする。
 *   単色で埋めると継ぎ目が帯として見えるので、ぼかし背景にしている。
 *
 * 出力サイズは site/src/config.ts の OG_IMAGE.width / height と一致させること。
 */
import sharp from 'sharp'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'assets', 'header-banner.png')
const out = join(root, 'public', 'og-default.jpg')

/** OGPの推奨寸法。変えるなら config.ts の OG_IMAGE も直す。 */
const W = 1200
const H = 628

const meta = await sharp(source).metadata()

if (meta.width !== W) {
  console.error(`バナーの幅が ${meta.width}px。このスクリプトは幅 ${W}px を前提にしている。`)
  console.error('バナーを 1200px 幅で書き出し直すか、このファイルの W を合わせること。')
  process.exit(1)
}

if (meta.height > H) {
  console.error(`バナーの高さが ${meta.height}px で、OGPの ${H}px を超えている。`)
  console.error('この場合は継ぎ足しではなく切り抜きが要るので、手で作ること。')
  process.exit(1)
}

const top = Math.round((H - meta.height) / 2)

const background = await sharp(source)
  .resize(W, H, { fit: 'cover' })
  .blur(28)
  .modulate({ brightness: 0.8 })
  .toBuffer()

await sharp(background)
  .composite([{ input: await sharp(source).png().toBuffer(), left: 0, top }])
  .jpeg({ quality: 86, mozjpeg: true })
  .toFile(out)

console.log(
  `public/og-default.jpg  ${W}x${H}  ${(statSync(out).size / 1024).toFixed(0)}KB` +
    `  (バナー ${meta.width}x${meta.height} の上下に ${top}px ずつ継ぎ足し)`,
)
