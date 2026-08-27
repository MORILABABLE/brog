/**
 * 作品ページ（`/works/<作品ID>`）のデータ。
 *
 * ■ 何をするファイルか
 * **収集済みのものを繋ぎ直すだけ。** 新しい取得は1件もしない。
 *
 *   data/events/*.jsonl        配信状況・日付・年・ジャンル・あらすじ
 *   data/directors.json        監督   ┐
 *   data/cast.json             出演   ├ Wikidata（CC0）
 *   data/origins.json          製作国 ┘
 *   public/posters/<ID>.webp   ポスター
 *
 * ■ なぜ作るのか
 * 記事も常設ページも「その月に何が起きたか」の軸で、
 * **1作品を名指しで探しに来た読者の受け皿が無い**。
 * 「〇〇 いつまで Netflix」のような語は競合がほぼ居ない一方、
 * 終了日を出せるサイトがほとんど無いので当てられる。
 * 設計と根拠は docs/WORK-PAGES.md、位置づけは docs/GROWTH.md 3-1。
 *
 * ■ 絶対に守ること
 * **「配信中」と書かない。** このサイトが持っているのは「変化の観測」であって
 * 「現在の在庫」ではない。`new` を観測して `removed` を観測していないことは、
 * いま観られることを意味しない。判定と言い回しは `WorkState` の注意書き。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GENRE_ART } from '../../scripts/genre-art.mjs'
import type { CategorySlug } from '../config'
import {
  API_SERVICES,
  LABEL_BY_SERVICE,
  loadAllEvents,
  type RawEvent,
  type RawWork,
} from './events-data'
import { resolveUrl } from './work-links'

/** ポスターの公開パスの根。scripts/make-thumbs.mjs の出力先と揃える。 */
const POSTER_BASE = '/posters'

/**
 * 出演者を出す上限。
 *
 * ★ Wikidata の並びは**主演順ではない**（docs/HANDOVER.md 1節）。
 *   全部並べても「重要な順に上から」にはならず、実測で22人並ぶ作品がある。
 *   読者が名前で作品を思い出せる程度に切る。
 */
const CAST_LIMIT = 10

/**
 * ジャンル名（英語）→ 日本語ラベル。
 *
 * ★ 収集データのジャンルは**英語のまま**入っている（`Action` `Drama` …）。
 *   日本語のページに英語を出さないため、既存のジャンル定義で訳す。
 *   `scripts/genre-art.mjs` は表のジャンル汎用画像のための定義だが、
 *   **英語名と日本語ラベルの対応表をすでに持っている**ので、それを使う。
 *   `npm run thumbs -- --audit` が「取りこぼしなし」と出る状態を保つこと
 *   （取りこぼすと、そのジャンルはページから静かに消える）。
 */
const GENRE_LABEL = new Map<string, string>(
  (GENRE_ART as { label: string; aliases: string[] }[]).flatMap((g) =>
    g.aliases.map((a) => [a, g.label] as [string, string]),
  ),
)

/**
 * 原語（英語表記）→ 日本語。
 *
 * ★ Wikidata が返すのは `English` `Japanese` のような**英語の言語名**で、
 *   実測50種類ある。上位を訳し、残りは原文のまま出す
 *   （`Cantonese` のような固有名詞は英語でも読者が判別できる）。
 */
const LANGUAGE_JA: Record<string, string> = {
  English: '英語',
  Japanese: '日本語',
  Korean: '韓国語',
  French: 'フランス語',
  Spanish: 'スペイン語',
  Italian: 'イタリア語',
  German: 'ドイツ語',
  Russian: 'ロシア語',
  Thai: 'タイ語',
  Cantonese: '広東語',
  Mandarin: '中国語（標準語）',
  'Standard Chinese': '中国語（標準語）',
  Hindi: 'ヒンディー語',
  Portuguese: 'ポルトガル語',
  Turkish: 'トルコ語',
  Swedish: 'スウェーデン語',
  Danish: 'デンマーク語',
  Norwegian: 'ノルウェー語',
  Polish: 'ポーランド語',
  Dutch: 'オランダ語',
  Indonesian: 'インドネシア語',
  Romanian: 'ルーマニア語',
  Tamil: 'タミル語',
  Catalan: 'カタルーニャ語',
  Finnish: 'フィンランド語',
  Arabic: 'アラビア語',
  Hebrew: 'ヘブライ語',
  Vietnamese: 'ベトナム語',
  Tagalog: 'タガログ語',
  Czech: 'チェコ語',
  Hungarian: 'ハンガリー語',
  Greek: 'ギリシャ語',
  Ukrainian: 'ウクライナ語',
}

/** 対象にするサービスキー。**U-NEXT は入らない**（events-data.ts の API_SERVICES）。 */
const API_SERVICE_KEYS = new Set<string>(API_SERVICES.map((s) => s.key))

// --- 型 -----------------------------------------------------------------------

/**
 * その作品の、そのサービスでの状態。**4つしかない。**
 *
 * | 値 | 判定 | ページでの言い方 |
 * |---|---|---|
 * | `leaving` | `expiring` で日付が**未来** | 9月30日に見放題終了予定 |
 * | `passed`  | `expiring` で日付が**過去** | 終了予定日: 8月31日（この日を過ぎています） |
 * | `ended`   | `removed`                  | 8月31日に見放題配信が終了しました |
 * | `started` | `new`                      | 8月1日に見放題配信が始まりました |
 *
 * ★ **`passed` を `ended` に丸めない。**
 *   予定日を過ぎたことは観測しているが、**実際に終わったことは観測していない**。
 *   丸めると、配信が延長された作品に「終了しました」と書くことになる。
 *
 * ★ **`started` を「配信中」と言い換えない。**
 *   Disney+ と Apple TV+ は終了予定を返さず、`removed` も棚卸しの都合で遅れて出る。
 *   「始まった」は観測した事実、「いま観られる」は観測していない推測。
 */
export type WorkState = 'leaving' | 'passed' | 'ended' | 'started'

/**
 * 状態の短い名前（バッジ・見出し用）。
 * ★ 作品ページとサイトマップの両方が使う。**文字列を各ページに散らさない。**
 */
export const STATE_LABEL: Record<WorkState, string> = {
  leaving: '終了予定',
  passed: '終了予定日を経過',
  ended: '終了済み',
  started: '配信開始を確認',
}

/** バッジの色。styles/global.css の `.badge[data-category]` を流用する。 */
export const STATE_CATEGORY: Record<WorkState, CategorySlug> = {
  leaving: 'leaving',
  passed: 'leaving',
  ended: 'ended',
  started: 'arrivals',
}

/** 読者にとって行動が要る順。一覧の並びはこれに従う。 */
export const STATE_ORDER_KEYS: readonly WorkState[] = ['leaving', 'passed', 'ended', 'started']

export interface WorkServiceState {
  service: string
  label: string
  state: WorkState
  /** その状態の日付（終了予定日 / 終了日 / 配信開始日） */
  at: Date
  /** 送り先。work-links.ts の resolveUrl が決める（アフィリエイト化はしない） */
  url: string
}

export interface WorkPage {
  id: string
  /** 邦題優先 */
  title: string
  /** 邦題と原題が違うときだけ入る */
  originalTitle?: string
  year?: number
  type: 'movie' | 'series'
  /** 0 は「評価なし」なので undefined に落としてある */
  rating?: number
  /** **日本語ラベル**に訳したもの。訳せなかったものは落としてある */
  genres: string[]
  /**
   * 原語（`data/origins.json`・Wikidata）。日本語に訳したもの。
   *
   * ★ **製作国ではない。** Wikidata の P364（original language）で、
   *   値は `English` `Japanese` のような言語名。名前を間違えると
   *   ページに「製作国: 英語」と出る（2026-08-27 に実際に出した）。
   */
  languages: string[]
  directors: string[]
  /** ★ 主演順ではない。ページで「主演」と書かないこと。CAST_LIMIT 件まで */
  cast: string[]
  /** `/posters/<ID>.webp`。無ければ undefined（絵を出さない） */
  poster?: string
  /** サービスごとの状態。行動が要るものから並ぶ */
  services: WorkServiceState[]
  /** ページ全体の状態。services の中で最も行動が要るもの */
  state: WorkState
  /** 収集した最も新しい時刻。**必ずページに出す** */
  dataAsOf: Date
}

// --- Wikidata の付帯情報 -------------------------------------------------------

/**
 * `data/<name>.json` を探す。
 * ★ `import.meta.url` は使えない（Astro がチャンクへバンドルする）。
 *   events-data.ts / excluded.ts と同じく実行時のカレントから上へ辿る。
 */
function findData(name: string): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'data', name)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 値が配列の JSON キャッシュ。読めなければ空（付帯情報が出ないだけ）。 */
function loadListCache(name: string): Map<string, string[]> {
  const path = findData(name)
  if (!path) return new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out = new Map<string, string[]>()
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v) && v.length > 0) out.set(k, v.map(String))
    }
    return out
  } catch {
    // 壊れていてもビルドは止めない。監督・出演が出ないだけ。
    return new Map()
  }
}

/**
 * Wikidata キャッシュの突き合わせキー。
 *
 * ★ **`pipeline/sources/wikidata.ts` の `titleCacheKey()` と同じ規則。**
 *   imdbId を主キーとし、無ければ `tmdb:<tmdbId>` で代用する。
 *   片方だけ直すと、**全作品の監督と出演が静かに空になる**
 *   （例外もビルドエラーも出ない）。必ず両方直すこと。
 *   site/ は独立した npm プロジェクトで pipeline を読めないため、こう持っている
 *   （search-links.ts / excluded.ts と同じ事情）。
 */
function wikidataKey(work: RawWork): string | undefined {
  const meta = work.meta
  if (!meta) return undefined
  if (meta.imdbId) return meta.imdbId
  if (meta.tmdbId) return `tmdb:${meta.tmdbId}`
  return undefined
}

// --- ポスター -----------------------------------------------------------------

let posterFiles: Set<string> | null = null

/** `public/posters` にあるファイル名。1度だけ読む。 */
function availablePosters(): Set<string> {
  if (posterFiles) return posterFiles
  const dir = findUpPublic('posters')
  posterFiles = new Set(dir ? readdirSync(dir).filter((n) => n.endsWith('.webp')) : [])
  return posterFiles
}

function findUpPublic(sub: string): string | null {
  for (const segments of [
    ['public', sub],
    ['site', 'public', sub],
  ]) {
    let dir = process.cwd()
    for (let i = 0; i < 4; i++) {
      const candidate = join(dir, ...segments)
      if (existsSync(candidate)) return candidate
      const parent = resolve(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

// --- 状態の判定 ---------------------------------------------------------------

function stateOf(kind: string, at: Date, now: number): WorkState {
  if (kind === 'expiring') return at.getTime() >= now ? 'leaving' : 'passed'
  if (kind === 'removed') return 'ended'
  return 'started'
}

/** 読者にとって行動が要る順。ページ全体の状態と、表の並び順に使う。 */
const STATE_ORDER: Record<WorkState, number> = {
  leaving: 0,
  passed: 1,
  ended: 2,
  started: 3,
}

/**
 * 1サービスぶんの状態を、そのサービスのイベント群から決める。
 *
 * ★ **「最後に収集したイベント」では決めない。**
 *   8月に配信開始（`new`）を観測した作品の終了予定（`expiring`）が
 *   9月に判明することがあり、収集順で採ると「配信が始まりました」に戻ってしまう。
 *   未来の終了予定は**それ自体が最も新しい情報**なので先に見る。
 *
 * ★ 未来の終了予定が複数あるときは**最も近い日**を採る（読者の締め切り）。
 */
function serviceStateOf(events: RawEvent[], now: number): WorkServiceState | undefined {
  const dated = events.filter((e) => e.at && Number.isFinite(Date.parse(e.at)))
  if (dated.length === 0) return undefined

  const service = dated[0]!.service
  const label = LABEL_BY_SERVICE.get(service) ?? service

  const upcoming = dated
    .filter((e) => e.kind === 'expiring' && Date.parse(e.at!) >= now)
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!))

  const pick =
    upcoming[0] ?? dated.slice().sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0]!

  const at = new Date(Date.parse(pick.at!))
  return {
    service,
    label,
    state: stateOf(pick.kind, at, now),
    at,
    // 送り先の決め方は work-links.ts に集約してある。ここで組み立てない。
    url: resolveUrl(pick.work, pick.kind),
  }
}

// --- 組み立て -----------------------------------------------------------------

let pages: Map<string, WorkPage> | null = null

function build(): Map<string, WorkPage> {
  if (pages) return pages

  const now = Date.now()
  const directors = loadListCache('directors.json')
  const cast = loadListCache('cast.json')
  // ★ origins.json は**原語**（Wikidata P364）。製作国ではない。
  const origins = loadListCache('origins.json')
  const posters = availablePosters()

  /** 作品ID → サービスキー → イベント群（**配信API由来のみ**） */
  const byWork = new Map<string, Map<string, RawEvent[]>>()
  /** 作品ID → 最後に収集したイベント（題名・年・絵などの最新の姿） */
  const newest = new Map<string, RawEvent>()

  for (const e of loadAllEvents()) {
    // ★ ここが U-NEXT を落とす唯一の場所（docs/GROWTH.md 2-3）。
    if (!API_SERVICE_KEYS.has(e.service)) continue
    const id = String(e.work.id)

    const svc = byWork.get(id) ?? new Map<string, RawEvent[]>()
    const list = svc.get(e.service) ?? []
    list.push(e)
    svc.set(e.service, list)
    byWork.set(id, svc)

    const cur = newest.get(id)
    if (!cur || e.collectedAt > cur.collectedAt) newest.set(id, e)
  }

  const out = new Map<string, WorkPage>()
  for (const [id, svc] of byWork) {
    const latest = newest.get(id)!
    const work = latest.work

    const services = [...svc.values()]
      .map((events) => serviceStateOf(events, now))
      .filter((s): s is WorkServiceState => s !== undefined)
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.at.getTime() - b.at.getTime())
    if (services.length === 0) continue

    const key = wikidataKey(work)
    const title = work.localizedTitle ?? work.title
    const poster = posters.has(`${id}.webp`) ? `${POSTER_BASE}/${id}.webp` : undefined

    out.set(id, {
      id,
      title,
      // ★ Wikidata の日本語ラベルが原題と同一のことがある（例: Article 15）。
      //   そのまま出すと「Article 15（原題: Article 15）」になる。
      //   events-data.ts の toRow() と同じ扱いにそろえる。
      originalTitle:
        work.localizedTitle && work.localizedTitle !== work.title ? work.title : undefined,
      year: work.year || undefined,
      type: work.type === 'series' ? 'series' : 'movie',
      // rating の 0 は「評価なし」。0 のまま出すと最低評価に見える。
      rating: work.rating ? work.rating : undefined,
      // ★ 訳せなかったジャンルは**落とす**。英語のまま出さない。
      genres: [...new Set((work.genres ?? []).map((g) => GENRE_LABEL.get(g)).filter(Boolean))] as string[],
      languages: ((key && origins.get(key)) || []).map((l) => LANGUAGE_JA[l] ?? l),
      directors: (key && directors.get(key)) || [],
      cast: ((key && cast.get(key)) || []).slice(0, CAST_LIMIT),
      poster,
      services,
      state: services[0]!.state,
      dataAsOf: new Date(Date.parse(latest.collectedAt)),
    })
  }

  pages = out
  return out
}

// --- 掲載判定 -----------------------------------------------------------------

/**
 * その作品のページを作ってよいか。**`getStaticPaths` はこれだけを見る。**
 *
 * ■ 2つの条件（実測 2026-08-27）
 *
 * | 段 | 条件 | 残る |
 * |---|---|---|
 * | 配信API由来（U-NEXT を除く） | build() が済ませている | 1,042 |
 * | **終了日を言える** | `started` 以外の状態を1つ以上持つ | **653** |
 * | **人の名前が出せる** | 監督 **または** 出演がいる | **508** |
 *
 * ■ なぜ「終了日を言える」で切るのか
 * 配信中かどうかは JustWatch も Filmarks も出す。**終了日を出すサイトはほぼ無い。**
 * `new` しか持たない作品のページは「◯月◯日に配信が始まった」しか言えず、
 * 他所と同じ的を撃つことになる（docs/GROWTH.md 1節）。
 *
 * ■ なぜ「人の名前」で切るのか（2026-08-27 に条件を変えた）
 * **当初は「あらすじがあれば厚い」と数えていたが、これは誤りだった。**
 * 配信APIの `overview` は**780件すべてが英語**で、日本語のページに出せない。
 * 出さないものを厚みとして数えると、実際には
 * 「題名・日付・年・ジャンル」しか無いページを厚いと判定してしまう。
 *
 * 監督と出演は Wikidata の**日本語ラベル**で入るので、そのまま読者に出せる。
 * 原語（`origins.json`）も日本語にできるが1語しか増えないので数えない。
 *
 * ★ **緩めるなら「監督 or 出演 or 原語」で575件。**
 *   まず508件を出し、インデックス率を見てから判断する
 *   （docs/GROWTH.md 5節「1つずつ出す」）。
 *
 * ★ **`noindex` で逃げない。** 通らないものはページ自体を作らない。
 *   作らなければサイトマップにも載らず、リンクを張らない工夫も要らない。
 */
export function isWorkPagePublishable(w: WorkPage): boolean {
  const tellsEndDate = w.services.some((s) => s.state !== 'started')
  const namesPeople = w.directors.length > 0 || w.cast.length > 0
  return tellsEndDate && namesPeople
}

// --- 公開する口 ---------------------------------------------------------------

/** 掲載してよい作品ページを、作品IDの順に返す。`getStaticPaths` が使う。 */
export function publishableWorkPages(): WorkPage[] {
  return [...build().values()]
    .filter(isWorkPagePublishable)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 作品IDから引く。掲載判定を通らないものは undefined。 */
export function workPage(id: string): WorkPage | undefined {
  const hit = build().get(id)
  return hit && isWorkPagePublishable(hit) ? hit : undefined
}

/**
 * その作品にページがあるか。
 *
 * ★ 表の作品名を作品ページへ向ける改修（docs/GROWTH.md 3-2）が使う口。
 *   **ページが無い作品にリンクを張ると404になる**ので、必ずこれを通す。
 */
export function hasWorkPage(id: string): boolean {
  return workPage(id) !== undefined
}

/** テスト・再読込用 */
export function resetWorkPages(): void {
  pages = null
  posterFiles = null
}
