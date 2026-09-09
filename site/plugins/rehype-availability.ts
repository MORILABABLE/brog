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
 *   - **残りのサービスは ○ △ × を揃えて全部出す。**
 *     ×を省くと「調べたうえで無い」と「調べていない」の区別が付かない
 *   - **台帳に無い作品は — （未確認）。× にしない。**
 *     行そのものを出さないと、読者には「表示されていない」としか見えない
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
import { workLinkByTitle, workIdsForTitle, SERVICE_BY_LABEL } from '../src/lib/work-links.ts'
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
function workOf(row: Node): { ids: string[]; service?: string } | undefined {
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
    if (!work) continue
    /*
     * ★ **IDを1つに決めない。**
     *   同じ映画が配信元ごとに別のIDで台帳に入っている（`workIdsForTitle` の説明）。
     *   U-NEXT の題で引くと SID… が返り、在庫台帳には無いので**印が出ない。**
     *   読者からは「調べたうえで取り扱いなし（×）」と区別が付かず、不具合に見える。
     */
    const ids = workIdsForTitle(title)
    return { ids: ids.includes(work.workId) ? ids : [work.workId, ...ids], service }
  }
  return undefined
}

/**
 * 候補のIDから在庫の印を1つ選ぶ。
 *
 * ★ **当たりが割れたら出さない。** 表記ゆれを潰した突き合わせ（`workIdsForTitle`）は
 *   別作品を巻き込みうる。**違う印が返ってきたということは、当てた相手が違う**
 *   ということなので、どちらかを選ばずに黙る（行が出ないだけ）。
 *   嘘の印を出すより、印が無いほうがましという判断。
 */
function marksOf(ids: string[]): WorkMarks | undefined {
  let chosen: WorkMarks | undefined
  let signature = ''
  for (const id of ids) {
    const m = marksFor(id)
    if (!m) continue
    const sig = [...m.marks].sort().map(([k, v]) => `${k}:${v}`).join(',')
    if (!chosen) {
      chosen = m
      signature = sig
    } else if (sig !== signature) {
      return undefined
    }
  }
  return chosen
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
 * 行の頭のラベル（「配信中」）の状態。**その行に並ぶ印だけで機械的に決まる。**
 *
 *     live     ○ が1つでもある     いま見放題で観られる先がある
 *     paid     ○ が無く △ がある   金を払えば観られる（見放題は無い）
 *     none     × だけ              この4社では取り扱いが無い
 *     unknown  印が無い（—）        調べていない
 *
 * ★ **色は言い換えでしかない。** 状態はラベルの文字（`LABEL_TEXT`）と
 *   同じ行に並ぶ ○ △ × が言っているので、色が届かない読者
 *   （色覚特性・印刷・モノクロ）でも意味は1つも落ちない。
 *   これは global.css の「色だけに意味を持たせないこと」の決まりそのもの。
 * ★ **判定をここ以外に置かないこと。** 記事は作成も書き直しも同じ
 *   ビルド（この rehype プラグイン）を通るので、ここ1か所で全記事に効く。
 */
type LabelState = 'live' | 'paid' | 'none' | 'unknown'

function labelStateOf(marks: Mark[]): LabelState {
  if (marks.includes('subscription')) return 'live'
  if (marks.includes('paid')) return 'paid'
  if (marks.length > 0 && marks.every((m) => m === 'none')) return 'none'
  return 'unknown'
}

/** 状態ごとの補足。**色は読み上げに乗らない**ので、言葉でも渡す。 */
const LABEL_TITLE: Record<LabelState, string> = {
  live: '見放題で観られるサービスがあります',
  paid: 'レンタル・購入なら観られます（見放題はありません）',
  none: 'この4サービスでは取り扱いがありません',
  unknown: '配信状況を取得できていません',
}

/**
 * ラベルの文字。**状態ごとに変える**（2026-09-09・運用者の判断）。
 *
 * ★ **全部を「配信中」にしてはいけない。** 一度そうしていて、
 *   ×だけの行が**「赤い枠の『配信中』」**になった。色は正しくても、
 *   **文字だけ読むと逆の意味に取れる。**
 *   色は補助（下の `labelStateOf` の注意書き）なので、
 *   **文字のほうが単体で正しくないといけない。**
 *
 * ★ 「配信中」と書けるのは**在庫レスポンスを根拠にしている面だけ**
 *   （下の `availLabel` の説明）。ここを他の記事へ広げないこと。
 */
const LABEL_TEXT: Record<LabelState, string> = {
  live: '配信中',
  paid: '有料で配信中',
  none: '取り扱いなし',
  /*
   * ★ 「未確認」にしない。**右隣のチップが既に「— 未確認」**なので、
   *   同じ言葉が2つ並ぶ。ここは**その行が何の行か**を言うだけにする。
   */
  unknown: '配信状況',
}

/**
 * 行の頭のラベル。**この行が何なのかを1語で言う。**
 * 記号だけの行が表に紛れると、読者は何の行か分からないまま飛ばす。
 *
 * ★ **「配信中」と書いてよい面。** `works.ts` 冒頭の
 *   「配信中と書かない」は**変化ログ（/changes）を根拠にするな**という意味で、
 *   この行は**在庫レスポンス**を根拠にしている（docs/CROSS-SERVICE.md 4-2）。
 *   根拠が違うので射程外。**ただし取得時点を凡例に必ず出すこと**が条件。
 *
 * ★ **枠と色は CSS が `data-state` を見て付ける**（global.css `.avail-label`）。
 *   ここは状態を宣言するだけで、色の値は持たない。
 *   色を足す・変えるときは global.css 側だけを直すこと。
 */
function availLabel(state: LabelState): Node {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['avail-label'],
      'data-state': state,
      title: LABEL_TITLE[state],
    },
    /*
     * ★ **箱は内側の `span` が描く。** 外側は並びのための入れ物。
     *   スマホでは外側だけが1行を占める（global.css のメディアクエリ）ので、
     *   1枚にすると**画面幅いっぱいの色帯**になってしまう。
     */
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['avail-label-box'] },
        children: [text(LABEL_TEXT[state])],
      },
    ],
  }
}

/**
 * 1作品ぶんの「どこで観られるか」の行。**元の行の直下に足す。**
 *
 * ★ `colspan` は列を落としたあとの列数に合わせること。ずれると行が崩れる。
 * ★ **観られる先だけを出す。** ×（取り扱いなし）は並べない。
 */
function availRow(marks: WorkMarks | undefined, colspan: number, own: string | undefined): Node {
  /*
   * ★ **台帳に無い作品は、印を4つ並べずに「— 未確認」1つで済ませる。**
   *
   *   ここで `— Netflix　— Amazon Prime Video　…` と4つ並べても、
   *   **読者が得るものが1つも無い**（どこも「分からない」としか言っていない）。
   *   長い行が並ぶぶん、印のある行のほうが読みにくくなる。
   *
   *   それでも**行そのものは出す。** 行が無いと、読者には
   *   「この作品だけサービス先が表示されていない」＝不具合に見える
   *   （2026-09-06・運用者の指摘）。**分からないことを、分かると同じ形で言う。**
   *
   *   ★ **× にしない。** × は「調べたうえで取り扱いなし」で意味が違う
   *     （src/lib/availability.ts の「絶対に守ること」2）。
   */
  if (!marks) {
    const items: Node[] = [availLabel('unknown')]
    items.push({
      type: 'element',
      tagName: 'span',
      properties: {
        className: ['avail-item'],
        'data-mark': 'unknown',
        title: '配信状況を取得できていない作品です',
      },
      children: [
        {
          type: 'element',
          tagName: 'span',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['avail-mark'], 'aria-hidden': 'true' },
              children: [text(MARK_SYMBOL.unknown)],
            },
            text('未確認'),
          ],
        },
      ],
    })
    return availCell(items, colspan)
  }

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

  /*
   * ★ ラベルの色は**その行に実際に並ぶ印**から決める（`shown`）。
   *   その行のサービスを外したあとの並びなので、**読者が見ているものと一致する**。
   *   台帳の全サービスから決めると、外した1社のせいで色と印が食い違う
   *   （「Netflixで終了」の行が、その Netflix の ○ を根拠に青くなる）。
   */
  const items: Node[] = [availLabel(labelStateOf(shown.map((s) => s.mark)))]

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

  return availCell(items, colspan)
}

/**
 * 中身を `<tr>` にする。
 *
 * ★ **チップを1枚の箱で包む。**
 *   `colspan` のセルは**表のスクロール幅いっぱい**に広がるので、
 *   直接並べるとチップが右へ伸びて画面外に出る（スマホで実際に切れた）。
 *   包んだ箱を `position: sticky; left: 0` で左端に留め、
 *   **見えている幅の中で折り返させる**（styles/global.css）。
 */
function availCell(items: Node[], colspan: number): Node {
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
function legendNode(asOf: Date | undefined, hasUnknown: boolean): Node {
  const stamp = asOf ? `${asOf.getMonth() + 1}月${asOf.getDate()}日時点・` : ''
  // ★ — が1つも出ていないなら凡例にも出さない。読まなくていいものを増やさない
  const unknown = hasUnknown ? `　${MARK_SYMBOL.unknown} 未確認` : ''
  return {
    type: 'element',
    tagName: 'p',
    properties: { className: ['avail-legend'] },
    children: [
      text(
        `${MARK_SYMBOL.subscription} 見放題　${MARK_SYMBOL.paid} レンタル・購入　` +
          `${MARK_SYMBOL.none} 取り扱いなし${unknown}` +
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

/** 1つの表について「どの行に何を足すか」を決めた結果。**まだ書き換えない。** */
interface TablePlan {
  table: Node
  /** 元の行 → 足す内容。`marks` が無い行は「未確認（—）」になる */
  found: Map<Node, { marks?: WorkMarks; own?: string }>
  /** そのうち台帳から印を引けた行の数 */
  resolved: number
  /** 引けた在庫のうち、いちばん古い取得日（凡例に出す） */
  oldest?: Date
}

/**
 * 表を1つ読んで、足す行を決める。**書き換えはしない**（`applyPlan` が行う）。
 *
 * ★ **決めるのと書くのを分けてあるのは、記事全体を見てから決めるため。**
 *   1つの表だけを見て「1件も引けないから何もしない」と決めると、
 *   同じ記事の中に**印のある表と無い表**が並ぶ（2026-09-06 にウルトラマンで踏んだ。
 *   Prime Video の表には印が出て、U-NEXT の表には1つも出なかった）。
 *   読者から見れば同じ記事の同じ形の表なので、**そこだけ壊れて見える。**
 */
function planTable(table: Node): TablePlan | undefined {
  const rows: Node[] = []
  const collect = (n: Node): void => {
    if (n.tagName === 'tr') rows.push(n)
    for (const c of n.children ?? []) collect(c)
  }
  collect(table)
  if (rows.length < 2) return undefined

  /*
   * ★ **作品として引けた行には、必ず行を足す**（2026-09-06・運用者の指摘）。
   *
   *   途中の行だけ抜けていると、読者には
   *   **「この作品はサービス先が表示されていない」＝不具合**に見える。
   *   在庫が無い作品は × を並べ、**在庫を調べられていない作品は — を並べる。**
   *   画面の上で「調べたうえで無い」と「調べていない」が分かれる。
   *
   *   取りこぼしは `npm run availability -- --ids <作品ID>` で埋める。
   *   **書き直しの表は前の版の行を落とさない**ので、素材から外れた作品が残る
   *   （そこが — になる。pipeline/cli/availability.ts の `--ids` の説明）。
   */
  const found = new Map<Node, { marks?: WorkMarks; own?: string }>()
  let oldest: Date | undefined
  let resolved = 0
  for (const row of rows.slice(1)) {
    const w = workOf(row)
    if (!w) continue
    const m = marksOf(w.ids)
    found.set(row, { marks: m, own: w.service })
    if (!m) continue
    resolved++
    if (!oldest || m.fetchedAt < oldest) oldest = m.fetchedAt
  }
  if (found.size === 0) return undefined
  return { table, found, resolved, oldest }
}

/** 決めたとおりに行を差し込む。 */
function applyPlan(plan: TablePlan, count: { tables: number; rows: number }): void {
  const { table, found } = plan
  const headRow: Node | undefined = (() => {
    const rows: Node[] = []
    const collect = (n: Node): void => {
      if (n.tagName === 'tr') rows.push(n)
      for (const c of n.children ?? []) collect(c)
    }
    collect(table)
    return rows[0]
  })()
  if (!headRow) return

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
  /*
   * ★ **1件も引けなかった表には凡例を出さない。**
   *   ○ も △ も × も出ていない表の下に「○ 見放題　△ …」と並べても、
   *   **どの記号も表に無い**ので読者は照らし合わせられない。
   *   その表に出ているのは「— 未確認」だけで、それは記号だけで意味が通る。
   */
  if (plan.resolved > 0) {
    pendingLegends.set(table, legendNode(plan.oldest, plan.resolved < found.size))
  }
}

/** 記事の中の `<table>` を出てくる順に集める。 */
function collectTables(node: Node, out: Node[]): void {
  for (const child of node.children ?? []) {
    if (child.type === 'element' && child.tagName === 'table') out.push(child)
    else collectTables(child, out)
  }
}

/** 決まった凡例を、表の**兄弟**として差し込んで回る。 */
function insertLegends(node: Node): void {
  const children = node.children ?? []
  if (children.length === 0) return
  const out: Node[] = []
  for (const child of children) {
    if (child.type === 'element' && child.tagName === 'table') {
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
    insertLegends(child)
    out.push(child)
  }
  node.children = out
}

export function rehypeAvailability() {
  return (tree: Node): void => {
    try {
      const tables: Node[] = []
      collectTables(tree, tables)
      const plans = tables
        .map((t) => planTable(t))
        .filter((p): p is TablePlan => p !== undefined)

      /*
       * ★ **答えられるのが半分に満たない記事では、行を1つも足さない。**
       *
       *   この行が成り立つのは「表のどの作品にも答えが並ぶ」ときだけ。
       *   一部にしか出せないなら、**出ている行と出ていない行の差**のほうが
       *   目に付いて、読者には壊れて見える（2026-09-06・運用者の指摘）。
       *
       *   実測（2026-09-06）:
       *     コナン        34行中29行に答えあり（85%） → 出す。残り5行は「— 未確認」
       *     8月の新着記事 201行中2行（1%）           → **出さない**
       *   月次記事は在庫を取っていない（`npm run availability` は
       *   シリーズ記事のために回している）ので、
       *   ここを閾値なしにすると **199行の「未確認」**が並ぶ。実際にそうなって直した。
       *
       *   ★ **判断は記事単位。表ごとにしない。** 表ごとにすると、同じ記事の中に
       *     答えのある表と無い表が並ぶ（`planTable` の注意書き）。
       *   ★ 在庫が増えれば自動で出るようになる。**記事側を直す必要はない。**
       */
      const resolved = plans.reduce((n, p) => n + p.resolved, 0)
      const rows = plans.reduce((n, p) => n + p.found.size, 0)
      if (resolved * 2 < rows) return

      const count = { tables: 0, rows: 0 }
      for (const plan of plans) applyPlan(plan, count)
      insertLegends(tree)
    } catch {
      // 表の形が想定と違っても記事は出す。**行が足りないだけ。**
    }
  }
}
