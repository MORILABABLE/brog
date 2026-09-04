/**
 * U-NEXT アダプタ。
 *
 * ■ なぜ必要か
 * Streaming Availability API の日本カタログに U-NEXT は存在しない（2026-08-24 再確認）。
 * 一方 U-NEXT はアフィリエイト単価が最も高い部類（1,320円）で、収益の主戦場はこちら側にある。
 * 詳細な調査結果は docs/SOURCES-UNEXT-HULU.md。
 *
 * ■ 何を取り、何を取らないか（重要・法務由来の設計）
 * **事実だけを取り、表現は取らない。**
 *
 *   取る   作品名 / SID / 配信開始日 / 配信終了日 / 見放題かポイントか / 公式ジャンル / 製作年
 *   取らない  catchphrase（キャッチコピー）/ story（あらすじ）/ attractions / サムネイル画像
 *
 * 事実には著作権が発生しないが、キャッチコピーやあらすじは著作物なので、
 * 収集した時点で複製にあたる。
 *
 * **そして、このリポジトリでは「収集しただけ」は「非公開」を意味しない。**
 * collect ワークフローが `git add data/` して push する設計で、
 * リポジトリは public なので、拾ったものはそのまま GitHub 上で公開される。
 * だから「記事にしなければ大丈夫」は成立しない。取らないことが唯一の対策になる。
 *
 * API 応答には catchphrase が含まれているが、**この層で捨てる**。
 * 後段が触れる場所に置かない。
 *
 * ■ 変化の取り方（/changes 相当のものが無いことへの対処）
 * U-NEXT に「いつ何が増減したか」を返すエンドポイントは無い。かわりに、
 *
 *   new       各ジャンルの「新規入荷作品」カテゴリ（配信開始日の新しい順）
 *   expiring  各ジャンルの「すべての作品」を配信終了日の近い順に並べる
 *
 * を毎回読み、**台帳(data/ledger.json)との差分を「前回以降の変化」とみなす**。
 * 台帳による重複除外は既存の仕組みがそのまま使えるので、
 * CollectOptions.sinceDays は意味を持たない（期間ではなく差分で決まる）。
 */
import type {
  ChangeEvent,
  ChangeKind,
  CollectOptions,
  Source,
  Work,
  WorkQuery,
} from './types.ts'
import { BackoffError, PoliteBrowser } from './browser.ts'
import {
  DETAIL_OWNED_FIELDS,
  endDateChanged,
  upsert,
  type UnextStore,
  type UnextTitleRecord,
} from './unext-store.ts'

const SITE = 'https://video.unext.jp'
const API_HOST = 'cc.unext.jp'

/** 作品ページ。記事の出典リンクとアフィリエイトの遷移先になる。 */
export function titleUrl(id: string): string {
  return `${SITE}/title/${id}`
}

// --- theme.yaml から渡される設定 ----------------------------------------

export interface UnextGenreConfig {
  /** テーマ内で使う安定したキー。記事のスラッグやログに出る。 */
  key: string
  /** 表示名。そのまま記事に出る（例: 洋画） */
  label: string
  /** ジャンルのメニューID（例: MNU0000131） */
  id: string
  /** 「新規入荷作品」カテゴリのID */
  arrivals: string
  /** 「すべての作品」カテゴリのID */
  all: string
}

export interface UnextConfig {
  /** ChangeEvent.service に入る値。既存の netflix / prime-video と並ぶ。 */
  service_key: string
  label: string
  genres: UnextGenreConfig[]
  /** 新規入荷を何ページ読むか（1ページ30件） */
  arrivals_pages: number
  /** 終了予定を何ページまで見るか（1ページ30件）。実際は期限で打ち切る */
  expiring_pages: number
  /** 何日先までの終了予定を拾うか */
  expiring_horizon_days: number
  /** 遷移の最小間隔（ミリ秒） */
  min_interval_ms: number
  /**
   * 1回の実行で作品ページを開く上限。
   *
   * 一覧は1回の遷移で30件取れるが、作品ページは1件につき1遷移かかる。
   * 実行時間も相手への負荷も**ここでほぼ決まる**ので、独立した上限にしている。
   */
  max_detail_views?: number
}

/** max_detail_views の既定値。2.5秒間隔なら約12分ぶん。 */
export const DEFAULT_MAX_DETAIL_VIEWS = 300

// --- API 応答の形 --------------------------------------------------------
// 一覧はページ自身が投げた GraphQL の応答をそのまま受け取る。
// 欠けても落ちないよう、必須は id と titleName だけにしている。

interface ApiTitle {
  id: string
  titleName: string
  isNew?: boolean
  rate?: number
  updateOfWeek?: number
  lastEpisode?: string
  productLineupCodeList?: string[]
  isOriginal?: boolean
  exclusive?: { isOnlyOn?: boolean; typeCode?: string | null }
  // catchphrase / thumbnail もここに来るが、意図的に受け取らない（冒頭の方針）
}

interface ApiPageInfo {
  page: number
  pages: number
  pageSize: number
  results: number
}

interface ApiSearchVideo {
  data?: { webfront_searchVideo?: { pageInfo?: ApiPageInfo; titles?: ApiTitle[] } }
}

export interface UnextCategory {
  id: string
  name: string
  defaultSortOrder: string
}

interface ApiGenreMenu {
  data?: {
    searchGenreMenuByMenuId?: { id: string; name: string; searchCategoryMenus?: UnextCategory[] }
  }
}

/** 作品ページから拾う事実。表現（story / catchphrase）は含めない。 */
export interface UnextDetail {
  /** 配信開始日（ISO） */
  publicStartDate?: string
  /** 配信終了日（ISO）。パースできなければ undefined */
  publicEndDate?: string
  /** 終了日の元表記。検証のために残す（日付の主張は事実なので著作物ではない） */
  publicEndText?: string
  productionYear?: number
  country?: string
  mainGenreName?: string
  seriesName?: string
  lineup?: string[]
  /** 配信中の本編エピソード数。映画は 1。種別の判定はこれが最も確実。 */
  episodeCount?: number
}

// --- 値の正規化 ----------------------------------------------------------

/** 見放題かポイントか。記事で「見放題終了」と「レンタルは残る」を書き分けるのに要る。 */
export type Lineup = 'svod' | 'point' | 'both' | 'unknown'

export function lineupOf(codes: string[] | undefined): Lineup {
  const svod = codes?.includes('LNPS_SVOD') ?? false
  const point = codes?.includes('LNPS_VOD') ?? false
  if (svod && point) return 'both'
  if (svod) return 'svod'
  if (point) return 'point'
  return 'unknown'
}

/**
 * 映画かシリーズか。U-NEXT は種別を明示しないので導出する。
 *
 * ■ 一覧から（推定・当てにならない）
 *   シリーズ: lastEpisode に「第91話配信中」等が入る／updateOfWeek が 0以上（更新曜日）
 *   映画:     lastEpisode が空で updateOfWeek が -1
 *
 * **これは放送中の作品にしか効かない。** 完結済みのシリーズは更新曜日を持たず
 * lastEpisode も空なので、映画と区別がつかない
 * （実測: 全24話の「太王四神記」が movie 判定になった）。
 *
 * ■ 作品ページから（確実）
 * publicMainEpisodeCount が本編の話数を返す。映画は 1、シリーズは 2以上。
 * 作品ページを開いたなら必ずこちらを使う。
 *
 * どちらで決めたかは meta.typeSource / 作品台帳に残す。
 */
export function showTypeOf(t: ApiTitle, episodeCount?: number): 'movie' | 'series' {
  if (typeof episodeCount === 'number' && episodeCount > 0) {
    return episodeCount > 1 ? 'series' : 'movie'
  }
  const hasEpisodes = Boolean(t.lastEpisode) || (t.updateOfWeek ?? -1) >= 0
  return hasEpisodes ? 'series' : 'movie'
}

/**
 * U-NEXT の評価（0-50）を 0-100 に正規化する。
 * 既存ソースの Work.rating と目盛りを揃えるため。0以下は「評価なし」。
 */
export function ratingOf(rate: number | undefined): number | undefined {
  if (typeof rate !== 'number' || rate <= 0) return undefined
  return Math.min(100, rate * 2)
}

/**
 * 「2026年8月28日 23:59まで配信」を ISO に直す。
 *
 * 表示用の文字列なので、書式が変われば静かに壊れる。
 * **パースできなかったものは undefined を返し、記事には出さない**（捏造しない）。
 * 時刻は日本時間として解釈する。
 */
export function parseEndDate(text: string | undefined): string | undefined {
  if (!text) return undefined
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[\s　]*(\d{1,2}):(\d{2})/)
  if (!m) return undefined
  const [, y, mo, d, h, mi] = m
  const iso = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}T${h!.padStart(2, '0')}:${mi}:00+09:00`
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString()
}

/** 入れ子の JSON から、指定キーを持つオブジェクトをすべて拾う。 */
function deepFindAll(node: unknown, key: string, out: Record<string, unknown>[] = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const v of node) deepFindAll(v, key, out)
    return out
  }
  const obj = node as Record<string, unknown>
  if (key in obj) out.push(obj)
  for (const v of Object.values(obj)) deepFindAll(v, key, out)
  return out
}

/**
 * 作品ページの応答から、**その作品自身の**オブジェクトを取り出す。
 *
 * 作品ページには関連作品も載る。単純に「最初に見つけたもの」を採ると、
 * 関連作品の終了日を本作の終了日として記事に書く事故が起きうる。
 * **必ず id で突き合わせる。**
 */
function findTitleObject(json: unknown, id: string): Record<string, unknown> | undefined {
  const candidates = deepFindAll(json, 'displayPublicEndDate')
  return candidates.find((o) => o.id === id)
}

// --- アダプタ本体 --------------------------------------------------------

export class UnextSource implements Source {
  readonly name = 'u-next'

  #browser: PoliteBrowser
  #cfg: UnextConfig
  /** 作品ページを開いた回数。負荷の可視化に使う。 */
  #detailViews = 0
  /** 残りの作品ページ予算。0 になったら以降は開かない。 */
  #detailBudget: number
  /** 作品台帳。既知の作品の作品ページを開き直さないために使う。 */
  #store?: UnextStore
  /** 台帳(ledger)に既にある変化キー。既知かどうかの判定に使う。 */
  #seen = new Set<string>()
  /** 終了日が前回から変わった作品。運用者に知らせる材料になる。 */
  #endDateChanges: { id: string; title: string; from: string; to: string }[] = []
  /** 既知だったため作品ページを開かずに済んだ件数 */
  #detailSkipped = 0
  /** 取得に失敗して諦めた作品ページの数 */
  #detailFailed = 0

  constructor(cfg: UnextConfig, browser: PoliteBrowser) {
    this.#cfg = cfg
    this.#browser = browser
    this.#detailBudget = cfg.max_detail_views ?? DEFAULT_MAX_DETAIL_VIEWS
  }

  /**
   * 作品台帳と既出キーを渡す。
   *
   * 渡さなくても動くが、既知の作品にも毎回作品ページを開くことになる
   * （1件2.5秒なので、週次で回すなら実質必須）。
   */
  useStore(store: UnextStore, seen: Iterable<string>): void {
    this.#store = store
    this.#seen = new Set(seen)
  }

  get endDateChanges(): readonly { id: string; title: string; from: string; to: string }[] {
    return this.#endDateChanges
  }
  get detailSkipped(): number {
    return this.#detailSkipped
  }
  get detailFailed(): number {
    return this.#detailFailed
  }

  get pageViews(): number {
    return this.#browser.pageViews
  }
  get detailViews(): number {
    return this.#detailViews
  }
  /** 予算切れで諦めた作品があるか。ログで運用者に知らせるために使う。 */
  get detailBudgetLeft(): number {
    return this.#detailBudget
  }

  // --- 一覧 --------------------------------------------------------------

  #browseUrl(genre: string, category: string, page: number, order: string): string {
    const path = page <= 1 ? '' : `/${page}`
    return `${SITE}/browse/genre/${genre}/${category}${path}?order=${order}`
  }

  async #listPage(
    genre: string,
    category: string,
    page: number,
    order: string,
  ): Promise<{ titles: ApiTitle[]; pageInfo?: ApiPageInfo }> {
    const json = await this.#browser.fetchJson<ApiSearchVideo>(
      this.#browseUrl(genre, category, page, order),
      API_HOST,
      (j) => Boolean((j as ApiSearchVideo)?.data?.webfront_searchVideo),
    )
    const d = json.data?.webfront_searchVideo
    return { titles: d?.titles ?? [], pageInfo: d?.pageInfo }
  }

  /**
   * カテゴリ1つぶんの作品を、最後のページまで読む。
   *
   * ■ 何のためにあるか
   * U-NEXT のアフィリエイトガイドラインは、掲載NGの権利元を
   * **U-NEXT のジャンルメニューのURLで**指している（TBSオンデマンド／日テレ／FOD）。
   * つまり「どの作品が該当するか」はそのメニューを読めば分かる。
   * `npm run unext:ng` がここを呼んで一覧を作る（data/unext-ng.json）。
   *
   * ★ 作品ページは開かない。要るのは作品IDと題名だけで、
   *   終了日も配信状況も要らない（判定に使うのは名前だけ）。
   *   1カテゴリ数十ページの一覧アクセスで済む。
   *
   * ★ **全部読めたかどうかを呼び出し側に返す**（`total` と `pages`）。
   *   途中で打ち切ったことに気づけないと、**一覧が欠けたまま「NGなし」と
   *   判定される**。掲載NGの用途ではそれが最悪の壊れ方になる。
   *
   * @param maxPages 上限。相手への負荷を自分で握るために**必ず渡す**。
   */
  async listCategoryTitles(
    genre: string,
    category: string,
    maxPages: number,
  ): Promise<{ rows: { id: string; title: string }[]; total: number; pages: number }> {
    const rows: { id: string; title: string }[] = []
    let total = 0
    let pages = 0
    for (let page = 1; page <= maxPages; page++) {
      const { titles, pageInfo } = await this.#listPage(genre, category, page, 'popular')
      for (const t of titles) rows.push({ id: t.id, title: t.titleName })
      if (pageInfo) {
        total = pageInfo.results
        pages = pageInfo.pages
      }
      if (titles.length === 0) break
      if (pageInfo && page >= pageInfo.pages) break
    }
    return { rows, total: total || rows.length, pages: pages || 1 }
  }

  /** ジャンル配下のカテゴリ一覧。theme.yaml に書く ID を調べるために使う。 */
  async listCategories(genreId: string): Promise<{ name: string; categories: UnextCategory[] }> {
    // カテゴリIDは URL の飾りで、メニューの問い合わせはジャンルIDだけで決まる。
    // そのため「まだ知らないカテゴリID」を埋めておいても一覧は取れる。
    const json = await this.#browser.fetchJson<ApiGenreMenu>(
      this.#browseUrl(genreId, 'MNU0000000', 1, 'popular'),
      API_HOST,
      (j) => Boolean((j as ApiGenreMenu)?.data?.searchGenreMenuByMenuId),
    )
    const g = json.data?.searchGenreMenuByMenuId
    return { name: g?.name ?? '', categories: g?.searchCategoryMenus ?? [] }
  }

  // --- 作品ページ --------------------------------------------------------

  /**
   * 作品ページから配信開始日・終了日などの事実を取る。
   * 予算を使い切っていたら undefined を返す（呼び出し側が打ち切る合図）。
   */
  async fetchDetail(id: string): Promise<UnextDetail | undefined> {
    if (this.#detailBudget <= 0) return undefined
    this.#detailBudget--
    this.#detailViews++
    const json = await this.#browser.fetchJson<unknown>(titleUrl(id), API_HOST, (j) =>
      Boolean(findTitleObject(j, id)),
    )
    // id で突き合わせて本作だけを取る。見つからなければ空（＝日付なし）にして、
    // 関連作品の値を取り違えるくらいなら何も書かないほうを選ぶ。
    const o = findTitleObject(json, id) ?? {}
    const endText = typeof o.displayPublicEndDate === 'string' ? o.displayPublicEndDate : undefined
    const year = Number(o.productionYear)
    const episodes = Number(o.publicMainEpisodeCount)

    return {
      episodeCount: Number.isFinite(episodes) && episodes > 0 ? episodes : undefined,
      publicStartDate:
        typeof o.publicStartDate === 'string' ? o.publicStartDate : undefined,
      publicEndDate: parseEndDate(endText),
      publicEndText: endText,
      productionYear: Number.isFinite(year) && year > 0 ? year : undefined,
      country: typeof o.country === 'string' && o.country ? o.country : undefined,
      mainGenreName: typeof o.mainGenreName === 'string' ? o.mainGenreName : undefined,
      seriesName: typeof o.seriesName === 'string' && o.seriesName ? o.seriesName : undefined,
      lineup: Array.isArray(o.productLineupCodeList)
        ? (o.productLineupCodeList as string[])
        : undefined,
    }
  }

  // --- 正規化 ------------------------------------------------------------

  #toWork(t: ApiTitle, genre: UnextGenreConfig): Work {
    return {
      id: t.id,
      // U-NEXT は最初から邦題を返すので、Wikidata による解決が要らない。
      // title と localizedTitle が同じなのは手抜きではなく、
      // 「解決すべき原題が存在しない」ことを型の上で示している。
      title: t.titleName,
      localizedTitle: t.titleName,
      type: showTypeOf(t),
      // あらすじは取らない（冒頭の方針）。空文字なのは Work.overview が必須のため。
      overview: '',
      rating: ratingOf(t.rate),
      genres: [genre.label],
      link: titleUrl(t.id),
      meta: {
        source: 'u-next',
        genreKey: genre.key,
        genreLabel: genre.label,
        lineup: lineupOf(t.productLineupCodeList),
        isNew: t.isNew ?? false,
        isOriginal: t.isOriginal ?? false,
        exclusive: t.exclusive?.isOnlyOn ?? false,
        typeSource: 'heuristic',
      },
    }
  }

  // --- 収集 --------------------------------------------------------------

  /**
   * 変化を集める。
   *
   * **CollectOptions.sinceDays は使わない。** U-NEXT に期間指定の手段が無く、
   * 「前回以降」は台帳との差分で決まるため。引数を受けるのは Source 互換のため。
   */
  async collectChanges(opts: CollectOptions): Promise<ChangeEvent[]> {
    const out: ChangeEvent[] = []
    const collectedAt = new Date().toISOString()
    const kinds = new Set<ChangeKind>(opts.kinds)

    if (kinds.has('new')) out.push(...(await this.#collectArrivals(collectedAt)))
    if (kinds.has('expiring')) out.push(...(await this.#collectExpiring(collectedAt)))

    // removed（配信終了済み）は取らない。
    // 全カタログの棚卸しが要り、週次で回すには重すぎる一方、
    // expiring（終了予定）が取れるので事後まとめを作る理由がない。
    return out
  }

  async #collectArrivals(collectedAt: string): Promise<ChangeEvent[]> {
    const out: ChangeEvent[] = []

    for (const genre of this.#cfg.genres) {
      for (let page = 1; page <= this.#cfg.arrivals_pages; page++) {
        const { titles, pageInfo } = await this.#listPage(
          genre.id,
          genre.arrivals,
          page,
          'public_start_desc',
        )
        for (const t of titles) {
          const work = this.#toWork(t, genre)
          this.#remember(work, collectedAt)
          out.push({
            collectedAt,
            service: this.#cfg.service_key,
            kind: 'new',
            work,
          })
        }
        if (pageInfo && page >= pageInfo.pages) break
        if (titles.length === 0) break
      }
    }
    return out
  }

  /**
   * 配信終了予定を集める。
   *
   * 一覧は終了日を返さないので、作品ページを開いて日付を取る必要がある。
   * ただし並び順が「終了日の近い順」なので、**期限を越えたら打ち切れる**。
   * これをやらないと1ジャンルあたり数百ページを開くことになる。
   */
  async #collectExpiring(collectedAt: string): Promise<ChangeEvent[]> {
    const out: ChangeEvent[] = []
    const horizon = Date.now() + this.#cfg.expiring_horizon_days * 86_400_000

    for (const genre of this.#cfg.genres) {
      let beyond = false

      for (let page = 1; page <= this.#cfg.expiring_pages && !beyond; page++) {
        const { titles, pageInfo } = await this.#listPage(
          genre.id,
          genre.all,
          page,
          'public_end_asc',
        )
        if (titles.length === 0) break

        for (const t of titles) {
          const work = this.#toWork(t, genre)

          // 既に expiring として記録済みの作品は、もう記事の素材にならない。
          // 終了日を取るためだけに作品ページを開き直す意味がないので飛ばす
          // （日付の更新は unext:refresh の仕事）。
          //
          // **ここで打ち切り判定をしないこと。** 並びは U-NEXT が持つ「いまの」
          // 終了日の順で、台帳の日付は古いかもしれない。古い日付で「期限の外」と
          // 判断すると、その先にある未収集の作品を丸ごと取りこぼす。
          // 打ち切りは、実際に開いて確かめた日付だけで決める。
          const key = `${this.#cfg.service_key}:expiring:${t.id}`
          if (this.#seen.has(key)) {
            this.#detailSkipped++
            this.#remember(work, collectedAt)
            continue
          }

          let detail: UnextDetail | undefined
          try {
            detail = await this.fetchDetail(t.id)
          } catch (err) {
            // 相手が止めろと言っているなら全体を止める。それ以外（一時的な回線断など）は
            // 1件諦めて進む。ここで throw すると、収集済みのぶんを丸ごと失う。
            if (err instanceof BackoffError) throw err
            this.#detailFailed++
            console.warn(`  作品ページを取得できませんでした: ${t.titleName} (${t.id})`)
            continue
          }

          // 予算切れ。取れたところまでで止める（中途半端に混ざるより分かりやすい）
          if (!detail) return out

          this.#applyDetail(work, detail)
          this.#remember(work, collectedAt, detail)

          // 終了日が読めないものは出さない。推測で日付を書くほうが害が大きい。
          if (!detail.publicEndDate) continue

          if (new Date(detail.publicEndDate).getTime() > horizon) {
            // 並びは終了日の昇順なので、ここから先はすべて期限の外側。
            beyond = true
            break
          }

          out.push({
            collectedAt,
            service: this.#cfg.service_key,
            kind: 'expiring',
            at: detail.publicEndDate,
            work,
          })
        }
        if (pageInfo && page >= pageInfo.pages) break
      }
    }
    return out
  }

  /**
   * 作品台帳に「いまの姿」を書き込む。
   * 終了日が前回と変わっていたら記録する（延長・前倒しに気づくため）。
   */
  #remember(work: Work, seenAt: string, detail?: UnextDetail): UnextTitleRecord | undefined {
    if (!this.#store) return undefined
    const prev = this.#store.titles[work.id]

    // 話数が分かっているなら、それが種別の根拠。
    // **一覧だけの更新で、作品ページ由来の種別を潰さないこと。**
    // （完結済みシリーズは一覧からは映画に見えるので、上書きすると壊れる）
    const episodes = detail?.episodeCount ?? prev?.episodeCount
    const type = episodes
      ? episodes > 1
        ? 'series'
        : 'movie'
      : (work.type as 'movie' | 'series')

    // ジャンルは最初に見つけたものを残す。同じ作品が複数ジャンルに出るため、
    // 上書きすると巡回の順番でジャンルが変わってしまう。
    const genreKey = prev?.genreKey ?? String(work.meta.genreKey)
    const genreLabel = prev?.genreLabel ?? String(work.meta.genreLabel)

    const next = upsert(this.#store, {
      id: work.id,
      title: work.title,
      type,
      genreKey,
      genreLabel,
      lineup: (detail?.lineup ? lineupOf(detail.lineup) : work.meta.lineup) as Lineup,
      episodeCount: detail?.episodeCount,
      year: work.year,
      seriesName: detail?.seriesName,
      country: detail?.country,
      publicStartDate: detail?.publicStartDate,
      publicEndDate: detail?.publicEndDate,
      publicEndText: detail?.publicEndText,
      detailCheckedAt: detail ? seenAt : prev?.detailCheckedAt,
      seenAt,
      // 作品ページを開いたときだけ、終了日の取り下げを反映できるようにする
    }, detail ? DETAIL_OWNED_FIELDS : [])

    if (detail && endDateChanged(prev, next)) {
      this.#endDateChanges.push({
        id: work.id,
        title: work.title,
        from: prev!.publicEndDate!,
        to: next.publicEndDate!,
      })
    }
    return next
  }

  /**
   * 作品ページから取れた事実を Work に反映する。
   * 種別は一覧の推定より作品ページのほうが確実なので、ここで上書きする。
   */
  #applyDetail(work: Work, d: UnextDetail): void {
    work.meta = {
      ...work.meta,
      publicStartDate: d.publicStartDate,
      publicEndText: d.publicEndText,
      country: d.country,
      mainGenreName: d.mainGenreName,
      seriesName: d.seriesName,
      episodeCount: d.episodeCount,
      lineup: d.lineup ? lineupOf(d.lineup) : work.meta.lineup,
      typeSource: d.episodeCount ? 'detail' : 'heuristic',
      detailFetched: true,
    }
    if (d.productionYear) work.year = d.productionYear
    if (d.episodeCount) work.type = d.episodeCount > 1 ? 'series' : 'movie'
  }

  /**
   * 収集済みイベントに作品ページの情報を後から足す。
   *
   * 新着は件数が多いので、**台帳で重複を落としたあと**に呼ぶ。
   * 全件に作品ページを開くと、大半が「既に知っている作品」への無駄なアクセスになる。
   *
   * 予算(max_detail_views)を使い切ったら途中で止める。足せなかったぶんは
   * 配信開始日を持たないまま記録され、次回の実行で拾い直せる。
   *
   * @returns 実際に足せた件数
   */
  async enrich(events: ChangeEvent[]): Promise<number> {
    let done = 0
    for (const e of events) {
      if (this.#detailBudget <= 0) break
      if (e.work.meta.detailFetched) continue

      try {
        const d = await this.fetchDetail(e.work.id)
        if (!d) break
        this.#applyDetail(e.work, d)
        if (e.kind === 'new' && d.publicStartDate) e.at = d.publicStartDate
        this.#remember(e.work, e.collectedAt, d)
        done++
      } catch (err) {
        // 相手が止めろと言っているときは全体を止める。それ以外は1件諦めて進む。
        if (err instanceof BackoffError) throw err
        this.#detailFailed++
        console.warn(`  作品ページを取得できませんでした: ${e.work.title} (${e.work.id})`)
      }
    }
    return done
  }

  /** ランキング記事用の作品収集。U-NEXT では未対応。 */
  async collectWorks(_query: WorkQuery): Promise<Work[]> {
    throw new Error('U-NEXT ソースは collectWorks に未対応です（ランキング記事は別ソースで）')
  }
}
