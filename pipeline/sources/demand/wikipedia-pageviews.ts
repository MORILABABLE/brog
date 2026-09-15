/**
 * 日本語版 Wikipedia の「その日よく読まれた記事」top 1000 を取る。
 *
 * ■ 何のために使うか
 * **いま話題になっている作品を見つけるため。** 当サイトの在庫（観測）は
 * 「何が終わるか」は知っているが、「いま何が読まれているか」を知らない。
 * 主題を選ぶのが人の仕事である以上（docs/KEYWORDS.md 3-3）、
 * **人が選ぶための候補には外の需要が要る。**
 *
 * ■ なぜ Wikipedia なのか
 *   - 公式API・無料・キー不要。日次で top 1000 まで返る
 *   - **過去日をいつでも取り直せる**（下の「貯め方」に効く）
 *   - 作品・人物・出来事が同じ土俵に並ぶので、**在庫と突き合わせるだけで
 *     「映像作品の話題」だけが残る**（判定を自前で書かなくてよい）
 *
 * ★ **検索ボリュームではない。** 分かるのは「その記事が読まれた」ことだけ。
 *   docs/KEYWORDS.md がサジェストについて書いている区別と同じで、
 *   ここも「需要の向きの手がかり」として扱い、数字を記事に書かない。
 *
 * ■ 貯め方（`pipeline/core/demand-store.ts` と対で読むこと）
 * **この取得元だけは貯めなくても復元できる。** 何年前の日付でも同じAPIで返るので、
 * 在庫に当たらなかった999件を抱え込む理由がない（1日1000行＝月3.6MB）。
 * 貯めるのは**在庫に当たった語だけ**にしてある。
 * 一方 Google Trends は当日ぶんしか返らないので、あちらは全行を貯める。
 *
 * ■ 日付
 * 集計は **UTC 日**。JST の「今日」を投げると、まだ集計が終わっていない。
 * 既定で2日前から遡るのはそのため（実測で前日ぶんは返らないことがある）。
 */
import type { DemandSignal } from './types.ts'

/** Wikimedia は連絡先の分かる User-Agent を求めている（wikipedia.ts と同じ名乗り） */
const USER_AGENT = 'brog/0.1 (streaming blog research; contact via repository)'

const API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top'

/** 同じホストへの連続取得の間隔。7日ぶんでも十数秒で終わる。**下げないこと。** */
export const MIN_INTERVAL_MS = 1_000

const FETCH_TIMEOUT_MS = 15_000

/**
 * 数えない記事。**特別ページと入口ページ**で、作品の話題ではない。
 * `特別:` で始まるものは全部落とす（検索・最近の更新など）。
 */
const IGNORED = /^(メインページ|特別:|Wikipedia:|ヘルプ:|Portal:|Template:|カテゴリ:)/

interface TopResponse {
  items?: { articles?: { article: string; views: number; rank: number }[] }[]
}

/** UTC の日付を `YYYY-MM-DD` で返す */
export function utcDay(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/**
 * 記事名 → 突き合わせに使う語。
 *
 * `オデュッセイア_(映画)` → `オデュッセイア`
 * `ONE_PIECE` → `ONE PIECE`
 *
 * ★ **曖昧さ回避の括弧を落とすのは、在庫の題名に括弧が無いから。**
 *   落とした結果が一般名詞になることがある（`ひまわり_(映画)` → `ひまわり`）。
 *   そこは突き合わせ側（`demand-match.ts`）の仕事で、ここでは判定しない。
 */
export function articleToWord(article: string): string {
  return article.replace(/_/g, ' ').replace(/\s*\(.*?\)$/, '').trim()
}

/** 1日ぶんの top を取る。その日のデータが無ければ空配列（**失敗にしない**）。 */
export async function fetchTopPageviews(day: string): Promise<DemandSignal[]> {
  const [y, m, d] = day.split('-')
  const url = `${API}/ja.wikipedia/all-access/${y}/${m}/${d}`

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  // まだ集計されていない日は 404。**その日が無いだけなので落とさない。**
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Wikipedia pageviews が ${res.status} を返しました (${day})`)

  const json = (await res.json()) as TopResponse
  const articles = json.items?.[0]?.articles ?? []
  const fetchedAt = new Date().toISOString()

  const out: DemandSignal[] = []
  for (const a of articles) {
    if (IGNORED.test(a.article)) continue
    const word = articleToWord(a.article)
    if (!word) continue
    out.push({
      source: 'wikipedia-pageviews',
      word,
      raw: a.article,
      day,
      count: a.views,
      rank: a.rank,
      fetchedAt,
    })
  }
  return out
}

/**
 * **1つの記事の日次推移**を取る（top 1000 に入らない語も追える）。
 *
 * ■ 何のためにあるか — 第二波の観測（2026-09-15）
 * `/posts/harry-potter` は9/2〜9/12に流入が集中し、**9/13以降ゼロ**になった。
 * だが需要そのものは消えていない。この口で実測すると、
 * 「ハリー・ポッターシリーズ」は**1日1,400〜1,800回で横ばい**で、
 * 9/3〜9/6 に2,300の小さな山があっただけだった。
 *
 *   → 落ちたのは**「配信終了」というニュースの語**であって、作品への関心ではない。
 *
 * **終了日（9/30）の直前にもう一度山が来るのか**は、まだ誰も知らない。
 * 来るなら「期限前に書き直す」運用に意味があり、来ないなら無い。
 * **測らずに決めないために、この口を用意しておく。**
 *
 * ■ 記事名は人が渡す
 * 作品名と Wikipedia の記事名は一致しないことがある
 * （`ハリー・ポッターと賢者の石` は記事だが、`ハリー・ポッター` は曖昧さ回避）。
 * **機械で解決しない。** 当たらなければ0件を返す。
 *
 * @param article 日本語版 Wikipedia の記事名
 * @param days 何日ぶん遡るか
 */
export async function fetchArticleTrend(
  article: string,
  days: number,
): Promise<{ day: string; views: number }[]> {
  const compact = (daysAgo: number) => utcDay(daysAgo).replace(/-/g, '')
  const url =
    `${API.replace('/top', '/per-article')}/ja.wikipedia/all-access/user/` +
    `${encodeURIComponent(article)}/daily/${compact(days + 1)}/${compact(1)}`

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  // 記事名が違う・その期間のデータが無いときは 404。**失敗にしない**
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Wikipedia pageviews が ${res.status} を返しました (${article})`)

  const json = (await res.json()) as { items?: { timestamp: string; views: number }[] }
  return (json.items ?? []).map((i) => ({
    // `2026091300` → `2026-09-13`
    day: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`,
    views: i.views,
  }))
}

/**
 * 直近の数日ぶんをまとめて取る。
 *
 * @param days 何日ぶん遡るか
 * @param skipRecent 何日前から始めるか（既定2日前。UTC集計の遅れを避ける）
 */
export async function fetchRecentPageviews(
  days: number,
  skipRecent = 2,
  onDay?: (day: string, count: number) => void,
): Promise<DemandSignal[]> {
  const out: DemandSignal[] = []
  for (let i = 0; i < days; i++) {
    const day = utcDay(skipRecent + i)
    const rows = await fetchTopPageviews(day)
    onDay?.(day, rows.length)
    out.push(...rows)
    if (i < days - 1) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS))
  }
  return out
}
