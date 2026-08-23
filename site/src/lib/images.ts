/**
 * ページごとの画像の解決を1か所に集める。
 *
 * ■ 2種類あり、出どころが違う
 *   常設ページ … `src/assets/services/<キー>.png`（人が置く指定画像）
 *                 astro:assets で最適化・WebP変換される
 *   個別記事   … frontmatter の `heroImage`（`public/` からの絶対パス）
 *                 パイプラインが後から入れる想定なので、ビルド時に import できない。
 *                 素の <img> で出す
 *
 * ■ どちらも「無くてよい」
 * 画像が無いときはカテゴリ色のタイルになる。レイアウトは崩れない。
 * 追従枠のサムネイルと同じ考え方（src/assets/services/README.md）。
 *
 * ★ 生成物の `/cards/<スラッグ>.jpg` はここでは使わない。
 *   記事タイトルを焼き込んだSNS共有用の画像なので、
 *   見出しの上に置くとタイトルが二重に出るし、正方形に切ると文字が切れる。
 */
import type { ImageMetadata } from 'astro'

const serviceThumbs = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/services/*.{png,jpg,jpeg,webp}',
  { eager: true },
)

/** `src/assets/services/<キー>.*` を探す。無ければ undefined。 */
export function serviceImage(key: string): ImageMetadata | undefined {
  const hit = Object.entries(serviceThumbs).find(([path]) =>
    path.match(new RegExp(`/${key}\\.(png|jpg|jpeg|webp)$`)),
  )
  return hit?.[1].default
}
