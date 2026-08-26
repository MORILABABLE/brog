/**
 * 記事本文の表にある作品名を、ビルド時にリンクとサムネイルへ差し替える rehype プラグイン。
 *
 * ■ なぜ記事にURLを書かせないのか
 * 記事はLLMが書く。表の1行ごとにURLを書かせると
 *   - 打ち間違い・省略が起きる（1本ずつ検査するのは現実的でない）
 *   - トラッキングIDや送り先の方針を変えるたびに**全記事の再生成**が要る
 *   - 素材のURLをそのまま書き写す作業に、生成コストと語数を食われる
 * 記事側は今までどおり**素の作品名だけ**を書き、ここで包む。
 * 既に公開した記事にも、再生成なしでそのまま効く。
 *
 * ■ 何を根拠に貼るか
 * `<td>`／`<th>` の**中身が丸ごと作品名と完全一致したときだけ**包む。
 * 地の文には触らない。部分一致もしない。
 *   - 日付・評価・サービス名のセルは作品名と一致しないので当たらない
 *   - 「日常」のような短い題名が地の文に紛れても、セルではないので当たらない
 * 送り先とサムネイルの決定は src/lib/work-links.ts が持つ。
 *
 * ■ 実行順（astro.config.mjs）
 *   rehypeWorkLinks → rehypeAffiliate の順に並べること。**逆にしない。**
 *   ここが作った `<a>` に、後段が tag= と rel="sponsored" を付ける。
 *   逆順にすると、表のリンクだけIDも rel も付かない状態で公開される。
 *
 * ■ 落ちないこと
 * 台帳が空（収集前）でも、サムネイルが無くても、何もしないだけで通す。
 *
 * ■ ★ 手元では Astro のキャッシュに古い結果が残る（落とし穴）
 * このプラグインが出す HTML は**記事の描画結果としてキャッシュされる**。
 * 記事の `.md` が変わらないかぎり、`data/events` を更新しても
 * **手元のビルドには反映されない**（リンク先もサムネイルも古いまま）。
 *
 *   cd site && rm -rf node_modules/.astro dist && npm run build
 *
 * Cloudflare のビルドは毎回まっさらなので、**公開されるものは常に最新**。
 * 手元で確認するときだけ気をつける。
 */
import { SERVICE_BY_LABEL, workLinkByTitle } from '../src/lib/work-links.ts'

/** HAST のノード。必要な形だけを最小限で書く（rehype-affiliate と同じ方針）。 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/**
 * サムネイルの表示寸法。**px で属性に焼き込む。**
 * width/height を書かないと、画像が届くまで行の高さが決まらず、
 * 表全体がガタつく（Cumulative Layout Shift）。
 * ★ 変えたら styles/global.css の `.work-thumb` と
 *   scripts/make-thumbs.mjs の THUMB も揃えること。
 */
const THUMB = { w: 48, h: 72 }

/** ノード配下のテキストをすべて連結する。`<strong>` などが挟まっても拾える。 */
function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/**
 * セルの中身を、サムネイル＋作品名のリンク1つに置き換える。
 *
 * @param service その行が扱っているサービスキー（分かっていれば）
 */
function linkify(cell: Node, service: string | undefined): boolean {
  const title = textOf(cell).trim()
  // サービス名と同名の作品が来た場合の保険。実データでは0件だが、
  // 当たると**行がまったく別の場所へ飛ぶ**ので先に弾く。
  if (!title || SERVICE_BY_LABEL.has(title)) return false

  const work = workLinkByTitle(title, service)
  if (!work) return false

  const children: Node[] = []
  if (work.thumb) {
    children.push({
      type: 'element',
      tagName: 'img',
      properties: {
        // 作品名がすぐ隣に文字で出るので、画像は装飾扱いにする。
        // alt に題名を入れると、読み上げで同じ名前が2回出る。
        alt: '',
        src: work.thumb,
        className: ['work-thumb'],
        width: THUMB.w,
        height: THUMB.h,
        loading: 'lazy',
        decoding: 'async',
      },
      children: [],
    })
  }
  children.push({
    type: 'element',
    tagName: 'span',
    properties: { className: ['work-name'] },
    children: [{ type: 'text', value: title }],
  })

  cell.children = [
    {
      type: 'element',
      tagName: 'a',
      properties: { href: work.url, className: ['work-link'] },
      children,
    },
  ]
  return true
}

/**
 * 1行ぶん。
 *
 * ★ セルを1つずつ見る前に、**その行のサービス列を先に読む。**
 *   記事の表は「日付 / 作品 / 評価 / サービス」の4列で固定されているが、
 *   列の位置ではなく中身で判定している（列を入れ替えても壊れないように）。
 *   サービスが分かると、同じ作品が複数サービスに出る場合でも
 *   その行の主題と同じサービスの作品ページへ送れる。
 */
function handleRow(row: Node, count: { n: number }): void {
  const cells = (row.children ?? []).filter((c) => c.tagName === 'td' || c.tagName === 'th')

  let service: string | undefined
  for (const cell of cells) {
    const hit = SERVICE_BY_LABEL.get(textOf(cell).trim())
    if (hit) {
      service = hit
      break
    }
  }

  for (const cell of cells) {
    if (linkify(cell, service)) count.n++
  }
}

function walk(node: Node, inTable: boolean, count: { n: number }): void {
  const here = inTable || node.tagName === 'table'

  if (here && node.tagName === 'tr') {
    handleRow(node, count)
    return // 行の中はもう見ない
  }

  for (const child of node.children ?? []) walk(child, here, count)
}

export function rehypeWorkLinks() {
  return (tree: Node): void => {
    const count = { n: 0 }
    walk(tree, false, count)
  }
}

export default rehypeWorkLinks
