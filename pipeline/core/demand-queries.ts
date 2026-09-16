/**
 * **Search Console の検索語を、3つ目の需要の取得元にする。**
 *
 * ■ なぜ足したか（2026-09-16・実測）
 * Wikipedia とトレンドだけを見ていたとき、**当サイトで最大の需要が候補に一度も出なかった。**
 *
 *   「五等分の花嫁 netflix 配信終了」（表記ゆれ4語の合計）
 *     表示 232 ・ クリック 1 ・ 平均 10.1位 ← **サイト全体の表示の8%を1作品が占める**
 *     `data/events` には観測がある（netflix・2026-09-09 に removed）
 *
 * 答えを持っているのに10位で、誰も踏んでいない。それでも候補に出なかったのは、
 * この作品が Wikipedia の日次 top 1000 に入らないからで、**需要が無いからではない。**
 *
 * 逆向きのずれも出ている。Wikipedia 最大の `VIVANT 45,561` は
 * docs/DEMAND.md 7節★が自分で疑っているとおり**地上波の再放送**由来の可能性が高い。
 *
 * **Wikipedia は「世の中で何が読まれているか」、ここは「当サイトが何で見られているか」。**
 * 後者のほうが主題選びの当たりが高い。実測で 6〜20位・表示3以上が
 * **41語・549表示（サイト全体の19%）でクリック6**。順位を1つ上げれば取れる需要がここにある。
 *
 * ■ 課金なし・新しい取得口も無し
 * 読むのは `data/search-queries.json` だけ。**取り込みは既にある**
 * （`pipeline/cli/queries.ts` ／ 週1回の `.github/workflows/queries.yml`）。
 * このファイルは1行もネットワークを触らない。
 *
 * ■ 語の取り出し方 —「検索語の中から在庫の題名を探す」
 * 他の2つと向きが逆になる。あちらは**語が来て在庫に当てる**が、
 * 検索語は `五等分の花嫁 netflix 配信終了` のように**題名＋意図語**の並びなので、
 * そのまま `matchDemand()` に渡しても在庫に当たらない
 * （あちらの前方一致は「語のほうが在庫より短いとき」しか見ない。理由は `demand-match.ts`）。
 *
 * だからここで先に題名を取り出して、**題名を `word` として渡す。**
 * 読者が実際に打った語は `raw` に残す（運用者が語形を見るため。下の★）。
 *
 * ★ **いちばん長い題名を採る。** `ONE PIECE` と `ONE PIECE FILM RED` の
 *   両方が検索語に含まれるとき、短いほうを採ると**別の作品の終了日を答える**ことになる。
 *   （`demand-match.ts` の前方一致が逆向きを許さないのと同じ理由）
 *
 * ★ **語ごとに1行へ畳んでから返す。** 同じ作品が表記ゆれで4語に割れていることがあり
 *   （上の「五等分の花嫁」）、1語ずつ渡すと `matchDemand()` の
 *   `Math.max` 畳み込みで**いちばん大きい1語ぶんしか残らない。**
 *
 * 🔴 **`raw`（読者が打った語）をサイトに出さないこと。** 当サイトの観測ではないうえ、
 *   `五 等 分 の花嫁 netflix 配信 終了` のように分かち書きで返ることがある。
 *   使うのは運用者が見る一覧（CLI・Issue）までで、画面の文言は
 *   自前の観測（終了日・サービス）から組む。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DemandSignal } from '../sources/demand/types.ts'
import { MIN_WORD_LENGTH, normalizeTitle, type Inventory } from './demand-match.ts'

/** 取り込み済みの検索語。`pipeline/cli/queries.ts` が書く */
export const SEARCH_QUERIES_PATH = join('data', 'search-queries.json')

interface PageQuery {
  query: string
  clicks: number
  impressions: number
  position: number
}

interface SearchQueriesFile {
  fetchedAt: string
  range: { start: string; end: string }
  pages: Record<string, PageQuery[]>
}

/** 1語ぶんの集計。CLI と Issue が読む */
export interface SearchDemand {
  /** 在庫の題名（`word` として渡すもの） */
  title: string
  /** 28日の表示回数の合計 */
  impressions: number
  /** 同・クリックの合計 */
  clicks: number
  /** いちばん良かった（小さい）平均掲載順位 */
  position: number
  /** 読者が実際に打った語。表示の多い順・最大3本 */
  queries: string[]
}

export interface SearchConsoleReport {
  signals: DemandSignal[]
  /** 語ごとの集計（`signals` と1対1） */
  demands: SearchDemand[]
  /** 集計期間 */
  range: { start: string; end: string }
  /** 取り込んだ時刻 */
  fetchedAt: string
  /** 在庫の題名が1つも見つからなかった検索語の数 */
  unmatched: number
}

/** 読めなかったときに返す空の結果。**呼び出し側を分岐させない** */
const EMPTY: SearchConsoleReport = {
  signals: [],
  demands: [],
  range: { start: '', end: '' },
  fetchedAt: '',
  unmatched: 0,
}

/**
 * 検索語から需要の観測を組む。
 *
 * @param inventory `buildInventory()` の結果。**題名の辞書としてだけ使う**
 * @param path 既定は `data/search-queries.json`
 */
export function readSearchConsoleDemand(
  inventory: Inventory,
  path = SEARCH_QUERIES_PATH,
): SearchConsoleReport {
  let file: SearchQueriesFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as SearchQueriesFile
  } catch (err) {
    // 取り込み前（公開直後）は必ず無い。**無いことは異常ではない**
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
    throw err
  }
  if (!file.pages) return EMPTY

  /*
   * 題名の辞書。**長い順に並べる**（上の★）。
   * 4文字未満は引かない — `matchDemand()` が捨てる下限と揃える。
   * ここを緩めると `日常` `怪物` の類が検索語のどこにでも当たる
   * （site/src/lib/page-intent.ts の `MIN_TITLE_LEN` と同じ悩み）。
   */
  const keys: { key: string; title: string }[] = []
  for (const [key, works] of inventory.byTitle) {
    if (key.length < MIN_WORD_LENGTH) continue
    const title = works[0]?.title
    if (title) keys.push({ key, title })
  }
  keys.sort((a, b) => b.key.length - a.key.length)

  interface Bucket {
    title: string
    impressions: number
    clicks: number
    position: number
    queries: { query: string; impressions: number }[]
  }
  const buckets = new Map<string, Bucket>()
  let unmatched = 0

  for (const rows of Object.values(file.pages)) {
    for (const row of rows ?? []) {
      const normalized = normalizeTitle(row.query)
      if (!normalized) continue
      const hit = keys.find((k) => normalized.includes(k.key))
      if (!hit) {
        unmatched++
        continue
      }
      const b = buckets.get(hit.key)
      if (!b) {
        buckets.set(hit.key, {
          title: hit.title,
          impressions: row.impressions,
          clicks: row.clicks,
          position: row.position,
          queries: [{ query: row.query, impressions: row.impressions }],
        })
        continue
      }
      b.impressions += row.impressions
      b.clicks += row.clicks
      // **いちばん良かった順位**を持つ。平均を取り直すと、表示1件の外れ値で動く
      b.position = Math.min(b.position, row.position)
      b.queries.push({ query: row.query, impressions: row.impressions })
    }
  }

  const day = file.range?.end ?? ''
  const fetchedAt = file.fetchedAt ?? ''
  const demands: SearchDemand[] = []
  const signals: DemandSignal[] = []

  for (const b of [...buckets.values()].sort((a, c) => c.impressions - a.impressions)) {
    const queries = b.queries
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, 3)
      .map((q) => q.query)
    demands.push({
      title: b.title,
      impressions: b.impressions,
      clicks: b.clicks,
      position: Math.round(b.position * 10) / 10,
      queries,
    })
    signals.push({
      source: 'search-console',
      word: b.title,
      raw: queries[0] ?? b.title,
      day,
      count: b.impressions,
      searchPosition: Math.round(b.position * 10) / 10,
      searchClicks: b.clicks,
      fetchedAt,
    })
  }

  return { signals, demands, range: file.range ?? EMPTY.range, fetchedAt, unmatched }
}
