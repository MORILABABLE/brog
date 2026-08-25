/**
 * 実ブラウザでページを開き、そのページ自身が投げた API 応答を受け取る層。
 *
 * ■ なぜブラウザが要るのか
 * U-NEXT は**検索エンジンのUAにだけ**サーバー側で中身を描画する。
 * Chrome / curl / 自称ボットのUAではどれも空の器しか返らない（実測）。
 * つまり選択肢は2つしかない。
 *
 *   1. Googlebot を名乗る  → 検索エンジンだと偽ることになる。**採らない**
 *   2. ブラウザで普通に開く → 身分を偽らない。**こちらを採る**
 *
 * GraphQL を直接叩く道は塞がれている（persisted query safelist により
 * 自前で組み立てた問い合わせは 403 QUERY_NOT_IN_SAFELIST で弾かれる）。
 * ブラウザに正規の問い合わせを投げさせて、その応答を横で受け取るのが唯一の道。
 *
 * ■ HTMLを解析しない
 * ページのHTMLをパースするのではなく、ページが取得した JSON をそのまま受け取る。
 * 画面の作りが変わっても壊れないし、型のついたデータが手に入る。
 *
 * ■ 相手のサーバーへの負荷（規約 第25条(7)「過度の負担を及ぼす行為」）
 * ここは自分で制御できる唯一の項目なので、既定を安全側に倒している。
 *   - 遷移と遷移の間に最低 MIN_INTERVAL_MS 空ける
 *   - 画像・動画・フォントは読み込まない（相手の転送量を大きく減らす）
 *   - 429 / 503 を受けたら**その場で全体を止める**（粘らない）
 * 岡崎市立図書館事件(2010)は規約違反ではなく負荷で刑事事件になった実例で、
 * 「止め方」を決めておくことが対策の本体になる。
 */
import type { Browser, BrowserContext, Page, Response } from 'playwright'

/** 遷移と遷移の間に空ける最小の間隔（ミリ秒） */
export const DEFAULT_MIN_INTERVAL_MS = 2500

/** 1回の実行で開くページ数の上限。暴走したときの保険。 */
export const DEFAULT_MAX_PAGE_VIEWS = 600

export interface PoliteBrowserOptions {
  /** 遷移の最小間隔（ミリ秒） */
  minIntervalMs?: number
  /** 1回の実行で開けるページ数の上限 */
  maxPageViews?: number
  /** ページ読み込みのタイムアウト（ミリ秒） */
  timeoutMs?: number
  /**
   * 使うブラウザ。既定は msedge → chrome → 同梱 Chromium の順で試す。
   * Windows には Edge が必ずあるので、開発機ではダウンロードが要らない。
   * CI(ubuntu) では `npx playwright install chromium` で同梱版が入る。
   */
  channels?: string[]
}

/** 相手が「今は無理」と言っている状態。粘らずに全体を止めるための型。 */
export class BackoffError extends Error {
  constructor(readonly status: number, url: string) {
    super(`${status} を受けたので収集を中止します: ${url}`)
    this.name = 'BackoffError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 読み込まないリソース。相手の転送量を減らすためで、こちらの速度は副次的。 */
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font'])

export class PoliteBrowser {
  #browser?: Browser
  #context?: BrowserContext
  #page?: Page
  #lastNavigatedAt = 0
  #pageViews = 0

  readonly #minIntervalMs: number
  readonly #maxPageViews: number
  readonly #timeoutMs: number
  readonly #channels: string[]

  constructor(opts: PoliteBrowserOptions = {}) {
    this.#minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.#maxPageViews = opts.maxPageViews ?? DEFAULT_MAX_PAGE_VIEWS
    this.#timeoutMs = opts.timeoutMs ?? 45_000
    this.#channels = opts.channels ?? ['msedge', 'chrome']
  }

  /** 開いたページ数。実行ログに出して、相手にかけた負荷を可視化する。 */
  get pageViews(): number {
    return this.#pageViews
  }

  async #ensurePage(): Promise<Page> {
    if (this.#page) return this.#page

    // playwright は重いので、実際に使うときまで読み込まない。
    // 収集以外の CLI（write / preview など）に依存を持ち込まないため。
    const { chromium } = await import('playwright')

    let lastErr: unknown
    for (const channel of [...this.#channels, undefined]) {
      try {
        this.#browser = await chromium.launch({ channel, headless: true })
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!this.#browser) {
      throw new Error(
        'ブラウザを起動できませんでした。Edge か Chrome を入れるか、' +
          '`npx playwright install chromium` を実行してください。\n' +
          (lastErr instanceof Error ? lastErr.message : String(lastErr)),
      )
    }

    this.#context = await this.#browser.newContext({
      locale: 'ja-JP',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'ja-JP,ja;q=0.9' },
    })
    this.#page = await this.#context.newPage()

    // 画像・動画・フォントを読まない。1ページあたりの転送量が桁で変わる。
    await this.#page.route('**/*', (route) =>
      SKIPPED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
    )

    return this.#page
  }

  /**
   * URL を開き、そのページが取得した JSON のうち条件に合う最初のものを返す。
   *
   * @param url      開くページ
   * @param apiHost  待ち受ける API のホスト（部分一致）
   * @param accept   欲しい応答かどうかの判定。複数の問い合わせが飛ぶため必須。
   */
  async fetchJson<T>(
    url: string,
    apiHost: string,
    accept: (json: unknown) => boolean,
  ): Promise<T> {
    if (this.#pageViews >= this.#maxPageViews) {
      throw new Error(
        `1回の実行で開けるページ数の上限(${this.#maxPageViews})に達しました。` +
          '対象を絞るか上限を上げてください。',
      )
    }

    const page = await this.#ensurePage()

    // 前回の遷移から最低限の間隔を空ける。相手のサーバーへの礼儀。
    const wait = this.#minIntervalMs - (Date.now() - this.#lastNavigatedAt)
    if (wait > 0) await sleep(wait)

    const matched = page.waitForResponse(
      async (res: Response) => {
        if (!res.url().includes(apiHost)) return false
        try {
          return accept(await res.json())
        } catch {
          return false
        }
      },
      { timeout: this.#timeoutMs },
    )
    // 待ち受けを張った時点で拾い損ねはないが、goto が失敗したときに
    // waitForResponse が宙に浮いて unhandled rejection になるのを防ぐ。
    matched.catch(() => {})

    this.#lastNavigatedAt = Date.now()
    this.#pageViews++

    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.#timeoutMs })
    const status = nav?.status() ?? 0
    if (status === 429 || status === 503) throw new BackoffError(status, url)

    const res = await matched
    if (res.status() === 429 || res.status() === 503) throw new BackoffError(res.status(), url)

    return (await res.json()) as T
  }

  async close(): Promise<void> {
    await this.#page?.close().catch(() => {})
    await this.#context?.close().catch(() => {})
    await this.#browser?.close().catch(() => {})
    this.#page = undefined
    this.#context = undefined
    this.#browser = undefined
  }
}
