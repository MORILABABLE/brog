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
import { fillJapaneseTitle } from './work-title'

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

let cached: RawEvent[] | null = null

/**
 * U-NEXT の作品台帳が持っている配信開始日（作品ID → ISO）。
 *
 * ★ 規則は pipeline/core/events.ts の withUnextStartDate と同じ。
 *   **片方だけ変えると、記事とサイトで配信開始日が食い違う。**
 *
 * 新着の日付は作品ページにしか無く、収集の予算を使い切ると日付なしで記録される。
 * イベントログは追記のみなので、あとから台帳(ledger)に弾かれて二度と付かない。
 * 日付は `unext:refresh` が台帳に書き込んでいるので、読み込み時にそこから写す。
 *
 * **開始日だけに限ること。** 終了日は延びも前倒しもするので台帳の値は使えない
 * （pipeline/sources/unext-store.ts 冒頭の決まり）。開始日は動かない過去の事実。
 */
function unextStartDates(dir: string): Map<string, string> {
  const path = join(resolve(dir, '..'), 'unext-titles.json')
  const map = new Map<string, string>()
  if (!existsSync(path)) return map
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      titles?: Record<string, { publicStartDate?: string }>
    }
    for (const [id, rec] of Object.entries(parsed.titles ?? {})) {
      if (rec?.publicStartDate) map.set(id, rec.publicStartDate)
    }
  } catch {
    // 台帳が壊れていても常設ページは出す（日付が付かないだけで済む）。
  }
  return map
}

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
  const startDates = unextStartDates(dir)
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      const e = JSON.parse(s) as RawEvent
      // ★ 邦題が取れていない作品に原語表記を充てる（`lib/work-title.ts`）。
      //   規則は pipeline/core/events.ts の withJapaneseTitle と同じで、
      //   **かなを含むもの（＝日本語だと確かなもの）だけ**。
      //   片方だけ変えると、記事とサイトで題名が食い違う。
      //   ★ **同じ規則を work-links.ts も呼ぶ。** 規則をここに直接書き戻さないこと。
      fillJapaneseTitle(e.work)
      // ★ U-NEXT の見放題入りに、台帳が持っている配信開始日を充てる。
      //   規則は pipeline/core/events.ts の withUnextStartDate と同じ。
      //   **new だけ。** 終了日は動くので台帳の値を使ってはいけない。
      if (!e.at && e.service === 'u-next' && e.kind === 'new') {
        const at = startDates.get(String(e.work.id))
        if (at) e.at = at
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
 * 指定サービスで「これから終了する」作品を、**終了日が近い順**に返す。
 *
 * ■ 並びの決まりは新着（`loadArrivals`）と共通で「**きょうに近い順**」
 * 2つのページで向きが逆に見えるが、**規則は1つ**。
 *
 *     終了予定（未来）… 9/7 → 9/8 → … → 9/30   （日付は昇順）
 *     新着（過去）    … 9/4 → 9/3 → … → 7/26   （日付は降順）
 *
 * どちらも**きょうから遠ざかる向き**に並ぶ。読者が先に知りたいのは
 * 「次に何が起きるか」なので、時間の絶対的な向きではなく
 * **きょうからの距離**で並べる（2026-09-07 の判断）。
 * ★ 片方だけ変えないこと。**規則が2つに割れる。**
 *
 * ■ 2026-08-31 の判断（終了日の遅い順）を戻した
 * あのときは「終了予定は月末に集中するので、早い順にすると
 * いちばん本数の多い月末の束が毎回いちばん下に落ちる」ことを理由に遅い順にした。
 * **その理由は 2026-09-07 のカレンダーで消えた** — 月末の束は
 * 升目の `終14` として1画面目に出るので、表の先頭を月末に使う必要がない。
 * 表の先頭は「いちばん急いで確かめるべき日」に戻せる。
 *
 * ★ ページ側の説明文（pages/leaving/[service].astro と
 *   pages/calendar/[service].astro）も**必ず一緒に直すこと。**
 *   並びと説明文が食い違うと、読者はどちらも信用しなくなる。
 * ★ **`nearest`（最も近い終了日）は先頭**になった。
 *   以前は末尾だったので `groups.at(-1)` を書いていた箇所がある。
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
      // 日付は近い順（昇順）、同じ日のなかは題名順
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.title.localeCompare(b.title, 'ja')),
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
 * 指定サービスで最近見放題に入った作品を、**配信開始日が新しい順**に返す。
 *
 * ■ 並びの決まりは終了予定（`loadLeaving`）と共通で「**きょうに近い順**」
 * 規則の説明は `loadLeaving` の上に1つだけ置いてある。**両方を同時に読むこと。**
 * ここでは「きょうに近い＝直近」なので、日付としては降順になる。
 *
 *     9/4 → 9/3 → 9/2 → 9/1 → 8/31 → … → 7/26
 *
 * ■ 2026-08-27 の判断（古い順）を戻した
 * あのときは「上から下へ時間が進む向きにそろえる」ことを理由に古い順にした。
 * **7月・8月に何が入ったかを確かめる用は薄い**（読者が来るのは
 * 「今月のいつ入ったか」を見るため）ので、
 * 古い順だと**いちばん要らない2か月前が毎回いちばん上**に来ていた。
 * 升目を今月から先だけにした判断（lib/calendar.ts）と同じ理由（2026-09-07）。
 *
 * ★ ページ側の説明文（pages/arrivals/[service].astro と
 *   pages/calendar/[service].astro）も**必ず一緒に直すこと。**
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
      // 日付は新しい順（降順）、同じ日のなかは題名順
      .sort((a, b) => b.at.getTime() - a.at.getTime() || a.title.localeCompare(b.title, 'ja')),
    dataAsOf: asOf(latest),
  }
}

export { ARRIVALS_WINDOW_DAYS }

// --- 配信カレンダー -----------------------------------------------------------

/**
 * 配信カレンダー（`/calendar/<サービス>`）を作るサービス。
 *
 * **終了予定か新着のどちらかを持つ社**を機械的に拾う。手で並べない。
 * 実データでは Netflix / Amazon Prime Video / Disney+ の3社になる
 * （Apple TV+ は `expiring` も `new` も出ないので落ちる）。
 *
 * ★ **並びは `API_SERVICES` の定義順。**
 *   紹介料の高いサービスを上に置かないと決めてある（docs/AFFILIATE.md 7節・
 *   プライバシーポリシーにも明記）。「Amazon を先頭に」と書いた時点で
 *   その方針に反するので、**ここは収集対象の定義順のまま固定する。**
 *
 * ★ 上の2つ（LEAVING_SERVICES / ARRIVALS_SERVICES）より**後ろ**に置くこと。
 *   const は上から評価されるので、前に出すと空配列になる。
 */
export const CALENDAR_SERVICES = API_SERVICES.filter(
  (s) =>
    LEAVING_SERVICES.some((l) => l.key === s.key) ||
    ARRIVALS_SERVICES.some((a) => a.key === s.key),
)

/** そのサービスが終了予定の一覧を持っているか（カレンダーの節の出し分けに使う） */
export function hasLeaving(service: string): boolean {
  return LEAVING_SERVICES.some((s) => s.key === service)
}

/** そのサービスが新着の一覧を持っているか */
export function hasArrivals(service: string): boolean {
  return ARRIVALS_SERVICES.some((s) => s.key === service)
}

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
