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
import { formatDate, isoDate } from '../utils/date'

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

/**
 * 配信履歴の1行。**「観測したできごと」であって、配信の全史ではない。**
 *
 * ★ 当サイトの観測が始まる前のことは1行も持っていない（`observationStart()`）。
 *   ページ側で必ずその旨を添えること。書かないと、
 *   「この日に配信が始まった作品」という**観測していない主張**になる。
 *
 * ★ 同じできごとを何度収集しても1行にする（サービス・種別・日付が同じなら同一）。
 *   `foundAt` は**最初に観測した日**。終了予定がいつ判明したかを示す値なので、
 *   後の観測で上書きしない。
 */
export interface WorkHistoryEntry {
  service: string
  label: string
  /** 収集データの種別。表示の言い回しは HISTORY_LABEL が持つ */
  kind: 'new' | 'expiring' | 'removed'
  /** そのできごとの日付（配信開始日・終了予定日・終了日） */
  at: Date
  /** 当サイトがそれを**最初に観測した日** */
  foundAt: Date
}

/**
 * 履歴1行の言い回し。**状態（WorkState）とは別物なので混ぜないこと。**
 * こちらは「その日に何が起きたか」だけを言う。過去か未来かで言い換えない
 * （未来の終了予定も、過去の終了予定も、観測した事実は同じ「終了予定」）。
 */
export const HISTORY_LABEL: Record<WorkHistoryEntry['kind'], string> = {
  new: '見放題配信の開始を確認',
  expiring: '見放題終了予定',
  removed: '見放題配信が終了',
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
  /**
   * 観測したできごとを**古い順**に並べたもの。
   *
   * ★ 上の `services` が「いまどうなっているか」の1行なのに対して、
   *   こちらは「**いつ入って、いつ消えたか**」。同じ素材から作るが役割が違う。
   *   収集を続けるほど行が増える（docs/STOCK.md の S-2）。
   */
  history: WorkHistoryEntry[]
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

/**
 * 1作品ぶんの配信履歴。**同じできごとを何度収集しても1行にする。**
 *
 * ★ 重複の鍵は「サービス・種別・日付」。収集は変化があったときだけ書き出すが、
 *   棚卸しの都合で同じ終了予定が2回出ることがある（実測: 2026-08 で0件だが、
 *   0件であることに依存しない）。**行が二重に出ると履歴の信用が落ちる。**
 *
 * ★ `foundAt` は**最初の観測**を残す。終了予定が何日前に判明したかを示す値なので、
 *   後の観測で上書きすると「終了当日に判明した」ことになってしまう。
 */
function historyOf(svc: Map<string, RawEvent[]>): WorkHistoryEntry[] {
  const rows = new Map<string, WorkHistoryEntry>()
  for (const events of svc.values()) {
    for (const e of events) {
      if (!e.at || !Number.isFinite(Date.parse(e.at))) continue
      if (e.kind !== 'new' && e.kind !== 'expiring' && e.kind !== 'removed') continue
      const at = new Date(Date.parse(e.at))
      const foundAt = new Date(Date.parse(e.collectedAt))
      const key = `${e.service} ${e.kind} ${e.at.slice(0, 10)}`
      const cur = rows.get(key)
      if (!cur) {
        rows.set(key, {
          service: e.service,
          label: LABEL_BY_SERVICE.get(e.service) ?? e.service,
          kind: e.kind,
          at,
          foundAt,
        })
      } else if (foundAt < cur.foundAt) {
        cur.foundAt = foundAt
      }
    }
  }
  // 古い順。上から下へ時間が進む向きにそろえる（常設ページの表と同じ）
  return [...rows.values()].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.service.localeCompare(b.service),
  )
}

// --- 組み立て -----------------------------------------------------------------

let pages: Map<string, WorkPage> | null = null

/**
 * 当サイトが観測を始めた日（収集データの最も古い `collectedAt`）。
 *
 * ★ **配信履歴には必ずこれを添える。** これより前の出入りは1件も持っていない。
 *   添えないと「この日に配信が始まった」と読まれ、観測していないことを主張する
 *   ことになる（/stats の「観測できた数であって起きた数ではない」と同じ規律）。
 */
let observedSince: Date | null = null

export function observationStart(): Date | null {
  build()
  return observedSince
}

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
    /*
     * ★ 配信開始「予定」（各社の告知）は作品ページに出さない。
     *   このページは「いま観られるか・いつまで観られるか」を伝える場所で、
     *   `stateOf()` は expiring / removed 以外をすべて `started`（配信開始）と
     *   扱う。予定を混ぜると**まだ始まっていない配信を「配信開始」と表示する。**
     *   告知は記事（特報 --kind upcoming）の素材としてだけ使う。
     */
    if (e.kind === 'upcoming') continue
    const id = String(e.work.id)

    const svc = byWork.get(id) ?? new Map<string, RawEvent[]>()
    const list = svc.get(e.service) ?? []
    list.push(e)
    svc.set(e.service, list)
    byWork.set(id, svc)

    const cur = newest.get(id)
    if (!cur || e.collectedAt > cur.collectedAt) newest.set(id, e)

    // 観測開始日。**API由来の全イベントのうち最も古い収集時刻。**
    const collected = new Date(Date.parse(e.collectedAt))
    if (!observedSince || collected < observedSince) observedSince = collected
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
      history: historyOf(svc),
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
  observedSince = null
  relatedIndex = null
}

// --- 関連リンク（内部リンクの受け皿）------------------------------------------
//
// docs/WORK-PAGES.md 6節。**作品ページ同士を繋ぐのはここだけ。**
//
// ■ なぜ要るか
// 作品ページ516枚は、これが無いと**互いにリンクの無い孤立点**のまま。
// 読者は1枚見て行き止まりになり、クローラは1枚から次へ辿れない
// （docs/STOCK.md 2-3 の実測）。
//
// ■ 3つの枠と上限（6節の表そのもの）
//   同じ日に同じサービスで動く作品  8件
//   同じ監督の作品                  6件
//   同じサービス・同じジャンルで終了予定  6件
//
// ★ **上限を必ず置く。** 8月31日のように80本以上が同じ日に終わる日がある。
//   全部並べるとページがリンクの塊になる。
// ★ **掲載判定を通った作品にだけリンクする。** 通らない作品を混ぜると 404 になる。
// ★ **題名で引かない。IDで引く。** 同じ題名の別作品が別サービスに入ることがある
//   （work-links.ts の Entry の注意書き）。

const SAME_DAY_LIMIT = 8
const SAME_DIRECTOR_LIMIT = 6
const SAME_GENRE_LIMIT = 6

export interface RelatedWork {
  id: string
  title: string
  /** 題名の下に出す一言。作らない場合は空文字 */
  note: string
}

export interface RelatedGroup {
  heading: string
  items: RelatedWork[]
}

interface RelatedIndex {
  /** `<サービス> <状態> <YYYY-MM-DD>` → 作品 */
  byDay: Map<string, WorkPage[]>
  /** 監督名 → 作品 */
  byDirector: Map<string, WorkPage[]>
  /** `<サービス> <ジャンル>` → **終了予定の**作品 */
  byGenre: Map<string, WorkPage[]>
  /**
   * `<サービス> <ジャンル>` → **終了済みの**作品。**作品IDの昇順で固定**。
   *
   * ■ なぜ要るか（2026-08-30）
   * `byGenre` は終了予定しか索引していないため、**終了済みの作品を指す枠が1つも無かった。**
   * 実測で、作品ページ516枚のうち**164枚がトップページからリンクを辿って到達できない**
   * 状態になっていた（160枚が終了済み）。入口が noindex の `sitemap.html` だけで、
   * クローラから見ると事実上の孤立点になる。
   *
   * ★ **並びを固定するのが要点。** 下の `ringSlice()` が「自分の次から数件」を取るので、
   *   束の中が輪でつながり、**1枚でも到達できれば束ごと到達できる**ようになる。
   *   並びが実行ごとに変わると輪が切れる。
   */
  byGenreEnded: Map<string, WorkPage[]>
  /**
   * `<ジャンル>` → 作品（**サービスも状態も問わない**）。**作品IDの昇順で固定**。
   *
   * 枠が1つも作れなかったページの**最後の受け皿**にだけ使う。
   * 収集が薄いサービス（Apple TV+ は作品ページ2枚）では、
   * 「同じ日」も「同じ監督」も「同じサービス・同じジャンル」も空になることがあり、
   * そのページは**読者にとっても行き止まり**になる。
   */
  byGenreAny: Map<string, WorkPage[]>
}

let relatedIndex: RelatedIndex | null = null

/** ★ 日付は必ず utils/date を通す。ビルドは UTC で走るので自前で組むと1日ずれる。 */
function dayKey(service: string, state: WorkState, at: Date): string {
  return `${service} ${state} ${isoDate(at)}`
}

function buildRelatedIndex(): RelatedIndex {
  if (relatedIndex) return relatedIndex

  const byDay = new Map<string, WorkPage[]>()
  const byDirector = new Map<string, WorkPage[]>()
  const byGenre = new Map<string, WorkPage[]>()
  const byGenreEnded = new Map<string, WorkPage[]>()
  const byGenreAny = new Map<string, WorkPage[]>()

  const push = <K>(map: Map<K, WorkPage[]>, key: K, w: WorkPage) => {
    const list = map.get(key)
    if (list) list.push(w)
    else map.set(key, [w])
  }

  for (const w of publishableWorkPages()) {
    for (const s of w.services) {
      push(byDay, dayKey(s.service, s.state, s.at), w)
      if (s.state === 'leaving') {
        for (const g of w.genres) push(byGenre, `${s.service} ${g}`, w)
      } else {
        for (const g of w.genres) push(byGenreEnded, `${s.service} ${g}`, w)
      }
    }
    for (const d of w.directors) push(byDirector, d, w)
    for (const g of w.genres) push(byGenreAny, g, w)
  }

  // ★ 輪をつくるので並びを固定する（byGenreEnded の説明）
  for (const list of byGenreEnded.values()) list.sort((a, b) => a.id.localeCompare(b.id))
  for (const list of byGenreAny.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  relatedIndex = { byDay, byDirector, byGenre, byGenreEnded, byGenreAny }
  return relatedIndex
}

/**
 * 束の中を「自分の次から」順に返す。**輪（リング）にして切れ目をなくす。**
 *
 * ■ なぜ先頭から取らないのか
 * どのページも先頭から取ると、**束の先頭の数件だけが延々とリンクされ**、
 * 後ろの作品には誰からもリンクが向かない。到達できないページが残り続ける。
 *
 * 自分の次から取れば、A→B→C→…→A と輪になる。
 * **束のどれか1枚に外から入れれば、束の全部に辿り着ける。**
 *
 * 自分が束に居ない場合（終了予定の作品が終了済みの束を見るとき）は、
 * 作品IDから決めた位置から取る。ページごとに入口がばらけるだけで、輪の性質は変わらない。
 */
function ringSlice(list: WorkPage[], self: WorkPage, count: number): WorkPage[] {
  if (list.length === 0) return []
  const at = list.findIndex((x) => x.id === self.id)
  const start =
    at >= 0
      ? at + 1
      : // 自分が居ない束。IDの文字コードの和で入口を散らす（安定した値であればよい）
        ([...self.id].reduce((a, c) => a + c.charCodeAt(0), 0) % list.length)
  const out: WorkPage[] = []
  for (let i = 0; i < list.length && out.length < count; i++) {
    const x = list[(start + i) % list.length]!
    if (x.id !== self.id) out.push(x)
  }
  return out
}

/**
 * 並びの既定。**評価の高い順 → 製作年の新しい順 → ID順。**
 *
 * ★ 最後に必ずIDを見る。ここが無いと、評価も年も無い作品どうしの順が
 *   実行のたびに変わりうる（差分が出てビルドが毎回変わる）。
 */
function byNotability(a: WorkPage, b: WorkPage): number {
  return (b.rating ?? 0) - (a.rating ?? 0) || (b.year ?? 0) - (a.year ?? 0) || a.id.localeCompare(b.id)
}

/** 状態に応じた「その日に何が起きるか」。ページの sentence() と役割を分けること。 */
function dayVerb(state: WorkState): string {
  switch (state) {
    case 'leaving':
      return '見放題が終わる作品'
    case 'passed':
      return '見放題の終了予定だった作品'
    case 'ended':
      return '見放題が終わった作品'
    case 'started':
      return '見放題に入った作品'
  }
}

/**
 * その作品ページに出す関連リンク。**3枠まで、重複なし。**
 *
 * ★ 一度出した作品は次の枠に出さない。同じ題名が2度並ぶと、
 *   読者には「同じリンクが増えている」ようにしか見えない。
 */
export function relatedWorks(w: WorkPage): RelatedGroup[] {
  const idx = buildRelatedIndex()
  const groups: RelatedGroup[] = []
  const used = new Set<string>([w.id])

  const take = (candidates: WorkPage[] | undefined, limit: number, note: (x: WorkPage) => string) => {
    const out: RelatedWork[] = []
    for (const c of candidates ?? []) {
      if (used.has(c.id)) continue
      used.add(c.id)
      out.push({ id: c.id, title: c.title, note: note(c) })
      if (out.length >= limit) break
    }
    return out
  }

  // 1. 同じ日・同じサービス。**このページの主役の状態に合わせる**
  const head = w.services[0]!
  const dayBucket = idx.byDay.get(dayKey(head.service, head.state, head.at)) ?? []
  /*
   * ★ **輪の次の1件を必ず混ぜる**（2026-08-30）。
   *   評価の高い順に上位8件を出すだけだと、束が大きいとき
   *   （実測: 8月14日の Prime Video は116作品）**下位の作品は誰からもリンクされない。**
   *   自分の次の1件を必ず入れておけば A→B→C→…→A と輪になり、
   *   束のどれか1枚に外から入れれば全部に辿り着ける（`ringSlice` の説明）。
   *
   *   混ぜたうえで**表示は評価の高い順のまま**にしてある。読者に見えるのは
   *   「同じ日に終わる作品が8件」で、並びの意図は変わらない。
   */
  const ordered = [...dayBucket].sort((a, b) => a.id.localeCompare(b.id))
  const picked: WorkPage[] = []
  const pickedIds = new Set<string>([w.id])
  // ★ 輪の次の1件を先に確保してから、評価の高い順で残りを埋める。
  //   先に並べ替えてしまうと、輪の1件が順位で押し出されて効かなくなる。
  for (const x of [...ringSlice(ordered, w, 1), ...[...dayBucket].sort(byNotability)]) {
    if (pickedIds.has(x.id)) continue
    pickedIds.add(x.id)
    picked.push(x)
    if (picked.length >= SAME_DAY_LIMIT) break
  }
  // 見せる順は評価の高い順に戻す（読者から見た並びの意図は変えない）
  const sameDay = take(picked.sort(byNotability), SAME_DAY_LIMIT, (x) =>
    x.year ? `${x.year}年` : '',
  )
  if (sameDay.length > 0) {
    groups.push({
      heading: `${formatDate(head.at)}に${head.label}で${dayVerb(head.state)}`,
      items: sameDay,
    })
  }

  // 2. 同じ監督。**配信状況が変わっても古くならない枠**（docs/STOCK.md S-3）
  const director = w.directors[0]
  if (director) {
    const items = take(
      (idx.byDirector.get(director) ?? []).slice().sort(byNotability),
      SAME_DIRECTOR_LIMIT,
      (x) => [x.year ? `${x.year}年` : '', STATE_LABEL[x.state]].filter(Boolean).join('・'),
    )
    if (items.length > 0) {
      groups.push({ heading: `${director}が監督した作品`, items })
    }
  }

  // 3. 同じサービス・同じジャンルで終了予定。**締め切りの近い順**
  const genre = w.genres[0]
  if (genre) {
    const candidates = (idx.byGenre.get(`${head.service} ${genre}`) ?? []).slice().sort((a, b) => {
      const at = (x: WorkPage) => x.services.find((s) => s.state === 'leaving')?.at.getTime() ?? 0
      return at(a) - at(b) || a.id.localeCompare(b.id)
    })
    const items = take(candidates, SAME_GENRE_LIMIT, (x) => {
      const s = x.services.find((y) => y.state === 'leaving')
      return s ? formatDate(s.at) : ''
    })
    if (items.length > 0) {
      groups.push({ heading: `${head.label}で終了予定の${genre}作品`, items })
    }

    /*
     * 4. 同じサービス・同じジャンルで**終了済み**。輪で取る（`ringSlice`）。
     *
     * ■ なぜ足したか（2026-08-30）
     * ここまでの3枠は**終了予定の作品しか指さない**（`byGenre` が終了予定だけの索引）。
     * そのため終了済みの作品ページは、記事・常設ページ・人物ページのどれにも
     * 拾われなかった場合、**どこからもリンクされない**。実測164枚がその状態だった。
     *
     * ★ 読者にとっても筋が通る枠にしてある。終了済みの作品を見ている読者には
     *   「同じころに終わった同じジャンルの作品」で、終了予定の作品を見ている読者には
     *   「そのサービスで最近終わったもの」になる。
     * ★ **「観られます」と書かない。** 状態は `STATE_LABEL` から出す（下の note）。
     */
    const ended = ringSlice(idx.byGenreEnded.get(`${head.service} ${genre}`) ?? [], w, SAME_GENRE_LIMIT)
    const endedItems = take(ended, SAME_GENRE_LIMIT, (x) =>
      [x.year ? `${x.year}年` : '', STATE_LABEL[x.state]].filter(Boolean).join('・'),
    )
    if (endedItems.length > 0) {
      groups.push({ heading: `${head.label}で見放題配信が終了した${genre}作品`, items: endedItems })
    }
  }

  /*
   * 5. 最後の受け皿。**枠が1つも作れなかったページにだけ出す。**
   *
   * 収集が薄いサービスでは、ここまでの枠がすべて空になることがある
   * （実測: Apple TV+ の「Björk: Cornucopia」。同じ日にも同じジャンルにも仲間が居ない）。
   * 関連が0件のページは**読者にとっての行き止まり**であり、
   * 同時に**どこからもリンクされない孤立点**にもなる。
   *
   * ★ サービスをまたぐ。ここまで来たページには他に出せるものが無いため。
   * ★ 輪で取るので、この枠に落ちたページ同士も繋がる。
   */
  if (groups.length === 0 && w.genres[0]) {
    const anyItems = take(
      ringSlice(idx.byGenreAny.get(w.genres[0]) ?? [], w, SAME_GENRE_LIMIT),
      SAME_GENRE_LIMIT,
      (x) => [x.year ? `${x.year}年` : '', STATE_LABEL[x.state]].filter(Boolean).join('・'),
    )
    if (anyItems.length > 0) {
      groups.push({ heading: `${w.genres[0]}の作品`, items: anyItems })
    }
  }

  return groups
}
