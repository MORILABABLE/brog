/**
 * 小段落の直下に広告を、表の直下に配信カレンダーへの導線を差し込む rehype プラグイン。
 *
 * ■ なぜ本文に書かせず、ビルドで入れるのか（2026-09-19・テンプレ改修）
 * 新しい記事テンプレは「小段落1の直下」「小段落2の直下」に広告を置くことになっている
 * （`theme-packs/streaming-jp/templates/writing.md` 0節）。
 * **これを記事本文に書かせてはいけない。**
 *
 *   1. **afb のリンクコードは `.env` から来る。** 記事に焼き込むと、
 *      原稿を差し替えるたびに全記事の書き直しが要る（docs/AFFILIATE.md）
 *   2. **掲載NGの判定はページ全体の文字列を見る。** 書き手には判断できない
 *      （ディズニー作品・TBS作品が1つでもあれば Hulu は出せない。`lib/hulu-ng.ts`）
 *   3. **出し分けが変わる。** U-NEXT の提携が通れば優先順位が変わるが、
 *      そのとき記事を1本も触らずに切り替わってほしい
 *
 * 品質ゲート側も、本文に `afi-b.com` と `/leaving/` `/arrivals/` のリンクがあれば
 * error で止める（`theme-packs/streaming-jp/article-types/shared.ts` の AUTO_LINKS）。
 *
 * ■ 差し込むのは3つ
 *
 *   広告1     小段落1（最初の `##`）の直下
 *   カレンダー 小段落2（2つ目の `##`）の**表の直下**
 *   広告2     小段落2の直下
 *
 * ★ **枠の総数は増えていない。** 改修前は「本文の上に afb 1枠」＋「記事末尾に Amazon 1枠」で
 *   2つだった。位置を小段落の直下へ移しただけ（`pages/posts/[...slug].astro` の★）。
 *
 * ■ 何を出すか（2026-09-19・運用者の指定）
 *
 *   1. **Amazonプライムの無料体験** … Prime Video 主題の「まだ観られる」記事
 *   2. Hulu（afb）                  … 掲載NGを含まない面
 *   3. **Amazonプライムの無料体験** … Hulu が出せない面を埋める
 *
 * 1 と 3 は**同じ原稿・同じリンク**で、違うのは順番だけ。
 *
 * ★ **なぜ Prime Video の記事だけ Hulu より先なのか。**
 *   その面の読者は Prime Video の作品を読みに来ている。噛み合う広告がある面で
 *   他社の広告を優先する理由が無い。**判定は `lib/prime-ad.ts` が持つ**
 *   （終了済みの記事には出ない ＝ 観られない作品の面で会員を勧めない）。
 *
 * 🔴 **リンク先は `/amazonprime`（無料体験の専用リンク）。ストアフロントではない**
 *    （2026-09-19・運用者の指定）。
 *    **プライム無料体験 500円/件は専用リンクを経由しないと0円**で、
 *    ふつうの商品リンクのようにクッキーでは取れない（`lib/affiliate.ts` の `primeTrialUrl`）。
 *    表の作品名がすでに普通のリンクなので、**この枠は専用リンクにしか使い道が無い。**
 *
 * ⛔ **U-NEXT は入っていない。** afb の提携が不合格で、記事側に出せる原稿が無い
 *    （docs/AFFILIATE.md 14節）。別ASPで通ったらここに1段足す。
 *
 * 🔴 **Hulu の枠に作品名を入れないこと。** 当サイトは Hulu の配信状況を持っていないので、
 *    作品に触れた瞬間に「未配信タイトルでの訴求」になりうる（`lib/hulu-ad.ts` 冒頭）。
 *    この枠が出すのは広告主の原稿（バナー画像かテキスト1文）だけ。
 *
 * ■ カレンダーの行き先
 * 記事の表に出ているサービスのうち**いちばん多い1社**へ送る。
 * 終了系の記事は `/leaving/<サービス>`、開始系は `/arrivals/<サービス>`。
 * **サービスが決められない記事では何も差し込まない**（`CALENDAR_SERVICES` に無い社を含む）。
 *
 * ■ 実行順（astro.config.mjs）
 *   rehypeWorkLinks → rehypeAvailability → … → **rehypeSectionAds** → rehypeAffiliate
 *   - 表のサービス名を読むので `rehypeWorkLinks` より後でよい（読むのは `<td>` の文字）
 *   - ここで作った `<a>` に tag= と rel="sponsored" を付けるので、`rehypeAffiliate` より前
 *
 * ■ 落ちないこと
 * 見出しが無い・表が無い・リンクコードが未設定、のいずれでも**何もしないで通す**。
 *
 * ★ **手元では反映されない**（`rehype-availability.ts` 冒頭と同じ罠）。
 *   記事の描画結果はキャッシュされるので、`.md` が変わらないかぎり
 *   このファイルを直しても手元の dev / build には出ない。
 *     cd site && npm run dev:fresh ／ npm run build:fresh
 */
import { huluNgHitsIn } from '../src/lib/hulu-ng.ts'
import { SERVICE_BY_LABEL } from '../src/lib/work-links.ts'
import { hasCalendar } from '../src/lib/events-data.ts'
import { postBySlug } from '../src/lib/post-index.ts'
import { primeTrialUrl } from '../src/lib/affiliate.ts'
import { primeAdWithTag, type PrimeAdInput } from '../src/lib/prime-ad.ts'
import { publicImageSize } from '../src/lib/image-size.ts'

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
 * Hulu（afb）の原稿。**`astro.config.mjs` が loadEnv で組み立てて渡す。**
 *
 * ★ `src/lib/hulu-ad.ts` と**同じ環境変数**を読んでいる。
 *   astro.config は Astro が .env を読む前に評価されるので import.meta.env が使えず、
 *   loadEnv でもう一度組み立てるしかない（`rehypeAffiliate` の tags と同じ事情）。
 *   **変数名を変えるときは両方直すこと。**
 *
 * 🔴 **LP・1x1・バナーは「同じ原稿」から取ること**（`lib/hulu-ad.ts` の🔴）。
 *   afb は原稿ごとに `a=` が違う。混ぜると成果が別の原稿に付く。
 */
export interface HuluCreative {
  /** リンクコードの href。**これが空なら Hulu は1バイトも出ない** */
  lp: string
  /** バナー原稿の画像URL（afb の管理画面のもの）。空ならテキスト原稿になる */
  banner?: string
  /** `320x50` の形。読めなければ既定に落ちる */
  bannerSize?: string
  /** 表示計測の1x1。**本番ビルドでだけ渡すこと**（`lib/afb.ts` の AFB_IMPRESSION_BUILD） */
  impression?: string
}

export interface SectionAdsOptions {
  hulu?: HuluCreative
  /**
   * Amazonプライムの**メンバー紹介**のトラッキングid（`PUBLIC_AMAZON_TAG_PRIME`）。
   *
   * 🔴 **他の Amazon の枠と混ぜないこと。** 無料体験は紹介料ではなく固定報酬で、
   *   同じIDにするとレポートで単価が読めなくなる（`src/config.ts` の `prime`）。
   */
  primeTag?: string
}

/**
 * afb のテキスト原稿の文言。**書き換えないこと**（`lib/hulu-ad.ts` と同じ値）。
 * 広告主が用意した表現で、当サイトが作った「見放題」の主張ではない。
 */
const HULU_ACTION = 'Huluなら人気の映画、ドラマ、アニメ、バラエティが見放題！'

/** バナーの代替テキスト。**原稿の `alt="hulu"` そのまま**（説明を足さない） */
const HULU_BANNER_ALT = 'hulu'

/**
 * Amazon のバナー原稿。**`components/AmazonBanner.astro` と同じファイルを使う。**
 * 差し替えるときは両方が同じ絵を指していることを確かめること。
 */
const AMAZON_BANNER = '/ads/amazon-prime-video-728x90.jpg'
const AMAZON_BANNER_ALT = 'Amazon Prime Video'

/**
 * 狭い画面の原稿。**置いてあるものを拾う**（`components/AmazonBanner.astro` と同じ並び）。
 *
 * ★ **横長のままスマホに出すと読めない。** 390px の画面では高さ44pxまで縮み、
 *   「今すぐ無料体験」の文字が7px相当になる（2026-09-19 の実測）。
 *   効くのは**縦横比の違う原稿に差し替えること**だけ。
 * ★ 無いあいだは横長1枚のまま。壊れた画像にはならない。
 */
const AMAZON_SP_CANDIDATES = [
  '/ads/amazon-prime-video-sp.jpg',
  '/ads/amazon-prime-video-sp.png',
  '/ads/amazon-prime-video-sp.gif',
  '/ads/amazon-prime-video-sp.webp',
]

/** 切り替えの境目。**サイトの「スマホ」の線**（styles/global.css の 47rem） */
const SP_MAX = '47rem'

/**
 * Hulu を出さないサービス。**ディズニー作品の掲載NGをページ単位で止める。**
 * 文字列照合にすると表の `Disney+` に全部当たるので、扱っている社で見る
 * （`lib/hulu-ad.ts` の BLOCKED_SERVICES と同じ判断）。
 */
const HULU_BLOCKED = ['disney-plus', 'disney+', 'disneyplus']

/**
 * 広告を置かない節の見出し。**まとめは記事の締めで、広告の場所ではない。**
 *
 * ★ **部分一致にしないこと。** 「…がまとめて配信開始」というふつうの節の見出しに
 *   当たってしまい、その節が広告の対象から外れる（2026-09-19 に踏んだ）。
 */
const CLOSING_HEADING = /^まとめ/

function el(tagName: string, properties: Record<string, unknown>, children: Node[] = []): Node {
  return { type: 'element', tagName, properties, children }
}

function text(value: string): Node {
  return { type: 'text', value }
}

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function findAll(node: Node, match: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (match(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, match, out)
  return out
}

function bannerSize(raw: string | undefined): { width: number; height: number } {
  const m = /^(\d{1,4})x(\d{1,4})$/.exec((raw ?? '').trim())
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 320, height: 50 }
}

/**
 * afb のリンクコードに枠（`id1`）を足す。
 * ★ `id1` を .env のリンクに自分で書かないこと（ここが付けるので二重になる）。
 */
function withSlot(href: string, slot: string): string {
  try {
    const u = new URL(href)
    u.searchParams.set('id1', slot)
    return u.toString()
  } catch {
    // 貼り間違いで URL として読めない形。壊すより、そのまま返して検査に見つけさせる
    return href
  }
}

/**
 * Amazonプライムの無料体験の枠。**出せないときは undefined。**
 *
 * ★ **枠の中に文字を1つも足さない**（`components/AmazonBanner.astro` の規律）。
 *   中にあるのは広告主が作った絵だけで、当サイトの説明文は置かない。
 *   「PR」表記はページ冒頭の `AffiliateNotice` が担っている。
 * ★ `alt` も**バナーが何の広告かだけ**を言う。
 */
function primeBlock(tag: string | undefined): Node | undefined {
  if (!tag) return undefined
  const wide = publicImageSize(AMAZON_BANNER)
  if (!wide) return undefined

  const spSrc = AMAZON_SP_CANDIDATES.find((path) => publicImageSize(path) !== null)
  const sp = spSrc ? publicImageSize(spSrc) : null

  /*
   * ★ `<picture>` は**スマホ用の原稿があるときだけ**。
   *   `<source>` は上から順に見て最初に当たったものが使われるので、
   *   広い画面の条件を先に書き、`<img>` を狭い画面の既定にする。
   *   `<source>` にも width / height を書かないと、切り替わったときに絵が伸びる。
   */
  const picture: Node =
    sp && spSrc
      ? el('picture', {}, [
          el('source', {
            media: `(min-width: ${SP_MAX})`,
            srcset: AMAZON_BANNER,
            width: wide.width,
            height: wide.height,
          }),
          el('img', {
            src: spSrc,
            width: sp.width,
            height: sp.height,
            alt: AMAZON_BANNER_ALT,
            decoding: 'async',
            loading: 'lazy',
          }),
        ])
      : el('img', {
          src: AMAZON_BANNER,
          width: wide.width,
          height: wide.height,
          alt: AMAZON_BANNER_ALT,
          decoding: 'async',
          loading: 'lazy',
        })

  /*
   * 🔴 **`primeTrialUrl`（/amazonprime）を使う。** ストアフロントではない。
   *   無料体験の固定報酬は、このURLを経由した場合だけ成果になる
   *   （`lib/affiliate.ts`。Amazon 公式が明記している）。
   * ★ 枠名は `prime`。**他の Amazon の枠と混ぜないこと**（成果の種類が違う）。
   */
  return el('div', { className: ['section-ad'], 'data-ad': 'prime' }, [
    el(
      'a',
      /*
       * ★ **`prime-ad-link` が枠名の目印。** `rehype-affiliate.ts` の `slotOf()` が
       *   これを見て `data-slot="prime"` にし、トラッキングIDも prime のものに差し替える。
       *   **クラス名を変えるなら、あちらも直すこと**（黙って `body` の枠に混ざる）。
       */
      { href: primeTrialUrl(tag), className: ['section-ad-link', 'prime-ad-link'] },
      [picture],
    ),
  ])
}

/** Hulu（afb）の枠。**リンクコードが未設定なら undefined** */
function huluBlock(creative: HuluCreative | undefined): Node | undefined {
  if (!creative?.lp) return undefined

  const slot = 'body'
  const href = withSlot(creative.lp, slot)
  const inner: Node[] = creative.banner
    ? [
        el('img', {
          src: creative.banner,
          alt: HULU_BANNER_ALT,
          loading: 'lazy',
          ...bannerSize(creative.bannerSize),
        }),
      ]
    : [text(HULU_ACTION)]

  const children: Node[] = [
    el('a', { href, className: ['section-ad-link', 'hulu-ad-link'] }, inner),
  ]
  /*
   * ★ 表示計測の1x1は**リンクコードの一部**なので、付いてきたら一緒に出す
   *   （`lib/hulu-ad.ts`）。本番ビルドでだけ渡ってくる。
   */
  if (creative.impression) {
    children.push(
      el('img', { src: creative.impression, alt: '', width: 1, height: 1, loading: 'lazy' }),
    )
  }
  return el('div', { className: ['section-ad'], 'data-ad': 'hulu' }, children)
}

/** 記事の方向。終了系なら `leaving`、開始系なら `arrivals` */
function directionOf(category: string): 'leaving' | 'arrivals' {
  return category === 'arrivals' ? 'arrivals' : 'leaving'
}

/**
 * 表のサービス列から、いちばん多い1社のキーを返す。
 * **カレンダーを持たない社しか無い記事では undefined**（何も差し込まない）。
 */
function mainService(tables: Node[]): string | undefined {
  const count = new Map<string, number>()
  for (const table of tables) {
    for (const row of findAll(table, (n) => n.tagName === 'tr')) {
      for (const cell of row.children ?? []) {
        if (cell.tagName !== 'td') continue
        const key = SERVICE_BY_LABEL.get(textOf(cell).trim())
        if (key && hasCalendar(key)) count.set(key, (count.get(key) ?? 0) + 1)
      }
    }
  }
  let best: string | undefined
  for (const [key, n] of count) {
    if (best === undefined || n > (count.get(best) ?? 0)) best = key
  }
  return best
}

/**
 * 配信カレンダーへの導線。**画像つき作品リンクと同じ見た目の枠**にする
 * （2026-09-19・運用者の指定）。
 *
 * ★ **行き先は記事と同じ軸。** 終了予定の記事から新着カレンダーへ送ると、
 *   読者が探していたものと違うページに着く。
 */
function calendarBlock(direction: 'leaving' | 'arrivals', service: string, label: string): Node {
  const verb = direction === 'leaving' ? '終了予定' : '新着'
  return el('div', { className: ['section-calendar'] }, [
    el(
      'a',
      { href: `/${direction}/${service}`, className: ['section-calendar-link'] },
      [
        el('span', { className: ['section-calendar-label'] }, [
          text(`${label}の見放題${verb}カレンダー`),
        ]),
        el('span', { className: ['section-calendar-note'] }, [
          text('日付ごとに全作品を見る'),
        ]),
      ],
    ),
  ])
}

/** 記事が扱っているサービス（frontmatter の tags）。Hulu の掲載可否に要る */
function servicesOf(tags: string[]): string[] {
  return tags.map((t) => SERVICE_BY_LABEL.get(t) ?? t.toLowerCase())
}

export function rehypeSectionAds(options: SectionAdsOptions = {}) {
  return (tree: Node, file: VFile): void => {
    const children = tree.children
    if (!children) return

    // `##` の節の開始位置。新テンプレは「小段落1・小段落2・まとめ」の3つ
    const headings = children
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.tagName === 'h2')
    if (headings.length === 0) return

    /*
     * ★ **「まとめ」は広告を置く節ではない。**
     *   小段落が1つしか無い記事（シリーズ記事に多い）では、まとめを除くと
     *   広告の置き場所も1つになる。**除かないと記事の末尾、出典の直前に出る。**
     */
    const contentHeadings = headings.filter(({ n }) => !CLOSING_HEADING.test(textOf(n)))
    if (contentHeadings.length === 0) return

    const path = file.path ?? file.history?.[0] ?? ''
    const slug = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') ?? ''
    const post = slug ? postBySlug(slug) : undefined

    /*
     * Hulu を出してよい面か。**判定は `AfbCta.astro` と同じ2つ**。
     *   1. 扱っているサービスに Disney+ が無いこと
     *   2. ページの文字列に掲載NG（TBS作品・ディズニー作品）が無いこと
     *
     * 🔴 **`huluNgHitsIn` に渡す文字列は改行で繋ぐこと。** スペースで繋ぐと
     *    1件も当たらずに素通りする（docs/AFFILIATE.md・過去に踏んでいる）。
     */
    const services = servicesOf(post?.tags ?? [])
    const pageText = [post?.title ?? '', textOf(tree)].join('\n')
    const huluOk =
      !services.some((s) => HULU_BLOCKED.includes(s)) && huluNgHitsIn(pageText).length === 0

    /*
     * この枠に出すもの。**優先順位は Prime Video の記事 → Hulu → Amazon**（冒頭の■）。
     *
     * ★ **1番目と3番目は同じ原稿・同じリンク。** 違うのは順番だけで、
     *   Prime Video 主題の「まだ観られる」記事でだけ Hulu より先に出る。
     *   その判定は `lib/prime-ad.ts` が持っている（**ここに条件を写さないこと**）。
     */
    const primeFirst =
      primeAdWithTag(options.primeTag ?? '', {
        tags: post?.tags,
        category: post?.category as PrimeAdInput['category'],
      }) !== null
    const block = primeFirst
      ? primeBlock(options.primeTag)
      : ((huluOk ? huluBlock(options.hulu) : undefined) ?? primeBlock(options.primeTag))

    /*
     * ★ **節の終わりに差し込む。** 次の `##` の直前（最後の節なら末尾）。
     *   後ろから入れるので、先に入れた分で添字がずれない。
     */
    const spots: { at: number; kind: 'ad' | 'calendar' }[] = []

    // 広告は小段落1と小段落2の直下（**まとめの節には置かない**）
    for (const h of contentHeadings.slice(0, 2)) {
      const next = headings.find((x) => x.i > h.i)
      spots.push({ at: next ? next.i : children.length, kind: 'ad' })
    }

    /*
     * カレンダーは**小段落2の表の直下**。
     * ★ 表が無ければ差し込まない（行き先を決める材料もそこにあるため）。
     */
    const second = contentHeadings[1]
    const secondStart = second ? second.i : -1
    const secondEnd = second
      ? (headings.find((x) => x.i > second.i)?.i ?? children.length)
      : -1
    const tableIndex = children.findIndex(
      (n, i) => i > secondStart && i < secondEnd && n.tagName === 'table',
    )
    if (second && tableIndex >= 0) spots.push({ at: tableIndex + 1, kind: 'calendar' })

    const tables = findAll(tree, (n) => n.tagName === 'table')
    const service = mainService(tables)
    const label = post?.tags.find((t) => SERVICE_BY_LABEL.get(t) === service)

    for (const spot of [...spots].sort((a, b) => b.at - a.at)) {
      if (spot.kind === 'ad') {
        // ★ 同じノードを2か所に入れない（HAST は木なので使い回すと片方が壊れる）
        if (block) children.splice(spot.at, 0, structuredClone(block))
        continue
      }
      if (!service || !label || !post) continue
      children.splice(spot.at, 0, calendarBlock(directionOf(post.category), service, label))
    }
  }
}

export default rehypeSectionAds
