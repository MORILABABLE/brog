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

/**
 * 画像URL。キーは `w240` `w480` … の幅指定。
 *
 * **URLは署名付きで、有効期限は6〜12ヶ月**（`?Expires=` に入っている）。
 * サイトはこれをビルド時に取得して自分のドメインから配信する。
 * 再ホストは提供元の許諾済み（2026-08-25）で、
 * 「最低でも6ヶ月ごとに取り直すこと」を推奨されている。
 *   → 取り直しは `npm run refresh:images`
 */
interface ApiImageSet {
  verticalPoster?: Record<string, string>
  horizontalPoster?: Record<string, string>
  verticalBackdrop?: Record<string, string>
  horizontalBackdrop?: Record<string, string>
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

/** `fetchAvailability()` が返す1サービスぶん。core/availability.ts の型と揃える。 */
export interface ServiceAvailabilityRow {
  service: string
  types: string[]
  link?: string
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

  /**
   * このインスタンスが投げたリクエスト数。
   * 無料枠(500req/月)の消費は 429 が返るまで見えないので、自分で数えて
   * `data/api-usage.json` に積む。リトライも枠を消費する前提で1回と数える。
   */
  #requests = 0

  get requestCount(): number {
    return this.#requests
  }

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
      this.#requests++
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

  /**
   * キーワードで**在庫**を取る。`/changes` とは別の口。
   *
   * ■ なぜキーワードなのか
   * `/shows/{id}` は1作品1リクエストだが、`/shows/search/filters` は
   * **シリーズをまとめて返す**。実測（2026-09-06）で
   * `keyword=Harry Potter` が **8作品を1リクエスト**で返した。
   * 無料枠は500/月しかないので、この差が施策の可否を分ける
   * （docs/CROSS-SERVICE.md 9-4）。
   *
   * ■ 突き合わせは `show.id`
   * 返ってくる `id` は**収集イベントの `work.id` と同じ体系**（実測で一致を確認）。
   * 題名の正規化で突き合わせる必要がない。
   *
   * ★ **`catalogs` を絞らない。** 絞っても他社の取扱は返るが、
   *   絞ると**その catalog に無い作品が結果から落ちる**。
   *   「Netflixで終わる作品が Prime にあるか」を知りたいので、
   *   落としてはいけないのはまさにその作品。
   *
   * ★ **`streamingOptions` をそのまま返さない。** テーマのサービスキーへ
   *   解決したうえで、取扱区分（subscription / addon / rent / buy）を保つ。
   *   `addon` を捨てないのは、**捨てると「無い」と「別料金である」の
   *   区別が付かなくなる**ため（判定は core/availability.ts）。
   */
  /**
   * **作品IDを名指しで**在庫を取る。キーワード検索の取りこぼしを拾う口。
   *
   * ■ なぜ要るか
   * `fetchAvailability()`（キーワード）は**まとめて取れるが、当たらないことがある。**
   * 2026-09-06 の実測で「Transformers」は60作を返したのに、
   * **こちらが持っている5作のIDが1件も含まれていなかった**
   * （検索の並び順とページングの都合で、後ろのページに居たとみられる）。
   *
   * **1作品1リクエスト。** 枠を食うので、
   * **キーワードで取りこぼしたぶんだけ**に使うこと（cli/availability.ts）。
   */
  async fetchAvailabilityById(
    showId: string,
  ): Promise<{ services: ServiceAvailabilityRow[] } | undefined> {
    let show: ApiShow
    try {
      show = await this.#get<ApiShow>(`/shows/${encodeURIComponent(showId)}`, {
        country: this.theme.country,
        output_language: this.theme.api_language,
      })
    } catch {
      // 404（その国に無い等）は「分からない」。**落とさない。**
      return undefined
    }
    const byService = new Map<string, ServiceAvailabilityRow>()
    for (const o of show.streamingOptions?.[this.theme.country] ?? []) {
      const apiId = o.service?.id
      if (!apiId || !o.type) continue
      const key = this.#serviceByCatalogId.get(apiId)?.key ?? apiId
      const row = byService.get(key) ?? { service: key, types: [], link: o.link }
      if (!row.types.includes(o.type)) row.types.push(o.type)
      if (!row.link && o.link) row.link = o.link
      byService.set(key, row)
    }
    return { services: [...byService.values()] }
  }

  /**
   * キーワードで在庫を引く。**作品そのものも返す**（`--adopt` が素材にする）。
   *
   * ★ **既定のページ数を3から8に上げた（2026-09-07）。**
   *   `docs/CROSS-SERVICE.md` 9-3 は「Transformers は60作を返したのに
   *   こちらの5作が1件も含まれていなかった。**後ろのページに居たとみられる**」と
   *   推測で書いていたが、実測でそのとおりだった。
   *
   *     keyword=Kamen Rider   3ページ 60件 → こちらの3作が入らない
   *                           5ページ 93件 → 3作とも入った（hasMore が尽きた）
   *
   *   1ページ＝1リクエストなので、上げても月500の枠に対して安い。
   *   **打ち切りは「在庫が無い」に化ける**ので、枠より取りこぼしのほうが高くつく。
   */
  async fetchAvailability(
    keyword: string,
    opts: { maxPages?: number; subscriptionOnly?: boolean } = {},
  ): Promise<Map<string, { services: ServiceAvailabilityRow[]; work: Work }>> {
    const out = new Map<string, { services: ServiceAvailabilityRow[]; work: Work }>()
    let cursor: string | undefined
    const maxPages = opts.maxPages ?? 8

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string | number> = {
        country: this.theme.country,
        keyword,
        output_language: this.theme.api_language,
        series_granularity: 'show',
      }
      /*
       * ★ **見放題を探すときは `catalogs` で絞る**（2026-09-07）。
       *   絞らないと応答がレンタル・購入で埋まり、見放題の作品が
       *   後ろのページへ押し出される。**それは「在庫が無い」に化ける。**
       *
       *     keyword=Kamen Rider          5ページ93件 → 見放題14件（1件取りこぼし）
       *     ＋ catalogs=…subscription    1ページ15件 → 見放題15件（hasMore=false）
       *
       *   絞っても**他社の取扱は応答に残る**（`apple:rent` 等）ので、
       *   表の下に出す「他社の在庫」は今までどおり作れる（docs/CROSS-SERVICE.md 2-1）。
       */
      if (opts.subscriptionOnly) params.catalogs = this.theme.catalogs.map((c) => c.id).join(',')
      if (cursor) params.cursor = cursor

      const res = await this.#get<{
        shows?: ApiShow[]
        hasMore?: boolean
        nextCursor?: string
      }>('/shows/search/filters', params)

      for (const show of res.shows ?? []) {
        if (show.id == null) continue
        const byService = new Map<string, ServiceAvailabilityRow>()
        for (const o of show.streamingOptions?.[this.theme.country] ?? []) {
          const apiId = o.service?.id
          if (!apiId || !o.type) continue
          // API のサービスIDをテーマのキーへ。未知のサービスはそのまま残す
          // （zee5 のような対象外も「そこにある」という事実ではあるため）。
          const key = this.#serviceByCatalogId.get(apiId)?.key ?? apiId
          const row = byService.get(key) ?? { service: key, types: [], link: o.link }
          if (!row.types.includes(o.type)) row.types.push(o.type)
          if (!row.link && o.link) row.link = o.link
          byService.set(key, row)
        }
        out.set(String(show.id), { services: [...byService.values()], work: toWork(show) })
      }

      if (!res.hasMore || !res.nextCursor) break
      cursor = res.nextCursor
    }
    return out
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

  /**
   * 1作品の画像URLだけを取り直す。**1作品につき1リクエスト**。
   *
   * 署名付きURLは6〜12ヶ月で失効する。失効すると過去記事の画像が
   * ビルドのたびに取得できなくなり、文字だけのカードに戻ってしまう。
   * サイトが実際に使っている作品（data/image-manifest.json）だけを
   * 期限前に取り直すために使う。呼ぶのは `npm run refresh:images`。
   */
  async fetchImages(showId: string): Promise<{ posterUrl?: string; backdropUrl?: string }> {
    const show = await this.#get<ApiShow>(`/shows/${encodeURIComponent(showId)}`, {
      country: this.theme.country,
      output_language: this.theme.api_language,
      series_granularity: 'show',
    })
    return { posterUrl: pickPoster(show), backdropUrl: pickBackdrop(show) }
  }

  /**
   * 作品1件を引く。**1作品につき1リクエスト**。
   *
   * `showId` には API の作品IDのほか **IMDb ID（tt…）をそのまま渡せる**
   * （2026-08-28 に実測: `/shows/tt1375666` → Inception）。
   *
   * これがあると「配信各社の告知にある邦題」から作品を特定できる。
   *   邦題 → Wikidata で IMDb ID → ここで作品 → ポスター・年・ジャンル
   * 告知そのものには画像も年もジャンルも無いので、
   * **記事の画像を従来と同じ経路（許諾済み）で用意する唯一の道**になる。
   *   → pipeline/sources/title-lookup.ts / `npm run collect:announce`
   *
   * 見つからなければ 404 で例外になるので、呼び出し側で握って undefined にすること。
   */
  async fetchShow(showId: string): Promise<Work> {
    const show = await this.#get<ApiShow>(`/shows/${encodeURIComponent(showId)}`, {
      country: this.theme.country,
      output_language: this.theme.api_language,
      series_granularity: 'show',
    })
    return toWork(show)
  }
}

/**
 * 縦位置のポスター。記事のセクション画像に合成する。
 * w480 を基準にするのは、サイトでの表示（170×255）に対して十分な解像度があり、
 * かつ1枚50KB前後に収まるため。
 */
function pickPoster(show: ApiShow): string | undefined {
  const set = show.imageSet?.verticalPoster ?? {}
  return set.w480 ?? set.w360 ?? Object.values(set)[0]
}

/**
 * 横位置のキーアート。**まだサイトでは使っていない。**
 * 記事冒頭の横長画像（frontmatter の heroImage、16:7）に使える形なので、
 * 収集の時点で落とさずに持っておく。取得コストは増えない
 * （/changes の応答に最初から入っている）。
 */
function pickBackdrop(show: ApiShow): string | undefined {
  const set = show.imageSet?.horizontalBackdrop ?? show.imageSet?.horizontalPoster ?? {}
  return set.w1080 ?? set.w720 ?? set.w480 ?? Object.values(set)[0]
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
    posterUrl: pickPoster(show),
    backdropUrl: pickBackdrop(show),
    link,
    meta: {
      imdbId: show.imdbId,
      tmdbId: show.tmdbId,
    },
  }
}
