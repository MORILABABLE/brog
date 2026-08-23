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
 *   1. Amazon のリンクに tag= を付ける（検索URLでも効く）
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
import { isAffiliate, isExternal, relFor, withAmazonTag } from '../src/lib/affiliate.ts'

/** HAST のノード。必要な形だけを最小限で書く。 */
interface Node {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

export interface AffiliateOptions {
  /** Amazonアソシエイトのトラッキングid（例: mihoudai-22）。空なら tag= を付けない。 */
  amazonTag?: string
}

/**
 * `<a>` を1つ整える。
 *
 * rel はここで**上書きする**。記事側が独自に rel を書いていても、
 * 方針を1か所（src/lib/affiliate.ts）に寄せたいため。
 */
function fixAnchor(node: Node, amazonTag: string): void {
  const props = node.properties
  if (!props) return

  const href = props.href
  if (typeof href !== 'string' || !isExternal(href)) return

  const tagged = withAmazonTag(href, amazonTag)
  props.href = tagged

  const rel = relFor(tagged)
  if (rel) props.rel = rel
  props.target = '_blank'

  // アフィリエイトリンクは、目でも分かるように印を付けておく。
  // CSS から拾えるほか、公開後にHTMLを見て検証するときの手がかりになる。
  if (isAffiliate(tagged)) props['data-affiliate'] = 'true'
}

function walk(node: Node, amazonTag: string): void {
  if (node.type === 'element' && node.tagName === 'a') {
    fixAnchor(node, amazonTag)
  }
  if (node.children) {
    for (const child of node.children) walk(child, amazonTag)
  }
}

export function rehypeAffiliate(options: AffiliateOptions = {}) {
  const amazonTag = options.amazonTag ?? ''
  return (tree: Node): void => {
    walk(tree, amazonTag)
  }
}

export default rehypeAffiliate
