/**
 * 「このページの読者は、どの作品を探しているか」を1つ決める。
 *
 * ■ 何に使うか
 * Amazon 導線の検索語（AmazonCta.astro と FollowRail.astro）。
 * それまで、この2つは**ページに関係なく Prime Video の売り場トップ**へ送っていた。
 * 節ポスターと表は作品名を渡しているのに、いちばん目立つ2枠だけが
 * 「とりあえずAmazonへ」だったのを、ページの中身に合わせる。
 *
 * ■ 決め方（上から順に、決まった時点で止める）
 *
 *   1. Search Console の実測クエリ … そのURLに**実際に来ている検索語**
 *   2. シリーズ記事の主題         … 「ハリー・ポッター」など、記事タイトルの「」の中
 *   3. 決めない                   … 従来どおり売り場トップ（呼び出し側の既定）
 *
 * ★ **2 をシリーズ記事に限っているのは意図的。**
 *   月次の一覧記事（「U-NEXTで見放題終了する作品80本」）は主題が80個あり、
 *   最初の1本を主題として選ぶ根拠がどこにもない。実際に本文の先頭に来るのは
 *   「終了日がいちばん早い作品」で、記事の見どころとは別物だった（実測）。
 *   **主題が1つに決まる記事タイプはシリーズ記事しかない**ので、そこだけ使う。
 *   一覧記事は 1 が付くのを待つ（読者が実際に何を探しているかは検索語に出る）。
 *
 * ★ **1 を無条件には使わない。** 検索語は「u-next 配信終了 9月」のような
 *   意図語の並びであることが多く、そのまま Amazon 検索に渡すと 0件になる。
 *   **当サイトの台帳に実在する作品名を含む検索語だけ**を採用する（下の workTitleIn）。
 *   ここが緩いと、読者を空の検索結果に送って離脱させることになる。
 *
 * ■ なぜ「訪問者ごと」ではなく「ページごと」なのか
 * **検索エンジンは検索語をリファラに渡さない。** ブラウザが渡すのは
 * `https://www.google.com/` というオリジンだけで、いま来た読者が何で
 * 検索したかは原理的に取れない。取れるのはURL単位の統計だけ。
 * したがって出し分けはビルド時にページ単位で焼き込む形にしかならない。
 *
 * ★ 出し分けをサーバ側でリファラ判定してやらないこと（クローキングになる）。
 *   全員に同じHTMLを配る。ここはビルド時に1つ決めるだけなので、その心配がない。
 *
 * ■ データが無くても動く
 * data/search-queries.json が無ければ 2 に落ち、記事でなければ 3 に落ちる。
 * **公開直後は 1 が必ず空になる**（Search Console は反映に数日かかる）。
 * 取り込みは `npm run queries`（pipeline/cli/queries.ts）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getCollection } from 'astro:content'
import { normalizeForSearch } from './normalize'
import { SERIES_TAG } from './series-posts'
import { allWorkTitles } from './work-links'

interface PageQuery {
  query: string
  clicks: number
  impressions: number
}

interface SearchQueries {
  fetchedAt: string
  range: { start: string; end: string }
  pages: Record<string, PageQuery[]>
}

/**
 * 作品名として扱う最短の長さ（ならしたあとの文字数）。
 *
 * ★ 2文字まで許すと「日常」「怪物」のような題名が検索語のどこにでも当たり、
 *   関係のない作品ページへ読者を送ることになる。
 */
const MIN_TITLE_LEN = 3

/**
 * `data/search-queries.json` を探す。
 *
 * ★ `import.meta.url` からの相対解決は使えない。Astro はビルド時にこのファイルを
 *   チャンクへバンドルするので、位置がソースと変わる（work-links.ts と同じ事情）。
 */
function findUp(...segments: string[]): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

let queries: SearchQueries | null | undefined

function loadQueries(): SearchQueries | null {
  if (queries !== undefined) return queries
  const path = findUp('data', 'search-queries.json')
  if (!path) {
    queries = null
    return queries
  }
  try {
    queries = JSON.parse(readFileSync(path, 'utf8')) as SearchQueries
  } catch {
    // 壊れていてもページは出す。検索語が決まらないだけ。
    queries = null
  }
  return queries
}

let normalizedTitles: { title: string; norm: string }[] | null = null

/** 台帳の題名を1度だけならしておく。検索語1本ごとに全件ならすと重い。 */
function titleIndex(): { title: string; norm: string }[] {
  if (normalizedTitles) return normalizedTitles
  normalizedTitles = allWorkTitles()
    .map((title) => ({ title, norm: normalizeForSearch(title) }))
    .filter((t) => t.norm.length >= MIN_TITLE_LEN)
  return normalizedTitles
}

/**
 * 検索語の中に、台帳の作品名が入っていれば**その作品名**を返す。
 *
 * ★ 向きを固定する（検索語 ⊇ 作品名）。逆向き（作品名 ⊇ 検索語）を許すと、
 *   「るろうに」のような部分入力が長い題名に当たって、
 *   読者が打っていない作品を勝手に選ぶことになる。
 *
 * ★ 複数当たったら**いちばん長い題名**を採る。
 *   「ゴースト」と「ゴーストバスターズ」が両方当たる検索語では、
 *   長いほうが読者の打った語に近い。
 */
function workTitleIn(query: string): string | undefined {
  const q = normalizeForSearch(query)
  let best: { title: string; norm: string } | undefined
  for (const t of titleIndex()) {
    if (!q.includes(t.norm)) continue
    if (!best || t.norm.length > best.norm.length) best = t
  }
  return best?.title
}

/** そのパスに来ている検索語のうち、作品名に解決できた最初のもの。 */
function fromSearchConsole(pathname: string): string | undefined {
  const data = loadQueries()
  const rows = data?.pages[pathname]
  if (!rows) return undefined
  for (const row of rows) {
    const hit = workTitleIn(row.query)
    if (hit) return hit
  }
  return undefined
}

let seriesSubjects: Map<string, string> | null = null

/**
 * シリーズ記事のパス → その記事の主題（「ハリー・ポッター」など）。
 *
 * ■ どこから取るか
 * シリーズ記事のタイトルは `theme-packs/streaming-jp/article-types/series.ts` が
 * 「【保存版】「{主題}」シリーズの{動詞句}作品{本数}本｜{見どころ}」の形で書く。
 * **主題は必ず先頭の「」の中**にあり、そのまま Amazon の検索語になる
 * （実測: 名探偵コナン / ハリー・ポッター / トランスフォーマー / ウルトラマン）。
 *
 * ★ 作品名ではなく**シリーズ名**を採るのが要点。
 *   本文の最初のポスターが指す「ハリー・ポッターと賢者の石」に送ると、
 *   シリーズを見に来た読者を1作目に閉じ込めることになる。
 *
 * ★ 「」が無いタイトルは飛ばす。判定を緩めて記事タイトルの一部を機械的に
 *   切り出そうとしないこと（並び順は naming.md が決めていない。
 *   lib/series-posts.ts の railLabel の注意書きと同じ理由）。
 */
async function buildSeriesSubjects(): Promise<Map<string, string>> {
  if (seriesSubjects) return seriesSubjects
  const map = new Map<string, string>()
  for (const post of await getCollection('posts', ({ data }) => !data.draft)) {
    if (!post.data.tags.includes(SERIES_TAG)) continue
    const m = /[「『]([^」』]+)[」』]/.exec(post.data.title)
    if (m?.[1]) map.set(`/posts/${post.id}`, m[1].trim())
  }
  seriesSubjects = map
  return seriesSubjects
}

/**
 * このページの Amazon 導線に渡す検索語。決まらなければ undefined。
 *
 * @param pathname `Astro.url.pathname`。末尾スラッシュと .html は落として渡してよい
 */
export async function ctaQueryFor(pathname: string): Promise<string | undefined> {
  const path = pathname.replace(/\.html$/, '').replace(/(.)\/$/, '$1')
  return fromSearchConsole(path) ?? (await buildSeriesSubjects()).get(path)
}

/** テスト・再読込用 */
export function resetPageIntent(): void {
  queries = undefined
  normalizedTitles = null
  seriesSubjects = null
}
