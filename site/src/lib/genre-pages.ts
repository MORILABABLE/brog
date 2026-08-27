/**
 * 「ジャンルで絞った一覧」を組み立てる。
 *
 * 同じ拾い方を2か所が使う。**拾い方はここ1か所に置く**（lib/service-pages.ts と同じ考え方）。
 *
 *   右の枠の「ジャンルから探す」 … components/GenreRail.astro
 *   `/genre/<スラッグ>` の一覧    … pages/genre/[genre].astro
 *
 * ★ 記事は frontmatter の `genre` で拾う。**`tags` では拾わない。**
 *   タグでの絞り込み（サービスがそうしている）にすると、
 *   本文でジャンル名に触れただけの記事まで一覧に入ってしまう。
 *   `genre` は「この記事はこのジャンルの記事である」という宣言で、
 *   ジャンル軸の記事タイプだけが名乗る（pipeline/core/article.ts の `Axis`）。
 *
 * ★ 常設ページ（/leaving/… /arrivals/…）はジャンルを持たない。
 *   サービス単位で作っている一覧なので、ここには出しようがない。
 *   サービス別の一覧（lib/service-pages.ts）と形が違うのはそのため。
 */
import type { CollectionEntry } from 'astro:content'
import { GENRE_HUBS, type GenreSlug } from '../config'

export type PostEntry = CollectionEntry<'posts'>

export interface GenreSection {
  slug: GenreSlug
  label: string
  heading: string
  /** 新しい順に並べた、そのジャンルの記事 */
  posts: PostEntry[]
}

/** そのジャンルの記事を新しい順に返す。 */
export function genrePosts(posts: PostEntry[], slug: GenreSlug): PostEntry[] {
  return posts
    .filter((p) => p.data.genre === slug)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
}

/**
 * 全ジャンルぶんの一覧を、config の並び順で返す。
 *
 * ★ **記事が0本のジャンルは落とす。**
 *   ジャンル別の導線を出すのは記事が溜まってからという前提なので
 *   （config.ts の GENRE_NAV_ENABLED）、空のジャンルを枠に並べる場面は無い。
 *   落としておけば、ジャンルを1つ増やした直後に空の項目が出ることもない。
 */
export function genreSections(posts: PostEntry[]): GenreSection[] {
  return GENRE_HUBS.map((g) => ({
    slug: g.slug,
    label: g.label,
    heading: g.heading,
    posts: genrePosts(posts, g.slug),
  })).filter((s) => s.posts.length > 0)
}
