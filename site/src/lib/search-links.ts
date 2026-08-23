/**
 * 作品名を各サービスのサイト内検索に渡すリンク。
 *
 * ■ なぜ「検索リンク」なのか
 * U-NEXT / Hulu の作品別配信状況を取れるAPIは個人ブログの予算では存在しない
 * （TMDB商用 $149/月、Watchmode $349/月）。
 * そこで「配信中」と主張せず、検索へ渡すリンクだけを置く。
 * 断定しないので誤情報にならず、読者は1クリックで確認できる。
 *
 * ★ URLテンプレートは theme-packs/streaming-jp/theme.yaml の `search_links` と
 *   同じもの。**片方だけ直すと記事と常設ページで挙動がずれる。必ず両方直す。**
 *   サイト側は独立した npm プロジェクトで YAML を読まないため、こう持っている。
 *   （2026-08-01 に疎通確認済み）
 *
 * ■ 成果計測
 *   U-NEXT / Hulu … バリューコマース LinkSwitch がブラウザ側で自動変換する
 *   Amazon        … build 時に rehype-affiliate が tag= を付ける
 *   DMM TV        … 当面アフィリエイト対象外（docs/AFFILIATE.md 5-3）
 *   どれもこのファイルではアフィリエイト化しない。URLを組むだけ。
 */

export interface SearchLink {
  label: string
  url: string
}

function q(title: string): string {
  // 邦題の区切り記号はそのまま渡すとヒットしにくい（例: ゴースト/ニューヨークの幻）
  return encodeURIComponent(title.replace(/[/／]/g, ' ').replace(/\s+/g, ' ').trim())
}

/**
 * 見放題を「他で探す」ためのリンク。
 * 見放題が終わる作品に対して渡せる、最も実用的な次の一手。
 */
export function otherServiceLinks(title: string): SearchLink[] {
  const query = q(title)
  return [
    { label: 'U-NEXT', url: `https://video.unext.jp/freeword?query=${query}` },
    { label: 'Hulu', url: `https://www.hulu.jp/search?q=${query}` },
    { label: 'DMM TV', url: `https://tv.dmm.com/search/?keyword=${query}` },
  ]
}

/**
 * Amazon のビデオ内検索。
 *
 * ★ 見放題ではなく**レンタル・購入**を探すリンク。
 *   見放題が終わった作品でも買えば観られることが多く、これは事実として言える。
 *   tag= は付けない（ビルド時に rehype-affiliate が付ける）。
 */
export function amazonVideoLink(title: string): SearchLink {
  return {
    label: 'Amazon（レンタル・購入）',
    url: `https://www.amazon.co.jp/s?k=${q(title)}&i=instant-video`,
  }
}
