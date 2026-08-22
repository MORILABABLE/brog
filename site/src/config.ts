/**
 * サイト全体の設定。ここ以外に文字列を散らさない。
 * ドメイン取得後に url を差し替えれば全体に反映される。
 */
export const SITE = {
  name: '観とこう',
  /** トップページのタイトルに使う短い一句。説明文の切り貼りにしない。 */
  tagline: '配信終了前に、観とこう。',
  /**
   * 検索結果やOGPで使う説明。meta description の推奨長（全角120字）に収める。
   *
   * ★ 配信終了について Disney+ / Apple TV+ を挙げないのは意図的。
   *   API が expiring（配信終了予定）を返すのは実測で Netflix と Prime Video の
   *   2社だけで、この2社は配信終了記事に構造的に載らない。
   *   詳細は theme-packs/streaming-jp/theme.yaml の catalogs 節。
   */
  description:
    'Netflix・Amazon Prime Video で配信が終了する作品と、Disney+ を含む新しく配信が始まった作品を追いかけるサイト。観たかった作品を見逃す前に。',
  /** 本番URL。末尾スラッシュなし。 */
  url: 'https://mitokou.com',
  locale: 'ja-JP',
  /** 運営者名。お問い合わせ・運営者情報ページで使う。 */
  author: '観とこう編集部',
} as const

/**
 * SNSで共有されたときに表示される既定の画像（OGP）。
 *
 * **絶対URLで出す必要がある。** 相対パスだと X や Slack が解決できず、
 * カードが画像なしで出る。組み立ては BaseLayout.astro 側で行う。
 *
 * 絵はヘッダーバナーと同じだが、**寸法が違う**。
 * バナーは 1200×463（2.59:1）、OGPの推奨は 1.91:1 なので、
 * バナーの上下にぼかした背景を継ぎ足して 1200×628 にしたものを置いている。
 * ファイルは site/public/og-default.jpg。作り直す手順は docs/APPEARANCE.md。
 */
export const OG_IMAGE = {
  path: '/og-default.jpg',
  /** 差し替えるときは 1200×630 前後（1.91:1）を守る。各SNS共通の推奨比率。 */
  width: 1200,
  height: 628,
  alt: '観とこう｜主要動画サービスの見放題配信タイトルは観れるうちに',
} as const

/**
 * 配信情報の提供元表記。API利用規約で必須。
 * サイトフッターと各記事の両方に表示する義務がある。
 */
export const ATTRIBUTION = {
  text: '配信情報は Streaming Availability API by Movie of the Night 提供',
  url: 'https://www.movieofthenight.com/about/api',
} as const

/**
 * 記事カテゴリ。パイプライン側の記事タイプと対応する。
 * pipeline/core/article.ts の Category 型と揃えること。
 *
 * ★ leaving と ended は必ず分ける。
 *   leaving = これから終了する（まだ観られる）
 *   ended   = すでに終了した（もう観られない）
 *   読者に渡すものが正反対なので、ラベルでも明確に区別する。
 *   ここの並び順がヘッダーのメニュー順になる。
 */
export const CATEGORIES = {
  leaving: { slug: 'leaving', label: '配信終了予定' },
  ended: { slug: 'ended', label: '配信終了済み' },
  arrivals: { slug: 'arrivals', label: '新着配信' },
  ranking: { slug: 'ranking', label: 'ランキング' },
} as const

export type CategorySlug = keyof typeof CATEGORIES

/**
 * AdSense のパブリッシャーID。
 * **審査に通るまでは未設定のままにすること。** 未設定なら広告枠は描画されない。
 * 設定するときは site/.env に PUBLIC_ADSENSE_CLIENT=ca-pub-xxxx を置く。
 */
export const ADSENSE_CLIENT = import.meta.env.PUBLIC_ADSENSE_CLIENT ?? ''
