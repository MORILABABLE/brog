/**
 * 常設ページのデータ読み込み。**ビルド時にだけ動く。**
 *
 * ■ なぜ記事ではなくページなのか
 * 月次記事は公開時点のスナップショットで、月をまたぐと古くなる。
 * 常設ページはURLが固定で、`collect` のたびに中身だけが入れ替わる。
 * 被リンクと検索評価が1つのURLに集中するので、
 * 「netflix 配信終了予定」のような**継続的な需要**に当てるならこちらが向く。
 *
 * ■ LLMを使わない
 * 出すのは「作品名・日付・評価」という事実だけなので文章生成が要らない。
 * 生成コストゼロ、誤情報のリスクもゼロ。品質ゲートを通す必要もない。
 *
 * ■ データの出どころ
 * リポジトリ直下の `data/events/*.jsonl`（パイプラインの収集結果）を直接読む。
 * Cloudflare Pages はリポジトリ全体をクローンしてから `site/` に降りるので、
 * ビルド時に到達できる。**`site/` を単体で別の場所に移すと壊れる。**
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isPublishable } from './excluded'

/** サイトの基準タイムゾーン。theme.yaml の utc_offset_minutes と揃える。 */
const JST_OFFSET_MINUTES = 9 * 60

/**
 * `data/events` を探す。
 *
 * ★ `import.meta.url` からの相対解決は使えない。
 *   Astro はビルド時にこのファイルを `dist/.prerender/chunks/` へバンドルするので、
 *   `import.meta.url` はソースではなくチャンクの位置を指す（実際に踏んだ）。
 *   代わりに実行時のカレントから上へ辿る。
 */
function findEventsDir(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'data', 'events')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 収集データ1件。**JSONの構造そのまま。**
 *
 * ★ 常設ページ（このファイル）が使うのは一部だけだが、
 *   作品ページ（lib/works.ts）は `meta` や `genres` まで使う。
 *   読み込みを2か所に増やさないため、**型はJSONの全体を書いておき、
 *   使う側が必要な分だけ触る**という形にしてある。
 */
export interface RawWork {
  id: number | string
  title: string
  localizedTitle?: string
  /** 原語表記。**日本の作品は日本語のまま返る**（readAll の邦題の補完で使う） */
  originalTitle?: string
  type?: string
  year?: number
  rating?: number
  overview?: string
  genres?: string[]
  posterUrl?: string
  link?: string
  /** 配信API由来のみ。Wikidata の突き合わせキーになる（lib/works.ts） */
  meta?: { imdbId?: string; tmdbId?: string; [k: string]: unknown }
}

export interface RawEvent {
  collectedAt: string
  service: string
  kind: string
  at?: string
  work: RawWork
}

/**
 * 収集対象のサービス（**配信API由来の4社**）。
 *
 * ★ **U-NEXT を入れてはいけない。**
 *   U-NEXT は API の外側にあり、データ利用について規約に明言が無い。
 *   作品ページ（lib/works.ts）はこの一覧で対象を絞っている。
 *   判断の理由は docs/GROWTH.md 2-3。**ここに1行足すと作品ページが公開される。**
 */
export const API_SERVICES = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'disney-plus', label: 'Disney+' },
  { key: 'apple-tv', label: 'Apple TV+' },
] as const

/** サービスキー → 表示名。作品ページの表で使う。 */
export const LABEL_BY_SERVICE = new Map<string, string>(
  API_SERVICES.map((s) => [s.key, s.label] as [string, string]),
)

/** ひらがな・カタカナ。日本語にしか無い文字なので、原語表記が日本語かの判定に使う。 */
const KANA = /[ぁ-んァ-ヶ]/

let cached: RawEvent[] | null = null

function readAll(): RawEvent[] {
  if (cached) return cached
  const dir = findEventsDir()
  if (!dir) {
    // 収集前・パスがずれた場合。空のページを黙って出すよりビルドを止める。
    throw new Error(
      `収集データ（data/events）が見つかりません。探した起点: ${process.cwd()}\n` +
        '  npm run collect を実行済みか、site/ をリポジトリの外に移していないか確認する。',
    )
  }
  const out: RawEvent[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      const e = JSON.parse(s) as RawEvent
      // ★ 邦題が取れていない作品に原語表記を充てる。
      //   規則は pipeline/core/events.ts の withJapaneseTitle と同じで、
      //   **かなを含むもの（＝日本語だと確かなもの）だけ**。
      //   片方だけ変えると、記事とサイトで題名が食い違う。
      if (!e.work.localizedTitle && e.work.originalTitle && KANA.test(e.work.originalTitle)) {
        e.work.localizedTitle = e.work.originalTitle.replace(/ {2,}/g, ' ').trim()
      }
      // ★ 出さないと決めた作品はここで落とす（data/excluded-works.json）。
      //   読み込みの1か所で外すので、常設ページも定点観測も自動的に揃う。
      if (isPublishable(e.work.id)) out.push(e)
    }
  }
  cached = out
  return out
}

/**
 * 収集データ全件（**出さないと決めた作品を除いたもの**）。
 *
 * ★ 作品ページ（lib/works.ts）のための口。**読み込みを2か所に増やさないために公開している。**
 *   `data/events` の場所探し・壊れた行の扱い・除外の適用が
 *   ここ1か所にしか無い状態を保つこと。
 */
export function loadAllEvents(): RawEvent[] {
  return readAll()
}

/** JST の年月（`YYYY-MM`）。UTC で切ると9時間ぶんが前月に落ちる。 */
function jstMonth(iso: string): string {
  return new Date(Date.parse(iso) + JST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 7)
}

/** JST の暦日（`YYYY-MM-DD`）。 */
function jstDay(iso: string): string {
  return new Date(Date.parse(iso) + JST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10)
}

// --- 作品 -----------------------------------------------------------------

export interface WorkRow {
  workId: string
  title: string
  /** 邦題が原題と違うときだけ入る。同じなら undefined。 */
  originalTitle?: string
  year?: number
  rating?: number
  at: Date
}

function toRow(e: RawEvent): WorkRow {
  return {
    workId: String(e.work.id),
    title: e.work.localizedTitle ?? e.work.title,
    // ★ Wikidata の日本語ラベルが原題と同一のことがある（例: Article 15）。
    //   そのまま出すと「Article 15（原題: Article 15）」になるので、違うときだけ出す。
    originalTitle:
      e.work.localizedTitle && e.work.localizedTitle !== e.work.title ? e.work.title : undefined,
    year: e.work.year || undefined,
    // rating は 0 が「評価なし」を意味する。0 のまま出すと最低評価に見える。
    rating: e.work.rating ? e.work.rating : undefined,
    at: new Date(e.at as string),
  }
}

/**
 * 同じ作品が複数回収集されている。**最後に観測した内容を採る。**
 * 終了日が後から変わることがあるので、古い方を残すと誤情報になる。
 */
function latestPerWork(events: RawEvent[]): RawEvent[] {
  const map = new Map<string, RawEvent>()
  for (const e of events) {
    const key = String(e.work.id)
    const cur = map.get(key)
    if (!cur || e.collectedAt > cur.collectedAt) map.set(key, e)
  }
  return [...map.values()]
}

function asOf(events: RawEvent[]): Date | null {
  const max = events.reduce<string | null>(
    (m, e) => (m === null || e.collectedAt > m ? e.collectedAt : m),
    null,
  )
  return max ? new Date(max) : null
}

export interface WorkListData {
  works: WorkRow[]
  /** データの基準日（収集した最も新しい時刻）。配信状況は変わるので必ず表示する。 */
  dataAsOf: Date | null
}

// --- 配信終了予定 -----------------------------------------------------------

/**
 * 常設ページを作るサービス（配信終了予定）。
 *
 * ★ theme-packs/streaming-jp/article-types/leaving.ts の SERVICE_VARIANTS と揃えること。
 *   実測（2026-08・1,089件）で expiring を返したのは Netflix と Prime Video の2社だけ。
 *   Disney+ / Apple TV+ は0件だった。
 */
export const LEAVING_SERVICES = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
] as const

/**
 * 指定サービスで「これから終了する」作品を、**終了日の遅い順**に返す。
 *
 * ★ 2026-08-31 に早い順（＝古い順）から入れ替えた。
 *   このサイトの終了予定は月末に集中する（U-NEXT は告知が4週間先までで、
 *   Prime Video は終了の約11日前にしか出ない）。早い順にすると、
 *   いちばん本数の多い月末の束が毎回いちばん下に落ちて、
 *   一覧を開いた読者が最初に見るのは**数本しかない直近の日**になっていた。
 *
 * ★ **新着配信（`loadArrivals`）とは向きが揃わなくなった。** 揃えるために
 *   どちらかを戻さないこと。並びの根拠が「上から時間が進む」ではなく
 *   「先に見せたい束を上に置く」に変わっており、
 *   何が先に来てほしいかは2つのページで違う。
 *   ページ側の説明文（pages/leaving/[service].astro）も**必ず一緒に直すこと。**
 */
export function loadLeaving(service: string): WorkListData {
  const now = Date.now()
  // ★ 「これから」の判定は絶対時刻の比較なのでタイムゾーンに依存しない。
  //   表示のときだけ JST に寄せる。
  const events = readAll().filter(
    (e) => e.kind === 'expiring' && e.service === service && e.at && Date.parse(e.at) >= now,
  )
  const latest = latestPerWork(events)
  return {
    works: latest
      .map(toRow)
      // 日付は遅い順、同じ日のなかは題名順（題名だけは昇順のまま）
      .sort((a, b) => b.at.getTime() - a.at.getTime() || a.title.localeCompare(b.title, 'ja')),
    dataAsOf: asOf(latest),
  }
}

// --- 新着配信 ---------------------------------------------------------------

/**
 * 常設ページを作るサービス（新着配信）。
 *
 * ★ Apple TV+ は入れていない。収集期間を通して `new` が**1件しかなかった**ため。
 *   1件だけのページは薄いページの量産になり、検索評価とAdSense審査の両方で不利。
 *   件数が増えたらここに足す。
 */
export const ARRIVALS_SERVICES = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'disney-plus', label: 'Disney+' },
] as const

/** 新着として載せる期間。これより古いものは「新着」と呼べない。 */
const ARRIVALS_WINDOW_DAYS = 60

/**
 * 指定サービスで最近見放題に入った作品を、**配信開始日の古い順**に返す。
 *
 * ★ 2026-08-27 に新しい順から入れ替えた。
 *   ページは「直近◯日間に入った作品」を頭から順に読ませる作りで、
 *   新しい順だと表が「今日 → さかのぼる」向きになり、
 *   説明文（配信開始日順にまとめています）と読み口が食い違っていた。
 *   ★ 2026-08-31 に終了予定ページ（`loadLeaving`）を遅い順へ変えたので、
 *   **2つのページで向きは揃っていない。** ここを揃えるために引きずられないこと。
 *   このページは「直近◯日間に入った作品」を頭から読ませる作りなので、
 *   古い順のままでよい（説明文とも合っている）。
 */
export function loadArrivals(service: string): WorkListData {
  const since = Date.now() - ARRIVALS_WINDOW_DAYS * 86400000
  const events = readAll().filter(
    (e) => e.kind === 'new' && e.service === service && e.at && Date.parse(e.at) >= since,
  )
  const latest = latestPerWork(events)
  return {
    works: latest
      .map(toRow)
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.title.localeCompare(b.title, 'ja')),
    dataAsOf: asOf(latest),
  }
}

export { ARRIVALS_WINDOW_DAYS }

// --- 定点観測（月次の出入り） -------------------------------------------------

export interface ServiceMonthStat {
  service: string
  label: string
  added: number
  removed: number
}

export interface MonthStat {
  /** `YYYY-MM` */
  month: string
  services: ServiceMonthStat[]
  addedTotal: number
  removedTotal: number
  /** その月がまだ終わっていない（＝数字が増える途中） */
  inProgress: boolean
}

/**
 * 定点観測に出すサービス。収集対象の4社すべて。
 *
 * ★ 上の `API_SERVICES` と**同じ一覧を指している**（2026-08-27 に統合）。
 *   同じ4社を2か所に書いていて、片方だけ増やす事故があり得たため。
 *   定点観測だけ対象を変えたくなったら、ここで別の配列に戻せばよい。
 */
const STAT_SERVICES = API_SERVICES

export interface StatsData {
  months: MonthStat[]
  /** 収集を始めた日。これ以前の月は数字が不完全なので出さない。 */
  collectStart: Date | null
  dataAsOf: Date | null
}

/**
 * 月ごとの「増えた数・減った数」。
 *
 * ★ 収集を始めた月より前は出さない。
 *   収集開始前に起きた出入りは観測できていないので、
 *   「7月の追加は12件」と書くと**嘘になる**（実際は12件しか捕まえていないだけ）。
 *   このサイトが持つ数字は「観測できた数」であって「起きた数」ではない、
 *   という区別をページ側でも明示すること。
 */
export function loadMonthlyStats(): StatsData {
  const all = readAll()
  if (all.length === 0) return { months: [], collectStart: null, dataAsOf: null }

  const startIso = all.reduce((m, e) => (e.collectedAt < m ? e.collectedAt : m), all[0]!.collectedAt)
  const startMonth = jstMonth(startIso)
  const nowMonth = jstMonth(new Date().toISOString())

  const dated = all.filter((e) => e.at && (e.kind === 'new' || e.kind === 'removed'))
  const months = [...new Set(dated.map((e) => jstMonth(e.at!)))]
    .filter((m) => m >= startMonth)
    .sort()
    .reverse()

  const stats: MonthStat[] = months.map((month) => {
    const services = STAT_SERVICES.map((s) => {
      const count = (kind: string) =>
        new Set(
          dated
            .filter((e) => e.kind === kind && e.service === s.key && jstMonth(e.at!) === month)
            .map((e) => String(e.work.id)),
        ).size
      return { service: s.key, label: s.label, added: count('new'), removed: count('removed') }
    })
    return {
      month,
      services,
      addedTotal: services.reduce((n, s) => n + s.added, 0),
      removedTotal: services.reduce((n, s) => n + s.removed, 0),
      inProgress: month >= nowMonth,
    }
  })

  return { months: stats, collectStart: new Date(startIso), dataAsOf: asOf(all) }
}

// --- 表示用 -----------------------------------------------------------------

/** 日付ごとにまとめる。表示は日付単位のほうが読みやすい。 */
export function groupByDate(works: WorkRow[]): { date: Date; works: WorkRow[] }[] {
  const map = new Map<string, WorkRow[]>()
  for (const w of works) {
    const key = jstDay(w.at.toISOString())
    ;(map.get(key) ?? map.set(key, []).get(key)!).push(w)
  }
  // works の並び順（呼び出し側が決めた順）を保つ
  const order = [...map.keys()]
  return order.map((k) => ({ date: map.get(k)![0]!.at, works: map.get(k)! }))
}

/** `YYYY-MM` を「2026年8月」にする */
export function formatMonth(month: string): string {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}
