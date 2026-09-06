/**
 * 記事の表に「では、どこで観られるか」の行を足す rehype プラグイン。
 *
 * ■ なぜ表なのか（文章ではなく）
 * 読者の問いは「いつ終わるか」ではなく**「では、どこで観るのか」**。
 * 文章で答えても届かない — **実測でスクロール90%到達は22%**（docs/FUNNEL.md 5-3）。
 * 表は本文の最初の1画面に入るので、**そこに答えを置く**。
 *
 * ■ なぜ「列」ではなく「行」なのか（**一度列で作って、作り直した**）
 * サービスごとの列（Netflix ○ / Prime Video ○ …）を先に実装したが、
 * **スマホで収まらなかった。** 375px 幅の実測（playwright）で
 *
 *     表の内容 407px / 表示できる幅 336px  → 右端の列が画面外
 *
 * となり、**横スクロールしないと見えない ＝ 表に入れた意味が消える**。
 * 行にすれば幅を食わない。しかも**サービス名をそのまま書ける**ので、
 * 記号だけの列と違って凡例を読まなくても意味が通じる。
 *
 *     | 終了日  | 作品                      | 評価   |
 *     | 9月30日 | ハリー・ポッターと賢者の石 | 77/100 |
 *     |   Netflix ○　Amazon Prime Video ○　Apple TV+ △   |  ← 足す行
 *
 * ■ 何を根拠にするか
 * `data/availability.json`（`npm run availability` が書く在庫）。
 * **変化ログ（`/changes`）ではない。** 根拠が違うので台帳も別
 * （`pipeline/core/availability.ts` の冒頭）。
 *
 * ■ 実行順（astro.config.mjs）
 *   rehypeWorkLinks → **rehypeAvailability** → rehypeAffiliate
 *   - 前段が作品名を `<a>` にしたあとに読む（題名は `textOf` でそのまま取れる）
 *   - 後段が、ここで作った `<a>` に tag= と rel="sponsored" を付ける
 *   **どちらを逆にしても静かに壊れる。**
 *
 * ■ 絶対に守ること
 *   - **その行が扱っているサービスは出さない。**
 *     「Netflixで9月30日に終了」の行に「Netflix ●」を出すと、
 *     終わるのか観られるのか読者に判別できない（2026-09-06・運用者の指摘）
 *   - **残りのサービスは ● △ × を揃えて全部出す。**
 *     ×を省くと「調べたうえで無い」と「調べていない」の区別が付かない
 *   - **U-NEXT / Hulu / DMM TV を出さない。** 在庫データを持っていない
 *     （docs/CROSS-SERVICE.md 9-3）。`SERVICES` に入れないことで担保している
 *   - **並びを紹介料の高い順にしない**（docs/AFFILIATE.md 7節。ポリシーにも明記）
 *
 * ■ 落ちないこと
 * 台帳が空でも、作品が引けなくても、**何もしないで通す**。
 * 在庫を取っていない記事は今までどおりの表で出る。
 *
 * ■ ★ 手元では反映されない（落とし穴）
 * **記事の描画結果がキャッシュされる。** `.md` が変わらないかぎり
 * 再描画されないので、**このファイルを直しても、`data/availability.json` を
 * 更新しても、手元の `npm run dev` / `npm run build` には出ない。**
 *
 *   cd site && npm run dev:fresh      （= キャッシュを消してから dev）
 *   cd site && npm run build:fresh
 *
 * 2026-09-06 に実際に踏んだ。**新しく起動した dev だけが古い表を出し、
 * 前日から動いていた dev のほうが正しい表を出す**、という形で現れた
 * （動いている dev は HMR で作り直されるが、起動時はキャッシュを読むため）。
 * plugins/rehype-work-links.ts の冒頭にも同じ注意書きがある。
 *
 * Cloudflare のビルドは毎回まっさらなので、**公開されるものは常に最新**。
 */
import { workLinkByTitle, SERVICE_BY_LABEL } from '../src/lib/work-links.ts'
import {
  marksFor,
  MARK_SYMBOL,
  MARK_LABEL,
  type Mark,
  type WorkMarks,
} from '../src/lib/availability.ts'

/** HAST のノード。必要な形だけ（rehype-work-links と同じ方針）。 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/**
 * 行に出してよいサービスと表示名。**在庫データを持つ4社だけ。**
 * 並びはテーマの定義順で固定（紹介料で並べ替えない）。
 */
const SERVICES: { key: string; label: string }[] = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'disney-plus', label: 'Disney+' },
  { key: 'apple-tv', label: 'Apple TV+' },
]

const text = (v: string): Node => ({ type: 'text', value: v })

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function cellsOf(row: Node): Node[] {
  return (row.children ?? []).filter((c) => c.tagName === 'td' || c.tagName === 'th')
}

/**
 * その行の作品IDと、**その行が扱っているサービス**。
 *
 * ★ サービスも返すのは、**その行の主題のサービスを行から外す**ため。
 *   「Netflixで9月30日に終了」の行に「Netflix ●」と出すと、
 *   終わるのか観られるのか分からない。読者が知りたいのは**残りの3社**。
 */
function workOf(row: Node): { id: string; service?: string } | undefined {
  let service: string | undefined
  for (const cell of cellsOf(row)) {
    const hit = SERVICE_BY_LABEL.get(textOf(cell).trim())
    if (hit) {
      service = hit
      break
    }
  }
  for (const cell of cellsOf(row)) {
    const title = textOf(cell).trim()
    if (!title || SERVICE_BY_LABEL.has(title)) continue
    const work = workLinkByTitle(title, service)
    if (work) return { id: work.workId, service }
  }
  return undefined
}

/** 見出し名で列を探して落とす（中身は見ない）。 */
function dropColumn(headRow: Node, bodyRows: Node[], head: string): void {
  const idx = cellsOf(headRow).findIndex((c) => textOf(c).trim() === head)
  if (idx < 0) return
  for (const row of [headRow, ...bodyRows]) {
    const cell = cellsOf(row)[idx]
    if (cell) row.children = (row.children ?? []).filter((c) => c !== cell)
  }
}

/**
 * 見出し名で列を探し、**全行の中身が同じなら列ごと落とす。**
 * 1行でも違えば何もしない。
 */
function dropConstantColumn(headRow: Node, bodyRows: Node[], head: string): void {
  const idx = cellsOf(headRow).findIndex((c) => textOf(c).trim() === head)
  if (idx < 0 || bodyRows.length < 2) return
  const values = bodyRows.map((r) => {
    const cell = cellsOf(r)[idx]
    return cell ? textOf(cell).trim() : ''
  })
  if (values.some((v) => !v || v !== values[0])) return
  dropColumn(headRow, bodyRows, head)
}

/**
 * 1作品ぶんの「どこで観られるか」の行。**元の行の直下に足す。**
 *
 * ★ `colspan` は列を落としたあとの列数に合わせること。ずれると行が崩れる。
 * ★ **観られる先だけを出す。** ×（取り扱いなし）は並べない。
 */
function availRow(marks: WorkMarks, colspan: number, own: string | undefined): Node {
  /*
   * 先頭のラベル。**この行が何なのかを1語で言う。**
   * 記号だけの行が表に紛れると、読者は何の行か分からないまま飛ばす。
   *
   * ★ **「配信中」と書いてよい面。** `works.ts` 冒頭の
   *   「配信中と書かない」は**変化ログ（/changes）を根拠にするな**という意味で、
   *   この行は**在庫レスポンス**を根拠にしている（docs/CROSS-SERVICE.md 4-2）。
   *   根拠が違うので射程外。**ただし取得時点を凡例に必ず出すこと**が条件。
   */
  const items: Node[] = [
    {
      type: 'element',
      tagName: 'span',
      properties: { className: ['avail-label'] },
      children: [text('配信中')],
    },
  ]

  /*
   * 並び順。**○（見放題）→ △（レンタル・購入）→ ×（取り扱いなし）**。
   * 読者が最初に見たいのは「いま見放題で観られる先」なので、そこを先頭に置く。
   *
   * ★ **同じ印どうしの順は SERVICES の定義順のまま**（機械的な順）。
   *   ここを崩して「収益になる順」に並べ替えないこと。
   *   docs/AFFILIATE.md 7節で「紹介料の高いサービスを優先して掲載しない」と決め、
   *   プライバシーポリシーにも明記してある。
   *   **印での並べ替えは読者の行動で決まる順**なので、その方針には反しない。
   */
  const RANK: Record<Mark, number> = { subscription: 0, paid: 1, none: 2, unknown: 3 }
  const shown = SERVICES
    /*
     * ★ **その行のサービスは出さない。**
     *   「Netflixで9月30日に終了」の行に「Netflix ○」を出すと、
     *   終わるのか観られるのか読者に判別できない。
     *   出すのは**行き先になりうる残りのサービス**だけ。
     */
    .filter((svc) => !(own && svc.key === own))
    .map((svc, i) => ({ svc, i, mark: (marks.marks.get(svc.key) ?? 'none') as Mark }))
    .sort((a, b) => RANK[a.mark] - RANK[b.mark] || a.i - b.i)

  for (const { svc, mark } of shown) {
    // ★ ×（取り扱いなし）も出す。**4社ぶんを揃えて見せる**ことで、
    //   「調べたうえで無い」と「調べていない」の区別が読者に付く。
    const url = mark === 'subscription' || mark === 'paid' ? marks.links.get(svc.key) : undefined
    const inner: Node[] = [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['avail-mark'], 'aria-hidden': 'true' },
        children: [text(MARK_SYMBOL[mark])],
      },
      text(svc.label),
    ]
    items.push({
      type: 'element',
      tagName: 'span',
      properties: {
        className: ['avail-item'],
        'data-mark': mark,
        // 記号だけでは意味が乗らない。読み上げにも hover にも言葉を出す
        title: `${svc.label}（${MARK_LABEL[mark]}）`,
      },
      children: [
        url
          ? {
              type: 'element',
              tagName: 'a',
              properties: { href: url, className: ['avail-link'] },
              children: inner,
            }
          : { type: 'element', tagName: 'span', properties: {}, children: inner },
      ],
    })
  }

  /*
   * ★ **チップを1枚の箱で包む。**
   *   `colspan` のセルは**表のスクロール幅いっぱい**に広がるので、
   *   直接並べるとチップが右へ伸びて画面外に出る（スマホで実際に切れた）。
   *   包んだ箱を `position: sticky; left: 0` で左端に留め、
   *   **見えている幅の中で折り返させる**（styles/global.css）。
   */
  return {
    type: 'element',
    tagName: 'tr',
    properties: { className: ['avail-row'] },
    children: [
      {
        type: 'element',
        tagName: 'td',
        properties: { className: ['avail-cell'], colSpan: colspan },
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: { className: ['avail-inner'] },
            children: items,
          },
        ],
      },
    ],
  }
}

/**
 * 表の直後に置く凡例。
 *
 * ★ **取得日を持たせる。** 表だけ見て離れる読者がいる以上、
 *   「いつ時点か」を本文に書かせて済ませない。
 * ★ **△（レンタル・購入）は説明する。** しないと見放題と読まれる。
 */
function legendNode(asOf: Date | undefined): Node {
  const stamp = asOf ? `${asOf.getMonth() + 1}月${asOf.getDate()}日時点・` : ''
  return {
    type: 'element',
    tagName: 'p',
    properties: { className: ['avail-legend'] },
    children: [
      text(
        `${MARK_SYMBOL.subscription} 見放題　${MARK_SYMBOL.paid} レンタル・購入　` +
          `${MARK_SYMBOL.none} 取り扱いなし` +
          `（${stamp}4サービス分。各社の都合で変わります）`,
      ),
    ],
  }
}

/** 表 → その直後に入れる凡例。差し込むのは `walk` の親側。 */
const pendingLegends = new Map<Node, Node>()

/** そのノードを子に持つ親を探す。`<tbody>` があってもなくても動く。 */
function findParent(root: Node, target: Node): Node | undefined {
  for (const child of root.children ?? []) {
    if (child === target) return root
    const hit = findParent(child, target)
    if (hit) return hit
  }
  return undefined
}

function rewriteTable(table: Node, count: { tables: number; rows: number }): boolean {
  const rows: Node[] = []
  const collect = (n: Node): void => {
    if (n.tagName === 'tr') rows.push(n)
    for (const c of n.children ?? []) collect(c)
  }
  collect(table)
  if (rows.length < 2) return false

  const headRow = rows[0]!
  const bodyRows = rows.slice(1)

  const found = new Map<Node, { marks: WorkMarks; own?: string }>()
  let oldest: Date | undefined
  for (const row of bodyRows) {
    const w = workOf(row)
    if (!w) continue
    const m = marksFor(w.id)
    if (!m) continue
    found.set(row, { marks: m, own: w.service })
    if (!oldest || m.fetchedAt < oldest) oldest = m.fetchedAt
  }
  if (found.size === 0) return false

  /*
   * ★ **元の列は1つも落とさない**（2026-09-06・運用者の判断）。
   *   「サービス」列も「状態」列もそのまま残す。表が横に伸びて
   *   スクロールが要るのは構わない、という判断。
   *   足す行は colspan で全幅を使うので、**スクロールしなくても読める。**
   *
   *   ★ 幅のために列を落とす実装を一度入れて、外した。
   *     戻すときは `dropColumn` / `dropConstantColumn` を呼ぶだけでよい
   *     （関数は残してある）。
   */
  const colspan = cellsOf(headRow).length

  for (const [row, hit] of found) {
    const parent = findParent(table, row)
    if (!parent?.children) continue
    const idx = parent.children.indexOf(row)
    if (idx < 0) continue
    parent.children.splice(idx + 1, 0, availRow(hit.marks, colspan, hit.own))
    // 元の行に印。CSSで下の罫線を消して2行を1組に見せる
    const props = (row.properties ??= {})
    const prev = Array.isArray(props.className) ? (props.className as string[]) : []
    props.className = [...prev, 'has-avail']
    count.rows++
  }

  count.tables++
  pendingLegends.set(table, legendNode(oldest))
  return true
}

function walk(node: Node, count: { tables: number; rows: number }): void {
  const children = node.children ?? []
  if (children.length === 0) return
  const out: Node[] = []
  for (const child of children) {
    if (child.type === 'element' && child.tagName === 'table') {
      rewriteTable(child, count)
      out.push(child)
      /*
       * ★ 凡例は**表の兄弟**として入れる。表の中に入れると
       *   `<table>` の直下に `<p>` が来て、HTMLとして不正になる。
       */
      const legend = pendingLegends.get(child)
      if (legend) {
        out.push(legend)
        pendingLegends.delete(child)
      }
      continue
    }
    walk(child, count)
    out.push(child)
  }
  node.children = out
}

export function rehypeAvailability() {
  return (tree: Node): void => {
    try {
      walk(tree, { tables: 0, rows: 0 })
    } catch {
      // 表の形が想定と違っても記事は出す。**行が足りないだけ。**
    }
  }
}
