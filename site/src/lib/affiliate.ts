/**
 * アフィリエイトの共通ロジック。
 *
 * **リンクの体裁を決めるのはここ1か所だけ。**
 * ビルド時のリンク書き換え（plugins/rehype-affiliate.ts）と
 * Astroコンポーネントの両方がこのファイルを読む。
 *
 * ■ 収益経路が2つあり、性質がまったく違う
 *
 *   Amazon  : URLに tag= を付けるだけ。JS不要。24時間クッキーが効く。
 *   その他   : バリューコマース LinkSwitch（JS）がブラウザ側で
 *             通常リンクをアフィリエイトリンクに変換する。
 *             **記事のURLを書き換える必要がない**ので、
 *             自動生成した記事にそのまま効く。
 *
 * ■ DMM TV を意図的に除外している（2026-08-23 の判断）
 *   DMM は FANZA と同一基盤のため、AdSense 審査へのリスクが残る。
 *   単価は最高（afb 1,691円）だが、審査を通すまでアフィリエイト化しない。
 *   読者向けの検索リンクとしては有用なので、リンク自体は残す。
 *   解禁するときは EXCLUDED_HOSTS から 'tv.dmm.com' を消し、
 *   AFFILIATE_HOSTS に移すだけでよい。
 */

/** Amazon のホスト。ここに一致したら tag= を付ける。 */
export const AMAZON_HOSTS = ['amazon.co.jp', 'www.amazon.co.jp', 'amzn.to', 'amzn.asia']

/**
 * 成果報酬の対象になるホスト。`rel="sponsored"` を付ける対象でもある。
 *
 * ★ Google はアフィリエイトリンクに sponsored（または nofollow）を要求する。
 *   付けないとリンクスキーム違反と判定されうるので、必ず通すこと。
 */
export const AFFILIATE_HOSTS = [
  ...AMAZON_HOSTS,
  'video.unext.jp',
  'www.unext.jp',
  'unext.jp',
  'www.hulu.jp',
  'hulu.jp',
  'abema.tv',
]

/**
 * アフィリエイト化しないホスト。AFFILIATE_HOSTS より優先される。
 * LinkSwitch 側でも同じものをブロック設定に入れること（docs/AFFILIATE.md）。
 */
export const EXCLUDED_HOSTS = ['tv.dmm.com', 'dmm.com', 'www.dmm.com']

/**
 * Amazon の導線の種類。**トラッキングIDを分ける単位**（2026-09-03 追加）。
 *
 * ■ なぜ分けるのか
 * サイト内の Amazon リンクは 3,140本あるが、出ている場所は5種類しかない。
 * IDが1本だと、アソシエイトのレポートは**その5種類の合計**しか返さない。
 * 「節ポスターが効いているのか、表なのか、追従枠なのか」が分からないまま
 * 導線を増減させることになる。**出し分けの前に、まず分けて測る。**
 *
 * ★ ここに足しただけでは1円も動かない。**アソシエイト・セントラルで
 *   実際に作成したIDだけ**を .env に入れること。
 *   未登録のトラッキングIDでの発生分は紹介料として計上されない。
 *   未設定の枠は既定ID（PUBLIC_AMAZON_TAG）に落ちるので、
 *   1つずつ作って1つずつ足していける。
 */
export const AMAZON_SLOTS = ['poster', 'table', 'cta', 'rail', 'work', 'body'] as const

export type AmazonSlot = (typeof AMAZON_SLOTS)[number]

/**
 * 枠 → トラッキングid。`default` だけが必須で、**残りは無くてよい**。
 *
 * 組み立てているのは2か所。**どちらも同じ環境変数を読む。**
 *   src/config.ts       … .astro コンポーネント用（import.meta.env）
 *   astro.config.mjs    … rehype プラグイン用（loadEnv）
 * astro.config は Astro が .env を読む前に評価されるので、import.meta.env が使えない。
 * この二重化は GA・LinkSwitch と同じ事情によるもので、避けられない。
 */
export type AmazonTags = { default: string } & Partial<Record<AmazonSlot, string>>

/**
 * その枠に使うトラッキングid。**未設定なら既定に落ちる。**
 *
 * ★ 空文字は「未設定」として扱う（`??` ではなく `||`）。
 *   .env に `PUBLIC_AMAZON_TAG_RAIL=` と書いただけの行を
 *   「空のIDを指定した」と解釈すると、その枠だけ tag= が消えて無報酬になる。
 */
export function tagFor(tags: AmazonTags, slot?: AmazonSlot): string {
  return (slot && tags[slot]) || tags.default
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null
  } catch {
    return null
  }
}

export function isExcluded(url: string): boolean {
  const h = hostOf(url)
  return h !== null && EXCLUDED_HOSTS.includes(h)
}

export function isAmazon(url: string): boolean {
  const h = hostOf(url)
  return h !== null && AMAZON_HOSTS.includes(h)
}

export function isAffiliate(url: string): boolean {
  if (isExcluded(url)) return false
  const h = hostOf(url)
  return h !== null && AFFILIATE_HOSTS.includes(h)
}

export function isExternal(url: string): boolean {
  return hostOf(url) !== null
}

/**
 * Amazon のURLにトラッキングIDを付ける。
 *
 * 検索結果URLでも商品URLでも同じように効く。これが要件の要で、
 * 「他のサービスで探す」から検索しただけでもクッキーが乗る。
 *
 * すでに tag= が付いている場合は**上書きする**。
 * 記事側に古いIDが焼き込まれていても、build時に必ず現在のIDへ揃う。
 */
export function withAmazonTag(url: string, tag: string): string {
  if (!tag || !isAmazon(url)) return url
  try {
    const u = new URL(url)
    u.searchParams.set('tag', tag)
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Amazon のビデオ内検索URL。
 *
 * `i=instant-video` で Prime Video の売り場に絞る。
 * 見放題が終わった作品でも、レンタル・購入なら観られることが多いので、
 * 配信終了記事から渡せる数少ない「次の一手」になる。
 */
export function amazonVideoSearchUrl(query: string, tag: string): string {
  const u = new URL('https://www.amazon.co.jp/s')
  u.searchParams.set('k', query)
  u.searchParams.set('i', 'instant-video')
  if (tag) u.searchParams.set('tag', tag)
  return u.toString()
}

/**
 * 外部リンクに付ける rel を決める。
 *
 * ★ noreferrer を付けてはいけない（アフィリエイトリンクの場合）。
 *   ASP と Amazon はリファラで成果を判定するため、
 *   noreferrer を付けると**成果が計上されなくなる**。
 *   noopener だけならリファラは送られる。
 */
export function relFor(url: string): string {
  if (!isExternal(url)) return ''
  if (isAffiliate(url)) return 'sponsored noopener'
  return 'noopener noreferrer'
}
