import { tagFor, type AmazonSlot, type AmazonTags } from './lib/affiliate'

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
   * ★ 配信終了で名前を挙げるのは Amazon Prime Video / Netflix / U-NEXT の3社。
   *   **終了日を日付つきで取れるのがこの3社だけ**で、更新の主軸もここにある。
   *   Prime Video と Netflix は API が expiring（配信終了予定）を返す2社
   *   （実測。theme-packs/streaming-jp/theme.yaml の catalogs 節）。
   *   U-NEXT は API の外側にあり、U-NEXT 自身のページから自前で取っている（同 unext 節）。
   *
   * ★ 配信終了について Disney+ / Apple TV+ を挙げないのは意図的。
   *   終了予定を取れないので、配信終了予定の記事に構造的に載らない。
   *   Disney+ は終了後に「配信終了済み」としてまとめる形になる。
   */
  description:
    'Amazon Prime Video・Netflix・U-NEXT で見放題配信が終了する作品と、Disney+ を含む新しく配信が始まった作品を追いかけるサイト。観たかった作品を見逃す前に。',
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
 *
 * ★ `serviceMenu: true` のハブは、ヘッダーで**押すとサービス名が開く**
 *   （2026-08-27）。読者は「終了まわりを見たい」の次に必ず
 *   「どのサービスの話か」を選ぶので、その1手をメニューの中で済ませる。
 *   開いた先は `/category/<ハブ>/<サービス>`（category/[category]/[service].astro）。
 *   `false` のハブは今までどおり、押すとそのまま一覧へ飛ぶ。
 */
export const CATEGORY_HUBS = [
  {
    slug: 'leaving',
    label: '配信終了済み・予定',
    /** ページの h1。ナビは短く、見出しは中身の順に合わせる */
    heading: '配信終了予定・終了済み',
    description: '見放題配信が終了する予定の作品と、すでに終了した作品の記事一覧です。',
    includes: ['leaving', 'ended'],
    serviceMenu: true,
  },
  {
    slug: 'arrivals',
    label: '新着配信',
    heading: '新着配信',
    description: '新しく見放題配信が始まった作品の記事一覧です。',
    includes: ['arrivals'],
    serviceMenu: true,
  },
  {
    slug: 'ranking',
    label: 'ランキング',
    heading: 'ランキング',
    description: 'ランキング記事の一覧です。',
    includes: ['ranking'],
    /*
     * ★ ランキングだけメニューを開かない。
     *   記事がまだ1本も無く、サービスで割るとすべて空になる。
     *   記事が増えてサービス別に意味が出たら true にすればよい
     *   （ページ側は CATEGORY_HUBS を見て自動で増える）。
     */
    serviceMenu: false,
  },
] as const satisfies readonly {
  slug: CategorySlug
  label: string
  heading: string
  description: string
  includes: readonly CategorySlug[]
  serviceMenu: boolean
}[]

/** ヘッダーでサービス名を開くハブ。サービス別ページもこのハブ×SERVICE_HUBSぶん作る。 */
export const SERVICE_MENU_HUBS = CATEGORY_HUBS.filter((h) => h.serviceMenu)

/**
 * サービスの一覧。**ヘッダーのメニューを開いたときに出る5つ**（2026-08-27 に変更）。
 *
 * ■ カテゴリのハブ（CATEGORY_HUBS）と軸が違う
 *   カテゴリ … 「終了まわり」「新着」で束ねる。**何が起きたか**で探す読者向け
 *   サービス … 「プライムビデオの話だけ見たい」。**契約しているサービス**で探す読者向け
 * ヘッダーは「カテゴリ → サービス」の順に選ばせる形にしてあるので、
 * この一覧は次の3か所すべてに効く。
 *   1. ヘッダーのメニュー（Header.astro）
 *   2. カテゴリ×サービスのページ `/category/<ハブ>/<サービス>`
 *   3. サービス別まとめ `/service/<サービス>`（カテゴリをまたぐ従来のページ）
 *
 * ★ `tag` は記事の frontmatter `tags` に入る文字列と**完全に一致させること。**
 *   ページはタグで記事を拾う。1文字でも違うと0件のページができる。
 *   タグを出しているのは各記事タイプの `tags()`（theme-packs/…/article-types/）。
 *
 * ★ **記事が出ないサービスは並べない。**
 *   Hulu は一度メニューに入れたが外した（2026-08-27）。収集対象ですらなく
 *   （theme.yaml の catalogs 節。APIの日本カバレッジに無い）、記事が
 *   永久に0本のままで、押した先が空のページにしかならないため。
 *   Hulu の作品を扱えるようになったら、ここに1行足せば
 *   メニューもページも自動で戻る。
 *
 * ★ Apple TV+ も入れていない。記事1本・新着5件（2026-08 実測）で、
 *   メニューに常時1枠使うほどの量がない。
 *
 * ★ それでも**中身が0件になる組み合わせは起こりうる**
 *   （新しいサービスを足した直後・ハブを増やした直後）。
 *   0件のページは noindex にしてある。判定は
 *   lib/service-pages.ts の `serviceHasContent()` 1か所。
 */
export const SERVICE_HUBS = [
  { slug: 'prime-video', label: 'Amazon Prime Video', tag: 'Amazon Prime Video' },
  { slug: 'netflix', label: 'Netflix', tag: 'Netflix' },
  { slug: 'u-next', label: 'U-NEXT', tag: 'U-NEXT' },
  { slug: 'disney-plus', label: 'Disney+', tag: 'Disney+' },
] as const

export type ServiceHubSlug = (typeof SERVICE_HUBS)[number]['slug']

/**
 * 記事のジャンル。**カテゴリ・サービスとは別の3本目の軸**（2026-08-27 に追加）。
 *
 * ■ 3つの軸の違い
 *   カテゴリ … 何が起きたか（終了まわり／新着）。全記事が必ず1つ持つ
 *   サービス … どのサービスの話か。frontmatter の `tags` で拾う
 *   ジャンル … 何を観る話か（アニメ／洋画／邦画）。**持たない記事がある**
 *
 * ★ **ジャンルは「ジャンル軸の記事」だけが名乗る。**
 *   「Netflixで配信開始の作品199本」のようなサービス軸の記事は
 *   アニメも洋画も邦画も全部入っているので、1つのジャンルを名乗れない。
 *   frontmatter の `genre` は optional で、無い記事にはバッジが出ないだけ。
 *   （軸の考え方は pipeline/core/article.ts の `Axis`）
 *
 * ★ `key` は theme-packs/streaming-jp/genres.ts の `GenreKey` と揃えること。
 *   パイプラインが frontmatter に書く値がこれ。ずれるとサイト側のビルドが落ちる
 *   （content.config.ts の enum が検知する）。
 *
 * ★ `label` と `heading` を分けている理由は CATEGORY_HUBS と同じ。
 *   バッジと枠の中は短いほうがよく（アニメ／洋画／邦画）、
 *   ページの h1 と説明文は記事が扱う範囲を正確に言う必要がある
 *   （洋画記事には海外ドラマが、邦画記事には国内ドラマが入っている）。
 *
 * ★ `tag` は記事の frontmatter `tags` に入る文字列と**完全に一致させること。**
 *   出しているのは theme-packs/streaming-jp/genres.ts の `GENRES` の `label`。
 *   ジャンルの軸そのものは `genre` フィールドで判定するので、
 *   この `tag` は「タグの行にジャンルが出ているか」の確認用にとどめる。
 */
export const GENRES = {
  anime: { slug: 'anime', label: 'アニメ', heading: 'アニメ', tag: 'アニメ' },
  western: {
    slug: 'western',
    label: '洋画',
    heading: '洋画・海外ドラマ',
    tag: '洋画・海外ドラマ',
  },
  japanese: {
    slug: 'japanese',
    label: '邦画',
    heading: '邦画・国内ドラマ',
    tag: '邦画・国内ドラマ',
  },
} as const

export type GenreSlug = keyof typeof GENRES

/** ジャンルの並び順。**バッジ・枠・ページの並びをここ1か所で決める。** */
export const GENRE_HUBS = [GENRES.anime, GENRES.western, GENRES.japanese] as const

/**
 * ジャンル別の導線（右の枠のジャンル欄と `/genre/<スラッグ>` のページ）を出すか。
 *
 * ■ いまは false（2026-08-27）
 * ジャンル軸の記事が**各ジャンル1本ずつしか無い**。
 * 1本しか載らない一覧ページを作っても読者には行き止まりで、
 * 中身の薄いページをサイトマップに増やすだけになる。
 * **枠と仕組みだけ先に入れて、出すのは記事が溜まってから。**
 *
 * ■ true にすると何が出るか
 *   1. 右の枠の「ジャンルから探す」（FollowRail.astro の最新記事の上）
 *   2. `/genre/<スラッグ>` の一覧ページ（pages/genre/[genre].astro）
 * **この2つは必ず一緒に切り替わる。** 片方だけ出すとリンク先が404になる。
 *
 * ■ いつ true にするか
 * 各ジャンルに記事が3本前後たまったら。目安であって機械的な条件ではない。
 * 記事が0本のジャンルは true にしても枠に出ない（GenreRail.astro が落とす）。
 */
export const GENRE_NAV_ENABLED = false

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
 * Google アナリティクス（GA4）の測定ID（`G-` で始まる）。
 *
 * AdSense やアフィリエイトと違って .env ではなくここに直接書いている。
 * 測定IDは HTML にそのまま出る公開値で、隠す意味がないため。
 * タグの出力は BaseLayout.astro（＝全ページ共通の <head>）。
 */
export const GA_MEASUREMENT_ID = 'G-MZBL57S5MY'

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
   *
   * ★ **枠ごとに分けたいときは下の AMAZON_TAGS を使う。**
   *   この値は「既定のID」であって、枠別IDが無いときの落とし先。
   *   広告表記の出し分け（AFFILIATE_ENABLED）もこの1本で判定する。
   */
  amazonTag: import.meta.env.PUBLIC_AMAZON_TAG ?? '',
  /**
   * バリューコマース LinkSwitch の vc_pid。
   * これを入れると、本文の**通常リンクがブラウザ側で自動的に
   * アフィリエイトリンクに変換される**。
   * 記事のURLを書き換える必要がないので、自動生成した記事にそのまま効く。
   *
   * ★ 変換されるのは**提携済みの広告主のリンクだけ**。
   *   2026-09-02 時点で U-NEXT・Hulu はVCの広告主一覧に無く、
   *   タグは動いていても成果は出ない（docs/AFFILIATE.md 3-3）。
   *   提携が通れば、その時点からコード変更なしで成果対象になる。
   */
  linkSwitchPid: import.meta.env.PUBLIC_VC_LINKSWITCH_PID ?? '',
  /**
   * afb の U-NEXT の既定LPのリンクコード。**値を使うのはここではない。**
   *
   * ★ 中身を扱うのは src/lib/unext-ad.ts（LPの選び分け・文言・掲載NGの判定）。
   *   ここで読んでいるのは**広告表記（PR）を出すかどうかの判定**のためだけ。
   *   afb のリンクだけが有効な状態（Amazon も LinkSwitch も未設定）で
   *   「PR」が出ないと、広告があるのに広告表記が無いページになる。
   *
   * ★ 環境変数の名前を変えるときは src/lib/unext-ad.ts の LP.default も直すこと。
   */
  unextAfbLp: import.meta.env.PUBLIC_AFB_UNEXT_LP ?? '',
} as const

/** アフィリエイトが1つでも有効か。広告表記の出し分けに使う。 */
export const AFFILIATE_ENABLED = Boolean(
  AFFILIATE.amazonTag || AFFILIATE.linkSwitchPid || AFFILIATE.unextAfbLp,
)

/**
 * 枠別のトラッキングid（2026-09-03 追加）。
 *
 * ■ 何のためにあるか
 * サイト内の Amazon 導線は5種類ある（節ポスター / 表 / CTA / 追従枠 / 作品ページ）。
 * IDが1本だとアソシエイトのレポートは合計しか返さず、
 * **どの導線が効いているのかが永久に分からない。**
 * 導線を足すか減らすかを決める前に、まず分けて測るためのもの。
 *
 * ■ 使い方（1つずつでよい）
 * アソシエイト・セントラル → アカウント名 → 「トラッキングIDの管理」で
 * IDを作り、その枠の環境変数に入れる。**入れた枠から順に分離される。**
 * 入れていない枠は既定ID（PUBLIC_AMAZON_TAG）のまま何も変わらない。
 *
 * ★ **作っていないIDを書かないこと。** 未登録のトラッキングIDで発生した分は
 *   紹介料として計上されない。ここは「作ったものを書き写す場所」であって、
 *   命名を先に決める場所ではない。
 *
 * ★ 同じ表を astro.config.mjs 側でも組み立てている（rehype プラグイン用）。
 *   **環境変数の名前を変えるときは両方直すこと。** 片方だけ直すと、
 *   記事本文のリンクだけ古い枠のIDのまま公開される。
 */
export const AMAZON_TAGS: AmazonTags = {
  default: AFFILIATE.amazonTag,
  /** 節ごとの作品ポスター。記事本文で最も本数が多い導線 */
  poster: import.meta.env.PUBLIC_AMAZON_TAG_POSTER ?? '',
  /** 表の作品名リンク（記事本文・常設ページ共通） */
  table: import.meta.env.PUBLIC_AMAZON_TAG_TABLE ?? '',
  /** 記事末尾・常設ページの Amazon 導線（AmazonCta.astro） */
  cta: import.meta.env.PUBLIC_AMAZON_TAG_CTA ?? '',
  /** 右の追従枠のPR（FollowRail.astro）。1200px以上でしか出ない */
  rail: import.meta.env.PUBLIC_AMAZON_TAG_RAIL ?? '',
  /** 作品ページ（/works/<ID>）の各リンク */
  work: import.meta.env.PUBLIC_AMAZON_TAG_WORK ?? '',
  /** 記事本文のその他のリンク。上のどれにも当たらないもの */
  body: import.meta.env.PUBLIC_AMAZON_TAG_BODY ?? '',
}

/** その枠のトラッキングid。未設定の枠は既定に落ちる。 */
export function amazonTagFor(slot?: AmazonSlot): string {
  return tagFor(AMAZON_TAGS, slot)
}
