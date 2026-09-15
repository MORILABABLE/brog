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
 *   B 「紹介する◯本のうち△本は…」 … 表の○印を数え直した1文＋外部リンク1本
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
 * B を出すかどうかの3つの条件。
 *
 * ■ 割合の分母は「**確認済みの作品**」（2026-09-15 変更）
 * 表の印は `data/availability.json`（**273作品**）だけが根拠で、
 * そこに無い作品は「—（未確認）」になる。**未確認を分母に入れると、
 * 台帳が薄い記事ほど割合が下がる** — 事実ではなく台帳のカバー率を測ってしまう。
 *
 *     2026-09-leaving-netflix   63作中 **40作が未確認**
 *       全作品を分母に  11/63 = 17.5%  → 出ない
 *       確認済みを分母に 11/23 = 47.8%  → 出る（**こちらが事実に近い**）
 *
 * ■ ただし確認済みが少なすぎるときは言わない
 * 分母が1〜2作だと「100%」になってしまう（実測: `2026-08-ended` は76作中
 * **確認済み1作**で、その1作が Prime にあるだけで100%）。
 * **10作は確認できていること**を条件にする。
 *
 * ★ 読者に見せる文は**紹介した全作品**が分母（「紹介する63本のうち11本」）。
 *   判定の分母と表示の分母が違うのは意図したもので、
 *   **11本という数字は「確認できた範囲での下限」**。未確認の52本について何も言っていない。
 */
const MIN_WATCH_ROWS = 3
const MIN_WATCH_SHARE = 0.2
const MIN_WATCH_KNOWN = 10

/**
 * 1記事に出す A（次に読む）の上限。
 *
 * ★ 月次記事は表が最大9枚ある。全部に出すと**出口だけが9個並ぶ**。
 *   3本にしているのは、実測で「別々の行き先」が取れるのが
 *   いちばん多い記事でも3本だったため（`2026-09-leaving-netflix` は
 *   ハリー・ポッター／ジュラシック・パーク／007）。
 */
const MAX_ARTICLE_LINKS = 3

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

/** そのノードの親と位置。**入れる直前に引き直す**（入れるたびに位置が動くため） */
function locate(root: Node, target: Node): { parent: Node; index: number } | undefined {
  const children = root.children ?? []
  const index = children.indexOf(target)
  if (index >= 0) return { parent: root, index }
  for (const child of children) {
    const hit = locate(child, target)
    if (hit) return hit
  }
  return undefined
}

/** 記事の表に出ている作品1件ぶん。**行ではなく作品**で持つ（同じ作品が複数の表に出る） */
interface TableWork {
  /** 「作品」列の文字列。`seriesRefFor` に渡す */
  title: string
  /** 在庫台帳に載っていたか（印の行が「—（未確認）」でない） */
  known: boolean
  /** その作品の行が名乗っているサービス（表に素で書かれているもの） */
  own: Set<string>
  /** ○（見放題）が付いたサービス → そのリンク */
  subs: Map<string, string | undefined>
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
  /** 記事が扱っている作品。**同じ作品は1件**（下の★） */
  works: Map<string, TableWork>
  /** 表ごとの作品の題名（引数の並び順）。**A を表ごとに出すのに使う** */
  perTable: string[][]
  /** そのうち在庫台帳に載っていた作品の数。**割合の分母**（`MIN_WATCH_SHARE` の■） */
  known: number
  /** そのサービスを名乗る作品が何件あるか。**多いほうがその記事の主題** */
  ownServices: Map<string, number>
  watch: Map<string, WatchTarget>
} {
  const works = new Map<string, TableWork>()
  const perTable: string[][] = []

  for (const table of tables) {
    const titles: string[] = []
    perTable.push(titles)
    const rows = findAll(table, (n) => n.tagName === 'tr')
    /*
     * 「作品」の列。**表ごとに探す**（記事タイプで列の数が違う。
     * 終了日/作品/評価/サービス の4列と、終了日/作品/状態/出演者/サービス の5列がある）。
     * 見出しで探すのは `rehype-availability.ts` の `dropColumn` と同じやり方。
     */
    const headRow = rows.find((r) => cellsOf(r).some((c) => c.tagName === 'th'))
    const titleIndex = headRow
      ? cellsOf(headRow).findIndex((c) => textOf(c).trim() === '作品')
      : -1

    for (const [i, row] of rows.entries()) {
      if (hasClass(row, 'avail-row')) continue
      const cells = cellsOf(row)
      if (!cells.some((c) => c.tagName === 'td')) continue

      /*
       * ★ **作品の同一性は、まず作品ページのURL。** 無ければ題名の文字列。
       *   リンクが付くのは作品ページを持つ作品だけなので、両方要る
       *   （実測: 9月のNetflix記事は63作中50作にリンクがある）。
       */
      const link = find(row, (n) => n.tagName === 'a' && hasClass(n, 'work-link'))
      const href = typeof link?.properties?.href === 'string' ? link.properties.href : undefined
      const titleCell = titleIndex >= 0 ? cells[titleIndex] : undefined
      const key = href ?? textOf(titleCell ?? row).trim()
      if (!key) continue

      const title = titleCell ? textOf(titleCell).trim() : textOf(link ?? row).trim()
      if (title) titles.push(title)
      const found = works.get(key) ?? { title, known: false, own: new Set<string>(), subs: new Map() }
      // 題名は先に見つかったほうを残す（全件リストと節別の表で書式が違うことはない）
      if (!found.title) found.title = title
      works.set(key, found)

      /*
       * 記事が扱っているサービス＝作品の行のセルに素で書かれているサービス名。
       * ★ frontmatter の `tags` を使わない。シリーズ記事のタグには
       *   「終了するサービス」と「まだ観られるサービス」が**両方入っている**ので、
       *   タグで外すと B の言うことが無くなる。表が正である。
       */
      for (const cell of cells) {
        const label = textOf(cell).trim()
        if (SERVICE_BY_LABEL.has(label)) found.own.add(label)
      }

      /*
       * ○（見放題）の印。**直後の行**が前段（`rehype-availability.ts`）の入れた印の行。
       * ★ 行ではなく**作品**で数える。同じ作品が節別の表と全件リストの両方に出るので、
       *   行で数えると二重になる（実測: 9月のNetflix記事は108行・**63作品**）。
       */
      const next = rows[i + 1]
      if (!next || !hasClass(next, 'avail-row')) continue
      /*
       * ★ **「—（未確認）」だけの行は確認済みに数えない。**
       *   状態は前段が印から機械的に決めている（`rehype-availability.ts` の `stateOf`）。
       *   `unknown` は「台帳に無い」で、「調べたうえで無い」（`none`）とは別
       *   （`src/lib/availability.ts` の「絶対に守ること」2）。
       */
      const state = find(next, (n) => hasClass(n, 'avail-label'))?.properties?.['data-state']
      if (state && state !== 'unknown') found.known = true
      for (const item of findAll(next, (n) => hasClass(n, 'avail-item'))) {
        if (item.properties?.['data-mark'] !== 'subscription') continue
        const label = String(item.properties?.title ?? '')
          .replace(/（.*?）\s*$/, '')
          .trim()
        if (!SERVICE_BY_LABEL.has(label)) continue
        const mark = find(item, (n) => n.tagName === 'a')
        const markHref =
          typeof mark?.properties?.href === 'string' ? mark.properties.href : undefined
        if (!found.subs.has(label) || (markHref && !found.subs.get(label))) {
          found.subs.set(label, markHref)
        }
      }
    }
  }

  const ownServices = new Map<string, number>()
  const watch = new Map<string, WatchTarget>()
  let known = 0
  for (const w of works.values()) {
    if (w.known) known += 1
    for (const label of w.own) ownServices.set(label, (ownServices.get(label) ?? 0) + 1)
    for (const [label, href] of w.subs) {
      const found = watch.get(label)
      if (found) {
        found.rows += 1
        found.href ??= href
      } else {
        watch.set(label, { label, rows: 1, href })
      }
    }
  }

  return { works, perTable, known, ownServices, watch }
}

/** B。表の○を数え直した1文と、外部リンク1本 */
function watchBlock(
  workCount: number,
  known: number,
  ownServices: Map<string, number>,
  watch: Map<string, WatchTarget>,
): Node | undefined {
  // 確認できた作品が少なすぎるときは、割合を出す意味が無い（上の■）
  if (known < MIN_WATCH_KNOWN) return undefined
  /*
   * 記事が扱っているサービスは外す。**そこは「終わる」と書いてある側**なので、
   * 「ここでも観られます」と言うと表と矛盾する。
   */
  const others = [...watch.values()]
    .filter(
      (w) =>
        !ownServices.has(w.label) &&
        w.rows >= MIN_WATCH_ROWS &&
        w.rows / known >= MIN_WATCH_SHARE,
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
  return {
    type: 'element',
    tagName: 'p',
    properties: { className: ['next-step-watch'] },
    /*
     * ★ **見出しのラベルを置かない**（2026-09-15・運用者の指定で削除）。
     *   1文しか無い枠に名札を付けると、読む行が2行に割れる。
     * ★ **「○印」と書かない。** この文は表の**前**に出る。
     *   印の凡例（`avail-legend`）は表の後ろにあるので、
     *   ここで記号を参照すると**説明を読む前に記号を指す**ことになる。
     * ★ **「下の表の」と言わない。** 月次記事は表が最大9枚に割れていて、
     *   数えているのは**記事が扱う全作品**（`readTables`）。
     *   表を指すと、すぐ下の1枚だけの話に読める。
     */
    children: [
      text(`紹介する${workCount}本のうち`),
      { type: 'element', tagName: 'b', children: [text(`${top.rows}本`)] },
      text(`は${top.label}でも見放題配信中です。`),
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

/**
 * A その1。**その表に出ている作品群をまとめた保存版**へ。
 *
 * ■ なぜ表ごとに見るのか（2026-09-15・実測で分けた）
 * 月次記事は日付ごとに節が割れていて、**節ごとに主題が違う**。
 *
 *     2026-09-leaving-netflix  表1→ハリー・ポッター(10作) 表2→ジュラシック・パーク(5作) 表5→007(5作)
 *     2026-09-leaving-prime-video  表4→ミッション:インポッシブル(5作) 表5→トランスフォーマー(5作)
 *
 * 記事の全作品をまとめて見ると**いちばん大きい束しか出ない**（1本）。
 * 表ごとに見れば、**その節を読んでいる人にとって関係のある保存版**を出せる。
 *
 * ★ **同じ行き先は1記事に1回だけ**（`used`）。月次記事の最後には
 *   「全終了作品リスト」があり、そこは最初の表と同じ束に当たる。
 *   止めないと同じリンクが2回出て、読者にはリンクの重複にしか見えない。
 */
function seriesLink(titles: string[], selfSlug: string, used: Set<string>): Node | undefined {
  /*
   * ★ 渡すのは**「作品」列の題名だけ**。引き当ては `data/articles.json` の
   *   `flags.match`（人が書いた正規表現）で、題名に当てる前提で書かれている。
   */
  const hits = new Map<string, number>()
  for (const title of titles) {
    const ref = seriesRefFor(title)
    if (!ref || ref.slug === selfSlug || used.has(ref.slug)) continue
    hits.set(ref.slug, (hits.get(ref.slug) ?? 0) + 1)
  }
  const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!best || best[1] < MIN_SERIES_ROWS) return undefined
  const post = postBySlug(best[0])
  if (!post) return undefined
  used.add(post.slug)
  return articleLink(
    post.slug,
    post.title,
    'このシリーズをまとめた記事はコチラ',
    post.heroImage,
    post.category,
  )
}

/**
 * A その2。**同じサービスの最新の月次記事**へ（保存版 → 月次記事）。
 *
 * ★ **保存版に載っていないものへ送る。** 保存版は主題が1つに閉じているので、
 *   「同じ月に同じサービスで終わる他の作品」はどうやっても載らない。
 * ★ **最初の表でしか使わない。** 記事ぜんぶに1本あればよい落とし先で、
 *   節ごとに出すと同じリンクが並ぶ。
 */
function monthlyLink(
  ownServices: Map<string, number>,
  selfSlug: string,
  category: string,
  used: Set<string>,
): Node | undefined {
  /*
   * ★ **いちばん多く出ているサービス**で選ぶ。
   *   最初に見つかったものにすると、表の1行目がたまたま他社だったときに
   *   記事の主題と違うサービスの月次記事へ送ることになる。
   */
  const service = [...ownServices.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!service || !category) return undefined
  const monthly = latestMonthlyPost(service, category, selfSlug)
  if (!monthly || used.has(monthly.slug)) return undefined
  used.add(monthly.slug)
  return articleLink(
    monthly.slug,
    monthly.title,
    '次に読む',
    monthly.heroImage,
    monthly.category,
  )
}

/**
 * 絵の一辺（px）。**作品ページの「次の1本」と同じ 72px・角丸8px**
 * （`pages/works/[id].astro` の `<Thumb … size={72} radius={8} />`）。
 * 同じ役目の枠が2か所で違う大きさに見えないようにする。
 */
const THUMB_SIZE = 72

/**
 * 記事カードと同じ絵を置く。
 *
 * ■ なぜ絵が要るか（`pages/works/[id].astro` の `series-ref` と同じ理由）
 * 一覧・追従枠・作品ページで見たのと**同じ絵**がここにも出ることで、
 * 読者は「さっき見た記事」か「まだ見ていない記事」かを絵で判別できる。
 *
 * ★ **`Thumb.astro` を使えない。** ここは rehype で組み立てる素のHTMLで、
 *   Astro コンポーネントのスコープ付きCSS（`data-astro-cid-…`）が乗らない。
 *   **markup と見た目を `styles/global.css` 側に写してある**
 *   （`.next-step-thumb`）。あちらを直すときは両方を見ること。
 *
 * ★ **画像が無くても同じ大きさの枠を出す**（Thumb.astro の★と同じ）。
 *   出さないと、絵のある記事と無い記事で枠の高さが変わる。
 *   色はカテゴリの色（`--cat-*`）に落ちる。
 */
function thumb(image: string, category: string): Node {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['next-step-thumb'], 'data-category': category || undefined },
    children: image
      ? [
          {
            type: 'element',
            tagName: 'img',
            properties: {
              src: image,
              alt: '',
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              loading: 'lazy',
              decoding: 'async',
            },
            children: [],
          },
        ]
      : [],
  }
}

function articleLink(
  slug: string,
  title: string,
  label: string,
  image: string,
  category: string,
): Node {
  return {
    type: 'element',
    tagName: 'a',
    properties: { className: ['next-step-article'], href: `/posts/${slug}` },
    children: [
      thumb(image, category),
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['next-step-body'] },
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
      },
    ],
  }
}

export function rehypeNextStep() {
  return (tree: Node, file: VFile): void => {
    const tables = findAll(tree, (n) => n.tagName === 'table')
    if (tables.length === 0) return

    const path = file.path ?? file.history?.[0] ?? ''
    const slug = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') ?? ''
    const post = slug ? postBySlug(slug) : undefined

    const { works, perTable, known, ownServices, watch: marks } = readTables(tables)
    if (works.size === 0) return

    /*
     * ★ **B は最初の表の前、A は表ごとに後ろ**（2026-09-15・375px で実測して分けた）。
     *
     *   375px の実機幅で測ると、`/posts/harry-potter` の表は**高さ2,157px**ある
     *   （11作 × 印の行）。両方を表の直後に置くと **4.7画面目**に沈み、
     *   「表の直後なら読まれる」という前提が成り立たない。
     *
     *     h1 169px ／ 本文 690px ／ 表 1,581px ／ 表の直後 3,807px ／ 記事末尾のCTA 7,863px
     *
     *   - B … **表を読む前に知っておくこと**。最初の表の前に1つだけ（2.0画面目）
     *   - A … **表を読み終えた人の出口**。表の前に置くと本文より先に外へ誘導することになる
     */
    const watch = watchBlock(works.size, known, ownServices, marks)

    /*
     * A を置く場所を決める。**入れるのは後**（入れながら歩くと位置がずれる）。
     * ★ **記事が引けないときは A を出さない。** slug が取れなければ
     *   「自分自身を除く」ができず、**自分へのリンクが立ちうる。**
     */
    const plans: { table: Node; node: Node }[] = []
    if (post) {
      const used = new Set<string>()
      for (const [i, table] of tables.entries()) {
        if (plans.length >= MAX_ARTICLE_LINKS) break
        const titles = perTable[i] ?? []
        const node =
          seriesLink(titles, post.slug, used) ??
          // ★ 落とし先（月次記事）は**最初の表だけ**。節ごとに出すと同じリンクが並ぶ
          (i === 0 ? monthlyLink(ownServices, post.slug, post.category, used) : undefined)
        if (node) plans.push({ table, node })
      }
    }

    if (!watch && plans.length === 0) return

    // 後ろの表から入れる。前から入れると、あとの表の位置がずれる
    for (const plan of plans.reverse()) {
      const spot = locate(tree, plan.table)
      if (!spot) continue
      /*
       * ★ **凡例（`○ 見放題 △ …`）の後ろに置く。** 凡例を入れているのは
       *   前段（`rehype-availability.ts`）で、表の直後に1枚だけ足す。
       */
      const after = spot.parent.children?.[spot.index + 1]
      const at = after && hasClass(after, 'avail-legend') ? spot.index + 2 : spot.index + 1
      spot.parent.children?.splice(at, 0, {
        type: 'element',
        tagName: 'aside',
        properties: { className: ['next-step'], 'aria-label': '次の一手' },
        children: [plan.node],
      })
    }

    // ★ A を入れたあとに B を入れる。前に差すと A の位置が1つずれる
    if (watch) {
      const first = locate(tree, tables[0]!)
      first?.parent.children?.splice(first.index, 0, watch)
    }
  }
}

export default rehypeNextStep
