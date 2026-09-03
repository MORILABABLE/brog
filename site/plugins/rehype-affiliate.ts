/**
 * 記事本文（Markdown）の外部リンクを、ビルド時に整える rehype プラグイン。
 *
 * ■ なぜ本文を書き換えるのか
 * 記事はパイプラインが自動生成する。リンクURLはテーマパックの
 * theme.yaml から来るので、そこにトラッキングIDを焼き込むこともできる。
 * だが**焼き込むと、IDを変えるたびに全記事の再生成が必要**になる。
 * ID は build 時に外から差し込み、記事本文はIDを知らないままにしておく。
 *
 * ■ ここでやること
 *   1. Amazon のリンクに tag= を付ける（検索URLでも効く）。
 *      **どの枠から出たリンクかで、付けるIDを変える**（2026-09-03）。
 *      判定は下の slotOf()。
 *   2. アフィリエイト対象に rel="sponsored noopener" を付ける
 *      → Google はアフィリエイトリンクに sponsored を要求する。必須。
 *   3. それ以外の外部リンクに rel="noopener noreferrer" を付ける
 *   4. 外部リンクを target="_blank" にする
 *
 * ■ Astro 7 での注意
 * `markdown.rehypePlugins` は Astro 7 時点で **@deprecated**。
 * 動作はするが、将来のメジャーで削除される予定。
 * 移行先は `markdown.processor` に `@astrojs/markdown-remark` の
 * `unified({ rehypePlugins })` を渡す形。
 * Astro を上げてビルドが落ちたらここを疑うこと（docs/AFFILIATE.md）。
 */
import {
  isAffiliate,
  isExternal,
  relFor,
  tagFor,
  withAmazonTag,
  type AmazonSlot,
  type AmazonTags,
} from '../src/lib/affiliate.ts'

/** HAST のノード。必要な形だけを最小限で書く。 */
interface Node {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

export interface AffiliateOptions {
  /**
   * 枠別のAmazonトラッキングid。`default` が空なら tag= を付けない。
   * 組み立てているのは astro.config.mjs（loadEnv）。
   */
  tags?: AmazonTags
}

/**
 * この `<a>` はどの枠から出たものか。**トラッキングIDを分けるための判定。**
 *
 * 記事本文から出る Amazon リンクは3種類しかない。
 * どちらも**この関数が見ている手がかりを別の箇所が作っている**ので、
 * 向こうを変えるときはここも直すこと。
 *
 *   table  … `class="work-link"`。付けているのは plugins/rehype-work-links.ts
 *   poster … 中身が `/sections/…` の画像1枚。作っているのは scripts/posters.mjs の posterLink()
 *   body   … 上のどちらでもない、地の文のリンク
 *
 * ★ 判定を間違えても**リンクは壊れない**（別の枠のIDが付くだけ）。
 *   ただしレポートが混ざって分離の意味が消えるので、
 *   目印のクラス名や画像の置き場を変えたら必ずここを追うこと。
 */
function slotOf(node: Node): AmazonSlot {
  const cls = node.properties?.className
  if (Array.isArray(cls) && cls.includes('work-link')) return 'table'

  for (const child of node.children ?? []) {
    if (child.tagName !== 'img') continue
    const src = child.properties?.src
    if (typeof src === 'string' && src.startsWith('/sections/')) return 'poster'
  }
  return 'body'
}

/**
 * `<a>` を1つ整える。
 *
 * rel はここで**上書きする**。記事側が独自に rel を書いていても、
 * 方針を1か所（src/lib/affiliate.ts）に寄せたいため。
 */
function fixAnchor(node: Node, tags: AmazonTags): void {
  const props = node.properties
  if (!props) return

  const href = props.href
  if (typeof href !== 'string' || !isExternal(href)) return

  // 枠の判定はAmazon以外のリンクでも走るが、withAmazonTag が
  // Amazon以外を素通しするので、実際にIDが乗るのはAmazonのリンクだけ。
  const tagged = withAmazonTag(href, tagFor(tags, slotOf(node)))
  props.href = tagged

  const rel = relFor(tagged)
  if (rel) props.rel = rel
  props.target = '_blank'

  // アフィリエイトリンクは、目でも分かるように印を付けておく。
  // CSS から拾えるほか、公開後にHTMLを見て検証するときの手がかりになる。
  if (isAffiliate(tagged)) props['data-affiliate'] = 'true'
}

function walk(node: Node, tags: AmazonTags): void {
  if (node.type === 'element' && node.tagName === 'a') {
    fixAnchor(node, tags)
  }
  if (node.children) {
    for (const child of node.children) walk(child, tags)
  }
}

export function rehypeAffiliate(options: AffiliateOptions = {}) {
  const tags = options.tags ?? { default: '' }
  return (tree: Node): void => {
    walk(tree, tags)
  }
}

export default rehypeAffiliate
