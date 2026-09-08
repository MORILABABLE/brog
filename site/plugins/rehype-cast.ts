/**
 * 「出演者」の箇条書きを、小さな注記の枠にたたむ rehype プラグイン。
 *
 * ■ 何を変換するか
 * 記事の Markdown は、表の直後にこう書く（`templates/writing.md` 6節）。
 *
 *     **出演者**
 *
 *     - 佐藤健（実写5作すべてに主演）
 *
 * 中身は**主演だけ**（`templates/writing.md` 6節）。共演者は表の「出演者」の列が
 * 1行ずつ受け持っているので、ここには出てこない。
 *
 * これは素のままだと `<p><strong>` ＋ `<ul>` になり、**本文と同じ大きさの
 * 箇条書きが縦に並ぶ**。表と解説のあいだに主張の強い塊ができて、
 * 読者は「読まされるもの」だと受け取ってしまう（2026-09-08・運用者の指摘）。
 *
 *     > 出演者の箇条書きですが、主張しすぎです。
 *     > 「出演者」フィールドは文章として読ませる必要はなくて、
 *     > 出来る限り文章量を少なく、領域も小さくて良いです。
 *
 * そこで `/guide` の注記（`.notice`）と同じ「囲って小さく沈める」形に寄せ、
 * **1〜2行に収まる横並び**へ組み替える。
 *
 *     ┌──────────────────────────────┐
 *     │ 出演者  佐藤健（実写5作すべてに主演） │
 *     └──────────────────────────────┘
 *
 * ■ なぜ記事側ではなくサイト側でやるのか
 * 記事は素材から機械的に作る。**Markdown に見せ方を書き込むと、
 * 見せ方を変えるたびに過去の記事を全部書き直すことになる。**
 * 在庫の行（rehype-availability.ts）と同じ分担で、
 * 記事は「何を」だけを書き、「どう見せるか」はここが持つ。
 *
 * ■ 実行順（astro.config.mjs）
 * **いちばん先**。他の3つは表の中しか触らないので依存は無いが、
 * 先に畳んでおけば後段が余計なノードを歩かない。
 *
 * ■ 落ちないこと
 * 目印（`<p>出演者</p>` ＋ 直後の `<ul>`）が見つからない記事では**何もしない**。
 * 出演者の欄が無い記事・節はそのまま通る。
 *
 * ■ ★ 手元では反映されない（落とし穴）
 * 記事の描画結果はキャッシュされる。このファイルを直しても
 * `.md` が変わらないかぎり再描画されない。
 * `npm run dev:fresh` / `npm run build:fresh` を使うこと
 * （plugins/rehype-availability.ts の冒頭に同じ注意書きがある）。
 */

/** HAST のノード。必要な形だけ（rehype-availability と同じ方針）。 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/** 目印にする見出し。**記事側はこの1語だけを書く。** */
const LABEL = '出演者'

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** 改行だけのテキストノード（要素と要素のあいだに必ず入る） */
function isBlank(node: Node): boolean {
  return node.type === 'text' && (node.value ?? '').trim() === ''
}

/** `<p><strong>出演者</strong></p>` か */
function isLabelParagraph(node: Node): boolean {
  return node.type === 'element' && node.tagName === 'p' && textOf(node).trim() === LABEL
}

function span(className: string, children: Node[]): Node {
  return { type: 'element', tagName: 'span', properties: { className: [className] }, children }
}

/**
 * `<ul>` の各項目を、横に並ぶ小片に組み替える。
 * 区切り（／）は CSS が入れる。**テキストとして入れない**
 * ——コピーされたときに記号だけが残らないようにするため。
 */
function foldList(list: Node): Node[] {
  return (list.children ?? [])
    .filter((li) => li.type === 'element' && li.tagName === 'li')
    .map((li) => span('cast-note-item', li.children ?? []))
}

function fold(node: Node): void {
  const children = node.children ?? []
  if (children.length === 0) return

  const out: Node[] = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!

    if (isLabelParagraph(child)) {
      // 目印の次にある要素（あいだの改行は読み飛ばす）が `<ul>` なら畳む
      let j = i + 1
      while (j < children.length && isBlank(children[j]!)) j++
      const list = children[j]
      if (list?.type === 'element' && list.tagName === 'ul') {
        const items = foldList(list)
        if (items.length > 0) {
          out.push({
            type: 'element',
            tagName: 'aside',
            properties: { className: ['cast-note'] },
            children: [
              span('cast-note-label', [{ type: 'text', value: LABEL }]),
              span('cast-note-items', items),
            ],
          })
          i = j // 目印と `<ul>`、そのあいだの改行をまとめて消費する
          continue
        }
      }
    }

    fold(child)
    out.push(child)
  }
  node.children = out
}

export function rehypeCast() {
  return (tree: Node): void => {
    try {
      fold(tree)
    } catch {
      // 形が想定と違っても記事は出す。**箇条書きのまま出るだけ。**
    }
  }
}

export default rehypeCast
