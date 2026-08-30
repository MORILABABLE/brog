/**
 * シリーズ記事（保存版）の拾い方。**右の枠と、将来の一覧ページが両方ここを読む。**
 *
 * ■ シリーズ記事とは
 * `theme-packs/streaming-jp/article-types/series.ts` が書く、
 * **月を名乗らない唯一の記事タイプ**。URLに月が入らず（`conan-movies`）、
 * 配信状況が変わるたびに同じURLを書き直す（docs/KEYWORDS.md 案1・docs/STOCK.md 2-2）。
 *
 * ■ なぜタグで拾うのか
 * 記事の frontmatter には「記事タイプ」が入らない。入っているのは
 * カテゴリ（leaving / ended / arrivals / ranking）とタグだけで、
 * **シリーズ記事のカテゴリは leaving にも ended にもなる**（全作終われば ended）。
 * カテゴリでは拾えないので、記事タイプ側が必ず付けるタグ1つで拾う。
 *
 * ★ `SERIES_TAG` は `series.ts` の `tags()` が入れる文字列と**完全に一致させること。**
 *   1文字でも違うと、記事はできているのに枠から消える（0件の枠は描画されない）。
 */
import type { CollectionEntry } from 'astro:content'
import type { CategorySlug } from '../config'

/** シリーズ記事の目印。`article-types/series.ts` の `tags()` と揃えること。 */
export const SERIES_TAG = 'シリーズ'

export interface SeriesPost {
  href: string
  /** 枠に出す短い名前。タイトルから機械的に作る（下の `railLabel`） */
  label: string
  /** 元のタイトル。`title` 属性に出して、省略された部分を補えるようにする */
  fullTitle: string
  category: CategorySlug
}

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
 * 公開中のシリーズ記事を、新しい順に返す。
 *
 * ★ 並びは `pubDate` の降順。シリーズ記事は書き直すたびに `pubDate` が
 *   その日に振り直されるので（`buildMarkdown` が `pubDate: now`）、
 *   **結果として「最近手を入れた順」**になる。保存版の並びとしてはそれでよい。
 */
export function seriesPosts(posts: CollectionEntry<'posts'>[]): SeriesPost[] {
  return posts
    .filter((p) => !p.data.draft && p.data.tags.includes(SERIES_TAG))
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
    .map((p) => ({
      href: `/posts/${p.id}`,
      label: railLabel(p.data.title),
      fullTitle: p.data.title,
      category: p.data.category,
    }))
}
