/**
 * サイト全体の設定。ここ以外に文字列を散らさない。
 * ドメイン取得後に url を差し替えれば全体に反映される。
 */
export const SITE = {
  name: '見放題レーダー',
  /** トップページのタイトルに使う短い一句。説明文の切り貼りにしない。 */
  tagline: '消える前に、気づける。',
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
  url: 'https://mihoudairader.com',
  locale: 'ja-JP',
  /** 運営者名。お問い合わせ・運営者情報ページで使う。 */
  author: '見放題レーダー編集部',
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
  alt: '見放題レーダー｜主要動画サービスの配信終了と新着をまとめて追う',
} as const

/**
 * 記事ごとのカード画像の寸法。
 * **site/scripts/make-cards.mjs の W / H と必ず揃えること。**
 * ここがずれると、SNS側が実物と違う寸法で確保して表示が崩れる。
 */
export const CARD_IMAGE = { width: 1200, height: 630 } as const

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
 *
 * ★ **これは記事に付けるラベル（バッジ）の定義であって、メニューではない。**
 *   読者に見せる入口は下の CATEGORY_HUBS で3つに束ねてある。
 */
export const CATEGORIES = {
  leaving: { slug: 'leaving', label: '配信終了予定' },
  ended: { slug: 'ended', label: '配信終了済み' },
  arrivals: { slug: 'arrivals', label: '新着配信' },
  ranking: { slug: 'ranking', label: 'ランキング' },
} as const

export type CategorySlug = keyof typeof CATEGORIES

/**
 * 一覧ページ（＝ハブ）の定義。**ヘッダーのメニューはここから作る。**
 *
 * ■ なぜカテゴリと分けるか
 * カテゴリは4つあるが、**読者にとっての入口は3つでよい**（2026-08-26）。
 * 「終了予定」と「終了済み」は記事の性質としては正反対でも、
 * 読者の用事はどちらも「終了まわりを見に来た」で同じ。
 * 入口で分けると、探しているものがどちらにあるか読者が判断させられる。
 *
 * 区別そのものは**カテゴリバッジの色と文言が担う**（アンバー＝予定 / グレー＝済み）。
 * 一覧の中で1行ずつ見分けが付くので、ページを分ける必要がない。
 *
 * ★ `includes` の**先頭がそのハブのURL**になる（`/category/<先頭>`）。
 *   2番目以降のカテゴリには専用ページを作らない。
 *   `public/_redirects` で先頭へ転送すること。**片方だけ直すと404が出る。**
 */
export const CATEGORY_HUBS = [
  {
    slug: 'leaving',
    label: '配信終了済み・予定',
    /** ページの h1。ナビは短く、見出しは中身の順に合わせる */
    heading: '配信終了予定・終了済み',
    description: '見放題配信が終了する予定の作品と、すでに終了した作品の記事一覧です。',
    includes: ['leaving', 'ended'],
  },
  {
    slug: 'arrivals',
    label: '新着配信',
    heading: '新着配信',
    description: '新しく見放題配信が始まった作品の記事一覧です。',
    includes: ['arrivals'],
  },
  {
    slug: 'ranking',
    label: 'ランキング',
    heading: 'ランキング',
    description: 'ランキング記事の一覧です。',
    includes: ['ranking'],
  },
] as const satisfies readonly {
  slug: CategorySlug
  label: string
  heading: string
  description: string
  includes: readonly CategorySlug[]
}[]

/**
 * そのカテゴリの記事が載るハブ。パンくずのリンク先に使う。
 * どのハブにも属さないカテゴリがあれば、そのカテゴリ自身を指す
 * （リンクは切れるが、ビルドは落とさない）。
 */
export function hubFor(category: CategorySlug): { slug: CategorySlug; label: string } {
  const hit = CATEGORY_HUBS.find((h) => (h.includes as readonly string[]).includes(category))
  return hit ?? { slug: category, label: CATEGORIES[category].label }
}

/**
 * AdSense のパブリッシャーID。
 * **審査に通るまでは未設定のままにすること。** 未設定なら広告枠は描画されない。
 * 設定するときは site/.env に PUBLIC_ADSENSE_CLIENT=ca-pub-xxxx を置く。
 */
export const ADSENSE_CLIENT = import.meta.env.PUBLIC_ADSENSE_CLIENT ?? ''

/**
 * アフィリエイト。**どちらも未設定なら、広告表記も含めて一切描画されない。**
 *
 * 未設定のまま「PR」と表示するのは景品表示法上むしろ不正確なので、
 * 表示・非表示はこの2つの値だけで決まるようにしてある。
 * 運用を始めるときは site/.env に値を入れるだけでよい（コード変更は不要）。
 *
 * 設定手順と提携状況は docs/AFFILIATE.md。
 */
export const AFFILIATE = {
  /**
   * Amazonアソシエイトのトラッキングid（`xxxxx-22` の形）。
   * これを入れると本文中の Amazon リンクに build 時 tag= が付く。
   */
  amazonTag: import.meta.env.PUBLIC_AMAZON_TAG ?? '',
  /**
   * バリューコマース LinkSwitch の vc_pid。
   * これを入れると、本文の U-NEXT / Hulu などの**通常リンクが
   * ブラウザ側で自動的にアフィリエイトリンクに変換される**。
   * 記事のURLを書き換える必要がないので、自動生成した記事にそのまま効く。
   */
  linkSwitchPid: import.meta.env.PUBLIC_VC_LINKSWITCH_PID ?? '',
} as const

/** アフィリエイトが1つでも有効か。広告表記の出し分けに使う。 */
export const AFFILIATE_ENABLED = Boolean(AFFILIATE.amazonTag || AFFILIATE.linkSwitchPid)
