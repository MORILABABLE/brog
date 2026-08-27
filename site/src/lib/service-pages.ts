/**
 * 「サービスで絞った一覧」を組み立てる。
 *
 * 同じ形の一覧を2種類のページが出す。**中身の作り方はここ1か所に置く。**
 *
 *   /category/<ハブ>/<サービス> … ハブのカテゴリ ∩ サービス（ヘッダーのメニューの行き先）
 *   /service/<サービス>          … カテゴリを問わずサービスだけで束ねた従来のページ
 *
 * ★ 記事は frontmatter の `tags` で拾う。
 *   タグの文字列は config.ts の SERVICE_HUBS の `tag` と完全一致が要る。
 *   タグを出しているのは各記事タイプの `tags()`（theme-packs/…/article-types/）。
 *
 * ★ 常設ページ（/leaving/… /arrivals/…）も一緒に返す。
 *   `collect` のたびに中身が入れ替わるので月次記事より鮮度が高く、
 *   一覧では記事カードより上に置く。
 */
import type { CollectionEntry } from 'astro:content'
import type { CategorySlug } from '../config'
import { evergreenForService, evergreenSummary, type EvergreenPage } from './evergreen'

export type PostEntry = CollectionEntry<'posts'>

export interface ServiceSection {
  /** 新しい順に並べた記事 */
  posts: PostEntry[]
  /** そのサービス・そのカテゴリの常設ページ（件数と基準日つき） */
  evergreen: { page: EvergreenPage; count: number; dataAsOf: Date | null }[]
}

/**
 * サービス（＋カテゴリ）で絞った一覧を返す。
 * `categories` を省くと、そのサービスの記事をカテゴリ問わず全部返す。
 */
export function serviceSection(
  posts: PostEntry[],
  service: { slug: string; tag: string },
  categories?: readonly CategorySlug[],
): ServiceSection {
  const inScope = (c: CategorySlug) => !categories || categories.includes(c)

  return {
    posts: posts
      .filter((p) => p.data.tags.includes(service.tag) && inScope(p.data.category))
      .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()),
    evergreen: evergreenForService(service.slug)
      .filter((p) => inScope(p.category))
      .map((page) => ({ page, ...evergreenSummary(page) })),
  }
}

/**
 * 出せる中身が1つでもあるか。
 *
 * ★ **false のページは noindex にする**（BaseLayout の noindex）。
 *   ヘッダーのメニューには5サービスすべてを並べる方針なので、
 *   ヘッダーのメニューに並べたサービスのページは、中身が0件でも作る＝404にしない。
 *   ただし中身の無いページを検索結果に出すのは、読者にとっても
 *   サイトの評価にとっても損なので、索引からは外す。
 *
 * ★ サイトマップには載る（@astrojs/sitemap はルートから作るので、
 *   noindex を知らない）。Search Console に「noindex のURLを送信しました」の
 *   注意が出るが、**メニューの行き先を404にしない**ほうを優先している。
 *   記事が1本入れば自動的に索引対象へ戻る。
 */
export function serviceHasContent(section: ServiceSection): boolean {
  return section.posts.length > 0 || section.evergreen.length > 0
}
