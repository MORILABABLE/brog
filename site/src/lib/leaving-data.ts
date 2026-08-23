/**
 * 常設ページ「配信終了予定」のデータ読み込み。**ビルド時にだけ動く。**
 *
 * ■ なぜ記事ではなくページなのか
 * 月次記事は公開時点のスナップショットで、月をまたぐと古くなる。
 * 一方このページはURLが固定で、`collect` のたびに中身だけが入れ替わる。
 * 被リンクと検索評価が1つのURLに集中するので、
 * 「netflix 配信終了予定」のような**継続的な需要**に当てるならこちらが向く。
 *
 * ■ LLMを使わない
 * 出すのは「作品名・終了日・評価」という事実だけなので、文章生成が要らない。
 * 生成コストゼロ、誤情報のリスクもゼロ。品質ゲートを通す必要もない。
 *
 * ■ データの出どころ
 * リポジトリ直下の `data/events/*.jsonl`（パイプラインの収集結果）を直接読む。
 * Cloudflare Pages はリポジトリ全体をクローンしてから `site/` に降りるので、
 * ビルド時に `../data` へ到達できる。
 * **`site/` を単体で別の場所に移すとここが壊れる。**
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * `data/events` を探す。
 *
 * ★ `import.meta.url` からの相対解決は使えない。
 *   Astro はビルド時にこのファイルを `dist/.prerender/chunks/` へバンドルするので、
 *   `import.meta.url` はソースの位置ではなくチャンクの位置を指す（実際に踏んだ）。
 *
 * 代わりに実行時のカレントから上へ辿る。
 * `cd site && npm run build`（Cloudflare も同じ）でも、
 * リポジトリ直下から叩いた場合でも、同じ場所に行き着く。
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
 * 常設ページを作るサービス。
 *
 * ★ theme-packs/streaming-jp/article-types/leaving.ts の SERVICE_VARIANTS と
 *   揃えること。実測（2026-08・1,089件）で expiring を返したのは
 *   Netflix と Prime Video の2社だけで、Disney+ / Apple TV+ は0件だった。
 */
export const LEAVING_SERVICES = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
] as const

export type LeavingServiceKey = (typeof LEAVING_SERVICES)[number]['key']

export interface LeavingWork {
  workId: string
  /** 表示に使う題名。邦題が引けていればそれ、無ければ原題。 */
  title: string
  /** 邦題が引けたときの原題。引けていなければ undefined。 */
  originalTitle?: string
  year?: number
  rating?: number
  /** 見放題が終わる日 */
  at: Date
}

export interface LeavingData {
  works: LeavingWork[]
  /** データの基準日（収集した最も新しい時刻）。配信状況は変わるので必ず表示する。 */
  dataAsOf: Date | null
}

interface RawEvent {
  collectedAt: string
  service: string
  kind: string
  at?: string
  work: {
    id: number | string
    title: string
    originalTitle?: string
    localizedTitle?: string
    year?: number
    rating?: number
  }
}

function readAll(): RawEvent[] {
  const dir = findEventsDir()
  if (!dir) {
    // 収集前・パスがずれた場合。空のページを黙って出すよりビルドを止める。
    throw new Error(
      `収集データ（data/events）が見つかりません。探した起点: ${process.cwd()}\n` +
        '  npm run collect を実行済みか、site/ をリポジトリの外に移していないか確認する。',
    )
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  const out: RawEvent[] = []
  for (const f of files.sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const s = line.trim()
      if (s) out.push(JSON.parse(s) as RawEvent)
    }
  }
  return out
}

/**
 * 指定サービスで「これから終了する」作品を、終了日の早い順に返す。
 *
 * ★ 「これから」の判定は絶対時刻の比較なのでタイムゾーンに依存しない。
 *   表示のときだけ JST に寄せる（utils/date.ts）。
 */
export function loadLeaving(service: string): LeavingData {
  const now = Date.now()
  const events = readAll().filter(
    (e) => e.kind === 'expiring' && e.service === service && e.at && Date.parse(e.at) >= now,
  )

  // 同じ作品が複数回収集されている。**最後に観測した内容を採る**
  // （終了日が後から変わることがあるため、古い方を残すと誤情報になる）。
  const latest = new Map<string, RawEvent>()
  for (const e of events) {
    const key = String(e.work.id)
    const cur = latest.get(key)
    if (!cur || e.collectedAt > cur.collectedAt) latest.set(key, e)
  }

  const works: LeavingWork[] = [...latest.values()]
    .map((e) => ({
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
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.title.localeCompare(b.title, 'ja'))

  const asOf = [...latest.values()].reduce<string | null>(
    (max, e) => (max === null || e.collectedAt > max ? e.collectedAt : max),
    null,
  )

  return { works, dataAsOf: asOf ? new Date(asOf) : null }
}

/** 終了日ごとにまとめる。表示は日付単位のほうが読みやすい。 */
export function groupByDate(works: LeavingWork[]): { date: Date; works: LeavingWork[] }[] {
  const map = new Map<string, LeavingWork[]>()
  for (const w of works) {
    // JST の暦日でまとめる。UTC で切ると 9時間ぶんが前日に落ちる。
    const key = new Date(w.at.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10)
    ;(map.get(key) ?? map.set(key, []).get(key)!).push(w)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, ws]) => ({ date: ws[0]!.at, works: ws }))
}
