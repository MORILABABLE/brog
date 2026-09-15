/**
 * 記事のジャンルを、バッジに出す文言に変える。
 *
 * ■ 出しかた（2026-09-15）
 * 記事は入っているジャンルを**全部**名乗る（frontmatter の `genres`）。
 * サイトに出すのは**代表的な3ジャンルの表記**（アニメ／洋画／邦画）だけで、
 * ここに4つ目5つ目のラベルを足さない。並びは本数の多い順（＝先頭が主なジャンル）。
 *
 *   ジャンル軸の記事   [新着配信] [アニメ]
 *   シリーズ記事       [新着配信] [洋画(SF)]
 *   サービス軸の記事   [配信終了予定] [アニメ] [洋画] [邦画]
 *
 * ★ 詳細（括弧の中）は**基本ジャンルが1つの記事だけ**に付く。
 *   混ざっている記事に詳細を1つ足しても、どのジャンルの詳細か分からない。
 *   決め方は theme-packs/streaming-jp/genres.ts の `summarizeGenres()`。
 *
 * ★ **出す場所を増やすときは幅を確かめること。** いまバッジを出しているのは
 *   一覧のカード（PostCard）と記事ページの2か所。
 *   右の枠（SeriesRail / FollowRail の最新記事）には**出していない**。
 *   あちらは17remしかなく、カテゴリバッジと題名2行で埋まっている。
 */
import { GENRES, type GenreSlug } from '../config'

/** バッジの材料。`CollectionEntry<'posts'>['data']` の一部だけを受ける。 */
export interface GenreFields {
  genres?: readonly GenreSlug[]
  genreDetail?: string
}

/**
 * バッジに出す文言。ジャンルを持たない記事では空になる（バッジを出さない）。
 * 基本ジャンルは3つしかないので、返る数は最大3。
 */
export function genreBadges(data: GenreFields): string[] {
  const keys = data.genres ?? []
  if (keys.length === 0) return []
  if (keys.length === 1 && data.genreDetail) {
    return [`${GENRES[keys[0]].label}(${data.genreDetail})`]
  }
  return keys.map((k) => GENRES[k].label)
}

/**
 * その記事が**1つのジャンルだけを名乗れる**ならそのジャンル。混ざっていれば undefined。
 *
 * ★ 2026-09-15 より前の `genre`（単数）と同じ意味。
 *   ジャンル別の一覧ページ（lib/genre-pages.ts）と U-NEXT のLP選び（lib/unext-ad.ts）は
 *   「この記事はアニメの記事だ」と言い切れるときだけ使う値なので、
 *   混ざっている記事を先頭のジャンルで代表させないこと。
 */
export function soleGenre(data: GenreFields): GenreSlug | undefined {
  const keys = data.genres ?? []
  return keys.length === 1 ? keys[0] : undefined
}
