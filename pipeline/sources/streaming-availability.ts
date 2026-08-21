/**
 * Streaming Availability API (Movie of the Night) アダプタ。
 * https://docs.movieofthenight.com/
 *
 * ■ なぜこのAPIか
 * TMDB / Watchmode は無料枠が「非商用限定」で、広告やアフィリエイトを載せる
 * サイトでは規約違反になる。このAPIは商用利用を明示的に許可している唯一の選択肢。
 *   TERMS.md: "The API User can use the data provided for commercial purposes."
 *
 * ■ 帰属表示の義務
 * 記事・サイトに「配信情報は Streaming Availability API by Movie of the Night 提供」
 * の旨とリンクを表示する必要がある。ATTRIBUTION 定数を使うこと。
 *
 * ■ /changes を使う理由
 * 配信の開始・終了が専用エンドポイントで取れるため、全カタログを毎日走査して
 * 差分を取る必要がない。expiring は「終了予定日」まで返るので、
 * 終了告知記事を推測ではなく確定情報で書ける。
 */
import type {
  ChangeEvent,
  ChangeKind,
  CollectOptions,
  Source,
  Work,
  WorkQuery,
} from './types.ts'
import type { CatalogConfig, Theme } from '../theme.ts'

const BASE = 'https://api.movieofthenight.com/v4'

/** 帰属表示。サイトフッターと各記事に必須。 */
export const ATTRIBUTION = {
  text: '配信情報は Streaming Availability API by Movie of the Night 提供',
  url: 'https://www.movieofthenight.com/about/api',
} as const

/** /changes は 1ページ 25件固定 */
const CHANGES_PAGE_SIZE = 25

/** 無料枠(500req/月)を1回の実行で使い切らないための保険 */
const MAX_PAGES_PER_CALL = 8

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- API レスポンスの型 -------------------------------------------------
// 実レスポンスでの検証がまだ済んでいないため、必須フィールドを最小限にし、
// 欠けても落ちないようにしている。`npm run probe` で生レスポンスを確認できる。

interface ApiImageSet {
  verticalPoster?: Record<string, string>
  horizontalPoster?: Record<string, string>
}

interface ApiShow {
  id: string
  imdbId?: string
  tmdbId?: string
  title?: string
  /** 原語のタイトル。日本の作品は日本語表記で返る。 */
  originalTitle?: string
  overview?: string
  showType?: string
  releaseYear?: number
  firstAirYear?: number
  rating?: number
  genres?: { id?: string; name?: string }[]
  /** ローマ字表記で返る */
  directors?: string[]
  /** ローマ字表記で返る */
  cast?: string[]
  imageSet?: ApiImageSet
  streamingOptions?: Record<string, ApiStreamingOption[]>
}

interface ApiStreamingOption {
  service?: { id?: string; name?: string }
  type?: string
  link?: string
  expiresSoon?: boolean
  /** Unix 秒 */
  expiresOn?: number
}

interface ApiChange {
  showId?: string | number
  changeType?: string
  itemType?: string
  showType?: string
  /** 実レスポンスではオブジェクト。文字列ではない点に注意。 */
  service?: { id?: string; name?: string }
  /** subscription | rent | buy | free | addon */
  streamingOptionType?: string
  /** Unix 秒。expiring/upcoming では欠けることがある */
  timestamp?: number
  /** 作品ページへのディープリンク。show 側より確実なのでこちらを優先する。 */
  link?: string
}

interface ApiChangesResponse {
  changes?: ApiChange[]
  shows?: Record<string, ApiShow>
  hasMore?: boolean
  nextCursor?: string
}

interface ApiSearchResponse {
  shows?: ApiShow[]
  hasMore?: boolean
  nextCursor?: string
}

// --- アダプタ本体 -------------------------------------------------------

export class StreamingAvailabilitySource implements Source {
  readonly name = 'streaming-availability'

  /** catalog id -> theme.yaml のサービスキー。API の応答をテーマ語彙に戻すため。 */
  #serviceByCatalogId: Map<string, CatalogConfig>

  constructor(
    private readonly apiKey: string,
    private readonly theme: Theme,
  ) {
    if (!apiKey) {
      throw new Error('STREAMING_API_KEY が未設定です。.env を確認してください。')
    }
    this.#serviceByCatalogId = new Map(
      theme.catalogs.map((c) => [c.id.split('.')[0]!, c]),
    )
  }

  async #get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        headers: { 'X-API-Key': this.apiKey, accept: 'application/json' },
      })

      if (res.status === 429) {
        // 無料枠を使い切った場合もここに来る。判別のため本文を読む。
        const body = await res.text().catch(() => '')
        throw new Error(
          `レート上限またはクォータ超過 (429): ${body.slice(0, 200)}\n` +
            '無料枠は 500リクエスト/月です。',
        )
      }
      if (res.status >= 500) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`API ${res.status} ${res.statusText} :: ${path} :: ${body.slice(0, 200)}`)
      }
      return (await res.json()) as T
    }
    throw new Error(`リトライ上限に到達しました :: ${path}`)
  }

  /** 生レスポンスの確認用（フィールド名の検証に使う） */
  async raw(path: string, params: Record<string, string | number>): Promise<unknown> {
    return this.#get<unknown>(path, params)
  }

  async collectChanges(opts: CollectOptions): Promise<ChangeEvent[]> {
    const collectedAt = new Date().toISOString()
    const now = Math.floor(Date.now() / 1000)
    const from = now - opts.sinceDays * 86_400
    const out: ChangeEvent[] = []

    for (const kind of opts.kinds) {
      // expiring / upcoming は一部サービスしか対応していない（API の制約）
      const catalogs = this.theme.catalogs.filter((c) =>
        kind === 'expiring' || kind === 'upcoming' ? c.supports_upcoming : true,
      )
      if (catalogs.length === 0) continue

      for (const showType of this.theme.show_types) {
        // catalogs は最大32件までまとめて指定できるので、1リクエストに束ねる
        const params: Record<string, string | number> = {
          country: this.theme.country,
          change_type: kind,
          item_type: 'show',
          show_type: showType,
          catalogs: catalogs.map((c) => c.id).join(','),
          output_language: this.theme.api_language,
          order_direction: 'desc',
        }
        // 過去の変化のみ期間指定できる。未来の変化は from/to を受け付けない。
        if (kind === 'new' || kind === 'removed') {
          params.from = from
          params.to = now
        } else {
          params.include_unknown_dates = 'true'
        }

        out.push(...(await this.#pageChanges(params, kind, collectedAt)))
      }
    }
    return out
  }

  async #pageChanges(
    params: Record<string, string | number>,
    kind: ChangeKind,
    collectedAt: string,
  ): Promise<ChangeEvent[]> {
    const out: ChangeEvent[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const res = await this.#get<ApiChangesResponse>('/changes', {
        ...params,
        ...(cursor ? { cursor } : {}),
      })
      const shows = res.shows ?? {}

      for (const ch of res.changes ?? []) {
        const show = ch.showId != null ? shows[String(ch.showId)] : undefined
        if (!show) continue // 作品情報が引けない変化は記事にできないので捨てる

        const serviceId = ch.service?.id
        const catalog = serviceId ? this.#serviceByCatalogId.get(serviceId) : undefined
        out.push({
          collectedAt,
          service: catalog?.key ?? serviceId ?? 'unknown',
          kind,
          at: ch.timestamp ? new Date(ch.timestamp * 1000).toISOString() : undefined,
          work: toWork(show, ch.link),
        })
      }

      cursor = res.hasMore ? res.nextCursor : undefined
      pages++
      if (cursor && pages < MAX_PAGES_PER_CALL) await sleep(120)
    } while (cursor && pages < MAX_PAGES_PER_CALL)

    if (cursor) {
      console.warn(
        `  ! ${kind}: ${MAX_PAGES_PER_CALL}ページ(${MAX_PAGES_PER_CALL * CHANGES_PAGE_SIZE}件)で打ち切りました。` +
          'リクエスト枠を守るための上限です。',
      )
    }
    return out
  }

  async collectWorks(query: WorkQuery): Promise<Work[]> {
    const catalogs = query.services
      ? this.theme.catalogs.filter((c) => query.services!.includes(c.key))
      : this.theme.catalogs

    const params: Record<string, string | number> = {
      country: this.theme.country,
      catalogs: catalogs.map((c) => c.id).join(','),
      output_language: this.theme.api_language,
      order_by: 'popularity',
      order_direction: 'desc',
      series_granularity: 'show',
    }
    if (query.type) params.show_type = query.type
    if (query.genres?.length) {
      params.genres = query.genres.join(',')
      params.genres_relation = 'and'
    }
    if (query.keyword) params.keyword = query.keyword
    if (query.ratingMin != null) params.rating_min = query.ratingMin
    if (query.yearMin != null) params.year_min = query.yearMin
    if (query.yearMax != null) params.year_max = query.yearMax

    const out: Work[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const res = await this.#get<ApiSearchResponse>('/shows/search/filters', {
        ...params,
        ...(cursor ? { cursor } : {}),
      })
      for (const show of res.shows ?? []) {
        out.push(toWork(show))
        if (out.length >= query.limit) return out
      }
      cursor = res.hasMore ? res.nextCursor : undefined
      pages++
      if (cursor && pages < MAX_PAGES_PER_CALL) await sleep(120)
    } while (cursor && pages < MAX_PAGES_PER_CALL)

    return out
  }
}

/**
 * API の作品オブジェクトを、テーマ非依存の Work に正規化する。
 *
 * 注意: title / overview は **英語** で返る。
 * この API の output_language は en/es/fr/tr/de のみ対応で、日本語がない。
 * 邦題は書き出し時に別途解決する（DESIGN.md 3.6 参照）。
 * そのために imdbId / tmdbId を meta に保持しておく。
 *
 * ただし originalTitle だけは例外で、**日本の作品は日本語表記のまま返る**。
 * あらすじが欠けている作品（邦画に多い）でも、監督・出演者と合わせれば
 * 推測なしで1文書けるので、directors / cast も落とさずに持つ。
 */
function toWork(show: ApiShow, changeLink?: string): Work {
  const posters = show.imageSet?.verticalPoster ?? {}
  const poster = posters.w480 ?? posters.w360 ?? Object.values(posters)[0]

  // 変化側のディープリンクが最も確実。無ければ配信オプションから拾う。
  const link =
    changeLink ??
    Object.values(show.streamingOptions ?? {})
      .flat()
      .find((o) => o.link)?.link

  return {
    id: show.id,
    title: show.title ?? '',
    // 原題と同じなら持たない。イベントログを無駄に太らせないため。
    originalTitle: show.originalTitle && show.originalTitle !== show.title ? show.originalTitle : undefined,
    type: show.showType ?? 'movie',
    year: show.releaseYear ?? show.firstAirYear,
    overview: show.overview ?? '',
    rating: show.rating,
    genres: (show.genres ?? []).map((g) => g.name ?? '').filter(Boolean),
    // 記事で使うのは冒頭数名。全員入れてもプロンプトが太るだけで読者の役に立たない。
    directors: show.directors?.length ? show.directors.slice(0, 3) : undefined,
    cast: show.cast?.length ? show.cast.slice(0, 5) : undefined,
    posterUrl: poster,
    link,
    meta: {
      imdbId: show.imdbId,
      tmdbId: show.tmdbId,
    },
  }
}
