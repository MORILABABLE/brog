/**
 * 記事の**表の直後**に「次の一手」を1つだけ差し込む rehype プラグイン。
 *
 * ■ なぜ表の直後なのか（2026-09-15・実測から）
 * `/posts/harry-potter` は検索流入が最大（28日で表示324・クリック31＝サイト全体の2割強）
 * なのに、**次のページへも外部リンクへも1件も出ていなかった**（38PV・click 0）。
 * 公開中のHTMLを数えて分かった原因は2つ。
 *
 *   1. **他の記事へのリンク10本は、すべて右の枠（`.follow-rail`）の中**だった。
 *      あの枠は 1200px 未満で `display:none`。**読者の97%はスマホ**なので、
 *      他の記事への入口が**1本も見えていなかった**（本文には0本）
 *   2. 「他のサービスで探す」とCTAは本文の後半2/3以降にあり、
 *      **90%スクロール到達は38PV中6（16%）**。8割の読者に届いていない
 *
 * 作品ページは2026-09-14に同じ症状を同じ理由で直している
 * （`pages/works/[id].astro` の `nextArticle`。「1ページに1つだけ、配信状況のすぐ下に置く」）。
 * **記事側にその修正が入っていなかった。** ここがその移植。
 *
 * ■ 差し込むのは2つだけ
 *
 *   B 「終了後も観られるもの」 … 表の○印を数え直した1文＋外部リンク1本
 *   A 「次に読む」             … 記事への内部リンク1本
 *
 * ★ **1か所に1つずつ。** 作品ページの★と同じ理由で、同じ行き先を2度出さない。
 *   選択肢を増やすと読者は選べなくなる（docs/DESIGN.md 5節）。
 *
 * ■ B は表から数え直す（別の台帳を引かない）
 * 数えるのは**前段（`rehype-availability.ts`）が入れた ○ の行そのもの**。
 * 在庫台帳をもう一度引くと、表と要約が食い違いうる。
 * 同じノードから数えていれば、**表に出ていないことは要約にも出ない。**
 *
 * ■ A の行き先は2択（この順）
 *   1. **その作品群をまとめた保存版**（`seriesRefFor`。月次記事 → シリーズ記事）
 *   2. **同じサービスの最新の月次記事**（`latestMonthlyPost`。シリーズ記事 → 月次記事）
 * 1で自分自身しか当たらない記事（＝シリーズ記事そのもの）が2へ落ちる。
 * **月次 ⇄ 保存版**で相互に送り合う形になり、どちらの読者にも
 * 「その記事には絶対に載っていないもの」が次に出る。
 *
 * ■ 実行順（astro.config.mjs）
 *   rehypeAvailability → rehypeFindLinks → **rehypeNextStep** → rehypeAffiliate
 *   - 前段が入れた ○ の行を読むので、`rehypeAvailability` より後
 *   - ここで作った `<a>` に tag= と rel="sponsored" を付けるので、`rehypeAffiliate` より前
 *   **どちらを逆にしても静かに壊れる**（表と要約が食い違う／広告リンクに tag= が付かない）。
 *
 * ■ 計測
 * B のリンクには `class="next-watch-link"` を付けてある。
 * `rehype-affiliate.ts` の `slotOf()` がこれを見て `data-slot="watch"` にし、
 * `BaseLayout.astro` のクリック計測が `aff_watch` として送る。
 * **表の ○（`avail`）と混ぜないこと。** あちらは行ごとの答え、
 * こちらは**表全体の要約からの一手**で、押された意味が違う。
 *
 * ■ 落ちないこと
 * 表が無い・○が1つも無い・記事が引けない、のいずれでも**何もしないで通す**。
 * 差し込めなかった記事は今までどおりの本文で出る。
 *
 * ★ **手元では反映されない**（`rehype-availability.ts` 冒頭と同じ罠）。
 *   記事の描画結果はキャッシュされるので、`.md` が変わらないかぎり
 *   このファイルを直しても手元の dev / build には出ない。
 *     cd site && npm run dev:fresh ／ npm run build:fresh
 *   Cloudflare のビルドは毎回まっさらなので、公開されるものは常に最新。
 */
import { SERVICE_BY_LABEL } from '../src/lib/work-links.ts'
import { seriesRefFor } from '../src/lib/series-for-work.ts'
import { latestMonthlyPost, postBySlug } from '../src/lib/post-index.ts'

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

interface VFile {
  path?: string
  history?: string[]
}

/**
 * A を出すのに要る「同じ保存版に当たった行」の数。
 *
 * ★ 1行でも出すと、45行の月次記事に**たまたま1本入っていたシリーズ**への
 *   リンクが立つ。読者から見ると関係の薄い記事なので、2行を下限にする。
 */
const MIN_SERIES_ROWS = 2

/**
 * B を出すのに要る作品数と割合。
 *
 * ■ なぜ割合が要るか（2026-09-15・実測）
 * 記事の表を全部まとめて数えるようにしたとき、こうなった。
 *
 *     2026-08-ended        この記事の**152本のうち2本**は、Amazon Prime Video の見放題にも
 *     2026-08-leaving-u-next  この記事の**160本のうち6本**は、Disney+ の見放題にも
 *
 * どちらも**事実だが、読者にとっては雑音**。「終了後もそこで観られる」と
 * 見出しを付けているのに、当てはまるのが1〜4%では**代わりの行き先を示したことにならない。**
 * 件数だけで切ると母数の大きい記事が必ず通ってしまうので、割合で見る。
 *
 * ★ 0.2 は「5本に1本」。実測では
 *   ハリー・ポッター 9/11（82%）が通り、上の2本が落ちる。
 */
const MIN_WATCH_ROWS = 3
const MIN_WATCH_SHARE = 0.2

function text(value: string): Node {
  return { type: 'text', value }
}

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function hasClass(node: Node, name: string): boolean {
  const cls = node.properties?.className
  return Array.isArray(cls) && cls.includes(name)
}

function cellsOf(row: Node): Node[] {
  return (row.children ?? []).filter((c) => c.tagName === 'td' || c.tagName === 'th')
}

/** 深さ優先で最初に見つかる要素 */
function find(node: Node, match: (n: Node) => boolean): Node | undefined {
  for (const child of node.children ?? []) {
    if (match(child)) return child
    const hit = find(child, match)
    if (hit) return hit
  }
  return undefined
}

function findAll(node: Node, match: (n: Node) => boolean, out: Node[] = []): Node[] {
  for (const child of node.children ?? []) {
    if (match(child)) out.push(child)
    findAll(child, match, out)
  }
  return out
}

/** 最初の表と、その親・位置。表が無ければ undefined */
function firstTable(
  node: Node,
): { table: Node; parent: Node; index: number } | undefined {
  const children = node.children ?? []
  for (const [index, child] of children.entries()) {
    if (child.tagName === 'table') return { table: child, parent: node, index }
    const hit = firstTable(child)
    if (hit) return hit
  }
  return undefined
}

interface WatchTarget {
  /** 表示名（`Amazon Prime Video`） */
  label: string
  /** ○が付いた行の数 */
  rows: number
  /** そのサービスの最初のリンク。無ければ文だけ出す */
  href?: string
}

/**
 * 表を読む。**この関数だけが表の形を知っている。**
 *
 * ★ **記事の表を全部まとめて数える**（2026-09-15）。
 *   月次記事は日付ごとに表が割れていて**最大9枚**ある。
 *   最初の1枚だけを数えると、63本の記事で「10本のうち8本」と要約することになり、
 *   読者には記事全体の話に見える。**記事が扱っている作品の全数で言う。**
 *
 * @returns 作品の行数・記事が扱っているサービス・○が付いたサービスごとの集計
 */
function readTables(tables: Node[]): {
  workRows: Node[]
  /** そのサービスが何行に出ているか。**多いほうがその記事の主題** */
  ownServices: Map<string, number>
  watch: Map<string, WatchTarget>
} {
  const rows = tables.flatMap((t) => findAll(t, (n) => n.tagName === 'tr'))
  const workRows = rows.filter(
    (r) => !hasClass(r, 'avail-row') && cellsOf(r).some((c) => c.tagName === 'td'),
  )

  /*
   * 記事が扱っているサービス＝作品の行のセルに素で書かれているサービス名。
   * ★ frontmatter の `tags` を使わない。シリーズ記事のタグには
   *   「終了するサービス」と「まだ観られるサービス」が**両方入っている**ので、
   *   タグで外すと B の言うことが無くなる。表が正である。
   */
  const ownServices = new Map<string, number>()
  for (const row of workRows) {
    for (const cell of cellsOf(row)) {
      const label = textOf(cell).trim()
      if (SERVICE_BY_LABEL.has(label)) ownServices.set(label, (ownServices.get(label) ?? 0) + 1)
    }
  }

  /*
   * ○（見放題）が付いたサービスを数える。見るのは前段が入れた行だけ。
   * ★ **行ごとに1回だけ数える。** 同じ行に同じサービスの印が2つ出ることは
   *   無いはずだが、数え方の保証はこちら側で持っておく。
   */
  const watch = new Map<string, WatchTarget>()
  for (const row of rows.filter((r) => hasClass(r, 'avail-row'))) {
    const seen = new Set<string>()
    for (const item of findAll(row, (n) => hasClass(n, 'avail-item'))) {
      if (item.properties?.['data-mark'] !== 'subscription') continue
      const title = String(item.properties?.title ?? '')
      const label = title.replace(/（.*?）\s*$/, '').trim()
      if (!SERVICE_BY_LABEL.has(label) || seen.has(label)) continue
      seen.add(label)
      const link = find(item, (n) => n.tagName === 'a')
      const href = typeof link?.properties?.href === 'string' ? link.properties.href : undefined
      const found = watch.get(label)
      if (found) {
        found.rows += 1
        found.href ??= href
      } else {
        watch.set(label, { label, rows: 1, href })
      }
    }
  }

  return { workRows, ownServices, watch }
}

/** B。表の○を数え直した1文と、外部リンク1本 */
function watchBlock(
  workRows: Node[],
  ownServices: Map<string, number>,
  watch: Map<string, WatchTarget>,
  category: string,
  single: boolean,
): Node | undefined {
  /*
   * 記事が扱っているサービスは外す。**そこは「終わる」と書いてある側**なので、
   * 「ここでも観られます」と言うと表と矛盾する。
   */
  const others = [...watch.values()]
    .filter(
      (w) =>
        !ownServices.has(w.label) &&
        w.rows >= MIN_WATCH_ROWS &&
        w.rows / workRows.length >= MIN_WATCH_SHARE,
    )
    .sort((a, b) => b.rows - a.rows || (a.href ? -1 : 1))

  const top = others[0]
  if (!top || !top.href) return undefined

  /*
   * ★ **並びを紹介料の高い順にしない**（docs/AFFILIATE.md 7節）。
   *   選んでいるのは「○が最も多いサービス」で、報酬の有無は見ていない。
   *   結果として Amazon になることが多いのは、在庫台帳を持つ4社のうち
   *   提携があるのがそこだけだから。
   */
  const ended = category === 'leaving' || category === 'ended'
  return {
    type: 'element',
    tagName: 'p',
    properties: { className: ['next-step-watch'] },
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['next-step-label'] },
        children: [text(ended ? '終了後も観られるもの' : 'ほかでも観られるもの')],
      },
      text(`${single ? '下の表' : 'この記事'}の${workRows.length}本のうち`),
      { type: 'element', tagName: 'b', children: [text(`${top.rows}本`)] },
      /*
       * ★ **「○印」と書かない。** この文は表の**前**に出る。
       *   印の凡例（`avail-legend`）は表の後ろにあるので、
       *   ここで記号を参照すると**説明を読む前に記号を指す**ことになる。
       */
      text(`は、${top.label}の見放題にもあります。`),
      {
        type: 'element',
        tagName: 'a',
        properties: {
          href: top.href,
          className: ['next-watch-link'],
          // rel と tag= は後段（rehype-affiliate）が付ける
          target: '_blank',
        },
        children: [text(`${top.label}で観る`)],
      },
    ],
  }
}

/** A。記事への内部リンク1本 */
function articleBlock(
  workRows: Node[],
  ownServices: Map<string, number>,
  slug: string,
  category: string,
): Node | undefined {
  /*
   * 1. その作品群をまとめた保存版（月次記事 → シリーズ記事）。
   *    ★ セルの中身をそのまま `seriesRefFor` に渡してよい。
   *      引き当ては `data/articles.json` の `flags.match`（人が書いた正規表現）で、
   *      日付や状態のセルはどの式にも当たらない。
   */
  const hits = new Map<string, { slug: string; rows: number }>()
  for (const row of workRows) {
    for (const cell of cellsOf(row)) {
      const ref = seriesRefFor(textOf(cell).trim())
      if (!ref || ref.slug === slug) continue
      const found = hits.get(ref.slug)
      if (found) found.rows += 1
      else hits.set(ref.slug, { slug: ref.slug, rows: 1 })
      break // 1行につき1回
    }
  }
  const best = [...hits.values()].sort((a, b) => b.rows - a.rows)[0]
  if (best && best.rows >= MIN_SERIES_ROWS) {
    const post = postBySlug(best.slug)
    if (post) return articleLink(post.slug, post.title, 'このシリーズをまとめた記事はコチラ')
  }

  /*
   * 2. 同じサービスの最新の月次記事（シリーズ記事 → 月次記事）。
   *    ★ **保存版に載っていないものへ送る。** 保存版は主題が1つに閉じているので、
   *      「同じ月に同じサービスで終わる他の作品」はどうやっても載らない。
   */
  /*
   * ★ **いちばん多く出ているサービス**で選ぶ。
   *   最初に見つかったものにすると、表の1行目がたまたま他社だったときに
   *   記事の主題と違うサービスの月次記事へ送ることになる。
   */
  const service = [...ownServices.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!service || !category) return undefined
  const monthly = latestMonthlyPost(service, category, slug)
  return monthly ? articleLink(monthly.slug, monthly.title, '次に読む') : undefined
}

function articleLink(slug: string, title: string, label: string): Node {
  return {
    type: 'element',
    tagName: 'a',
    properties: { className: ['next-step-article'], href: `/posts/${slug}` },
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['next-step-label'] },
        children: [text(label)],
      },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['next-step-title'] },
        children: [text(title)],
      },
    ],
  }
}

export function rehypeNextStep() {
  return (tree: Node, file: VFile): void => {
    const spot = firstTable(tree)
    if (!spot) return

    const path = file.path ?? file.history?.[0] ?? ''
    const slug = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') ?? ''
    const post = slug ? postBySlug(slug) : undefined

    const tables = findAll(tree, (n) => n.tagName === 'table')
    const { workRows, ownServices, watch: marks } = readTables(tables)
    if (workRows.length === 0) return

    const watch = watchBlock(workRows, ownServices, marks, post?.category ?? '', tables.length === 1)
    /*
     * ★ **記事が引けないときは A を出さない。** slug が取れなければ
     *   「自分自身を除く」ができず、**自分へのリンクが立ちうる。**
     */
    const article = post ? articleBlock(workRows, ownServices, post.slug, post.category) : undefined
    if (!watch && !article) return

    /*
     * ★ **B は表の前、A は表の後ろ**（2026-09-15・375px で実測して分けた）。
     *
     *   375px の実機幅で測ると、`/posts/harry-potter` の表は**高さ2,157px**ある
     *   （11作 × 印の行）。両方を表の直後に置くと **4.7画面目**に沈み、
     *   「表の直後なら読まれる」という前提が成り立たない。
     *
     *     h1 169px ／ 本文 690px ／ 表 1,581px ／ 表の直後 3,807px ／ 記事末尾のCTA 7,863px
     *
     *   - B（終了後も観られる）… **表を読む前に知っておくこと**。1.7画面目に上がる
     *   - A（次に読む）        … **表を読み終えた人の出口**。表の前に置くと
     *     本文を読む前に外へ誘導することになる
     */
    const parent = spot.parent.children ?? []
    const after = parent[spot.index + 1]
    const at = after && hasClass(after, 'avail-legend') ? spot.index + 2 : spot.index + 1

    if (article) parent.splice(at, 0, {
      type: 'element',
      tagName: 'aside',
      properties: { className: ['next-step'], 'aria-label': '次の一手' },
      children: [article],
    })
    // ★ A を入れたあとに B を入れる。前に差すと A の位置が1つずれる
    if (watch) parent.splice(spot.index, 0, watch)
  }
}

export default rehypeNextStep
