/**
 * シリーズ記事（保存版）の拾い方。**右の枠（SeriesRail.astro）と
 * 一覧ページ（pages/series.astro）が両方ここを読む。**
 *
 * ■ シリーズ記事とは
 * `theme-packs/streaming-jp/article-types/series.ts` が書く、
 * **月を名乗らない唯一の記事タイプ**。URLに月が入らず（`conan-movies`）、
 * 配信状況が変わるたびに同じURLを書き直す（docs/KEYWORDS.md 案1・docs/STOCK.md 2-2）。
 *
 * ■ なぜタグで拾うのか
 * 記事の frontmatter には「記事タイプ」が入らない。入っているのは
 * カテゴリ（leaving / ended / arrivals / ranking）とタグだけで、
 * **シリーズ記事のカテゴリは行き来する**（`series.ts` の `stanceOf()`）。
 *
 *   leaving  終了予定が1本でもある
 *   ended    全部終わっている
 *   arrivals 終了予定が無い。**見放題に復帰した作品**か、**いま配信中の作品**がある
 *
 * カテゴリでは拾えないので、記事タイプ側が必ず付けるタグ1つで拾う。
 *
 * ★ **`arrivals` の2つはバッジの文字だけ分ける**（2026-09-05 変更）。
 *   復帰は終了日を持ちうるが、配信中は持たない。読者に見せる言葉が
 *   「新着配信」と「配信中」で変わるので `STREAMING_TAG` で見分ける。
 *   **枠は分けない。** 一度は2枠に割ったが同じ日に1枠へ戻している
 *   （経緯は SeriesRail.astro の「枠は1つ」）。
 *
 * ★ `SERIES_TAG` は `series.ts` の `tags()` が入れる文字列と**完全に一致させること。**
 *   1文字でも違うと、記事はできているのに枠から消える（0件の枠は描画されない）。
 */
import type { CollectionEntry } from 'astro:content'
import type { CategorySlug } from '../config'

/** シリーズ記事の目印。`article-types/series.ts` の `tags()` と揃えること。 */
export const SERIES_TAG = 'シリーズ'

/**
 * **終了日がまだ分かっていない**シリーズ記事の目印（2026-09-05 追加）。
 *
 * ■ なぜカテゴリで見分けられないのか
 * `series.ts` の `stanceOf()` は `streaming`（いま配信中）も
 * `returned`（見放題に復帰）も**同じ `arrivals` カテゴリ**にする。
 * どちらも読者に渡すのが「いま観られる」ことなので、それ自体は正しい。
 * だがバッジに出す言葉は違い（「配信中」と「新着配信」）、
 * カテゴリにはその情報が無い。
 *
 * ★ **使い道はバッジの文言だけ**（SeriesRail.astro）。**並び順には効かない。**
 *   段を決めるのは下の `TIER`＝カテゴリで、`streaming` も `returned` も
 *   同じ2段目（配信中）に入る。ここで段を分けると、
 *   読者にとって同じ「いま観られる」が枠の中で2か所に散る。
 *
 * ★ `article-types/series.ts` の `tags()` が入れる文字列と**完全に一致させること。**
 *   1文字でも違うと、終了日を持たない記事に「新着配信」のバッジが出る。
 */
export const STREAMING_TAG = '見放題配信中'

export interface SeriesPost {
  /**
   * 元の記事そのもの。**一覧ページ（/series）が記事カードに渡す。**
   *
   * ★ 枠（SeriesRail）は使わない。あちらは幅17remに収める専用の見た目で、
   *   下の `label` / `heroImage` だけを使う。一覧ページのほうは
   *   他の一覧と**同じ記事カード**（PostCard.astro）で出したいので、
   *   加工前の記事が要る。片方のために作った形をもう片方へ持ち込まないこと。
   */
  entry: CollectionEntry<'posts'>
  href: string
  /** 枠に出す短い名前。タイトルから機械的に作る（下の `railLabel`） */
  label: string
  /** 元のタイトル。`title` 属性に出して、省略された部分を補えるようにする */
  fullTitle: string
  category: CategorySlug
  /**
   * 枠に出す絵。**記事の frontmatter の `heroImage` をそのまま渡すだけ。**
   *
   * ★ **この枠専用の画像は作らない。** 記事カード（PostCard）と追従枠の
   *   最新記事（FollowRail）が使っているのと**同じ1枚**で、部品も同じ
   *   （Thumb.astro）。増やすと「同じ記事なのに場所によって絵が違う」状態になり、
   *   取り直し（`npm run refresh:images`）の対象も増える。
   *
   * ★ **権利の扱いはヘッダー画像の決まりがそのまま効く**（docs/APPEARANCE.md 11-12節）。
   *   出どころは配信API（Movie of the Night）のポスターで、
   *   再ホストの許諾を取ってあるのはこの経路だけ。ここへ別の絵を
   *   引っぱってこないこと。
   *
   * ★ **署名付きURLが失効したら勝手に汎用画像になる。** ヘッダー画像は
   *   毎ビルド `npm run sections` が `/heroes/<スラッグ>.webp` を作り直していて、
   *   ポスターが取れなければ**ジャンル別の汎用画像**（自前の幾何学図形）を
   *   同じパスに書く。パスは変わらないので、**この枠は何もしなくてよい。**
   *
   * ★ 絵を差し替えたいときは記事の frontmatter を書き換える。
   *   自動処理は空か `/heroes/<スラッグ>.webp` のときしか触らないので、
   *   別のパスを書けばその記事だけ固定できる（docs/APPEARANCE.md 12節）。
   *
   * 未設定の記事はカテゴリ色のタイルになる（Thumb.astro）。枠は崩れない。
   */
  heroImage?: string
  /**
   * **終了日が1本も分かっていない記事か**（`STREAMING_TAG` が付いている）。
   *
   * `true` の記事は「いま観られる」ことだけを言っていて、締切を持たない。
   * 枠のバッジを「配信中」にするのにだけ使う（`SeriesRail.astro`）。
   * **段（並び順）はカテゴリで決まるので、ここは並びに効かない。**
   */
  streaming: boolean
}

/**
 * 並びの「段」。**小さいほど上。**
 *
 * ■ なぜカテゴリで段に分けるのか
 * シリーズ記事のカテゴリは**読者にとっての急ぎ具合**そのもの
 * （`series.ts` の `stanceOf()`）。
 *
 *   leaving  見放題終了予定。締切がある          → いちばん上
 *   arrivals 配信中（いま配信中／見放題に復帰）   → 次
 *   ended    配信終了済み。もう観られない        → いちばん下
 *
 * ★ `arrivals` の2つ（配信中・復帰）を分けない。読者への答えはどちらも
 *   「いま観られる」で同じ。違うのは**バッジの文字だけ**（`STREAMING_TAG`）。
 * ★ `ranking` はシリーズ記事には付かないが、`CategorySlug` の値なので置いておく。
 */
const TIER: Record<CategorySlug, number> = { leaving: 0, arrivals: 1, ended: 2, ranking: 3 }

/**
 * 枠に出す名前を、記事タイトルから作る。
 *
 * 記事タイトルは「【保存版】{主題}の{動詞句}作品{本数}本｜{見どころ}」の形で、
 * 幅17remの枠には長すぎる。表示のためだけに2か所を落とす。
 *
 *   【保存版】「名探偵コナン」劇場版シリーズの見放題配信が終了予定の作品61本｜Netflixで8月31日まで
 *   → 「名探偵コナン」劇場版シリーズの見放題配信が終了予定の作品61本
 *
 * ★ **落とすのはこの2つだけ。** 主題も動詞句も本数も残す。
 *   - 先頭の【保存版】… 全行で同じ文字列なので、並べると情報量が0
 *   - ｜のあとの見どころ … 1行に収まらず、2行に折り返すと主題が押し出される
 *
 * ★ 主題そのものを切り出そうとしないこと。
 *   タイトルの決まり（naming.md）が求めているのは「主題と動詞句が入っていること」で、
 *   **並び順までは決めていない。** 「見放題配信が終了予定の『◯◯』5本」と書かれても
 *   検査は通るので、位置を前提に切ると記事によって別の場所が切れる。
 */
function railLabel(title: string): string {
  return title.replace(/^【[^】]*】/, '').split('｜')[0]!.trim()
}

/**
 * 公開中のシリーズ記事を、**まだ観られるものから**返す。
 *
 * ■ 並び（2026-09-05 変更）
 *
 *   1段目 `leaving`  見放題終了予定
 *   2段目 `arrivals` 配信中（いま配信中・見放題に復帰の両方）
 *   3段目 `ended`    配信終了済み
 *
 * **段の中は `pubDate` の降順＝最後に書き直した順。**
 *
 * ★ **段を先に見るのが要。** `pubDate` だけで並べていたころは、
 *   全作終了した記事を書き直した日に、それが枠のいちばん上に来ていた
 *   （シリーズ記事は書き直すたびに `pubDate` が振り直される。
 *   `buildMarkdown` が `pubDate: now`）。段で先に切ってあれば、
 *   どれだけ書き直しても**急ぎ度の順は崩れない。**
 *
 * ★ **段の中を「本数の多い順」にするのはやめた**（2026-09-02〜09-05）。
 *   本数はタイトルから取った数で、書き直すたびに増減する。
 *   読者にとっては「大きいシリーズが上」でしかなく、
 *   段の中の順番として意味を持っていなかった。
 *   枠が1つになり、段をまたいで6本まで載るようになったので、
 *   段の中は**最後に手を入れた新しい順**にしてある。
 *
 * ★ 同じ日時のときだけ `id` で決着させる。並びが実行のたびに揺れないように、
 *   最後は必ず決まる比較にしておくこと。
 */
export function seriesPosts(posts: CollectionEntry<'posts'>[]): SeriesPost[] {
  return posts
    .filter((p) => !p.data.draft && p.data.tags.includes(SERIES_TAG))
    .map((p) => ({
      entry: p,
      href: `/posts/${p.id}`,
      label: railLabel(p.data.title),
      fullTitle: p.data.title,
      category: p.data.category,
      heroImage: p.data.heroImage,
      streaming: p.data.tags.includes(STREAMING_TAG),
    }))
    .sort((a, b) => {
      const tier = TIER[a.category] - TIER[b.category]
      if (tier !== 0) return tier
      const byDate = b.entry.data.pubDate.valueOf() - a.entry.data.pubDate.valueOf()
      if (byDate !== 0) return byDate
      return a.entry.id.localeCompare(b.entry.id)
    })
}
