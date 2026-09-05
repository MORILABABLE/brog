/**
 * 月別まとめ（`/archive`）の組み立て。
 *
 * 同じ束ね方を3種類のページが使う。**作り方はここ1か所に置く。**
 *
 *   /archive                    月の一覧（ヘッダーのメニューの「すべて見る」の行き先）
 *   /archive/<月>               その月の全記事。ハブ（新着／終了まわり）ごとに分ける
 *   /archive/<月>/<サービス>    その月 × そのサービス
 *
 * ★ 形は `/category/<ハブ>` → `/category/<ハブ>/<サービス>` に合わせてある。
 *   読者が覚える操作が「一覧 → サービスで絞る」の1つで済む。
 *
 * ★ **常設ページ（/leaving/… /arrivals/…）はここに出さない。**
 *   あれは収集のたびに中身が入れ替わる「いまの一覧」で、月に属さない。
 *   サービス別の一覧に出すのは lib/service-pages.ts の仕事。
 */
import type { CollectionEntry } from 'astro:content'
import { CATEGORY_HUBS, SERVICE_HUBS } from '../config'

export type PostEntry = CollectionEntry<'posts'>
export type ArchiveHub = (typeof CATEGORY_HUBS)[number]
export type ServiceHub = (typeof SERVICE_HUBS)[number]

/**
 * その記事が名乗っている月（`2026年9月` → `2026-09`）。名乗っていなければ undefined。
 *
 * ★ **`pubDate` は使わない。** 9月の記事は8月末に出る
 *   （「【2026年9月配信開始】…」の pubDate は 2026-08-29）。
 *   公開日で束ねると、読者が探している月と1つずれた棚に入る。
 *
 * ★ タグの書式は**パイプライン側と揃えること**。書いているのは各記事タイプの
 *   `tags()`（`${y}年${Number(m)}月`）で、読み方の正は
 *   theme-packs/streaming-jp/article-types/shared.ts の `monthTagOf()`。
 *   **片方だけ変えると、記事が静かに月別まとめから消える。**
 *
 * ★ 「2026年9月配信開始」のような**後ろに語が付くタグは月と見なさない**
 *   （特報の期間の呼び名。`special.ts` の periodLabel）。完全一致で見る。
 */
export function monthOf(post: PostEntry): string | undefined {
  for (const t of post.data.tags) {
    const m = /^(\d{4})年(\d{1,2})月$/.exec(t)
    if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`
  }
  return undefined
}

/**
 * 月の見出し（`2026-09` → `2026年9月`）。
 * **記事のタグと同じ文字列になる**ようにしてある（`monthOf` の逆）。
 */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}

export interface ArchiveMonth {
  /** `2026-09` */
  month: string
  /** `2026年9月` */
  label: string
  /** その月の記事。新しい順 */
  posts: PostEntry[]
}

/**
 * 記事を月ごとに束ねる。**新しい月が先**。月を名乗らない記事は入らない。
 */
export function archiveMonths(posts: PostEntry[]): ArchiveMonth[] {
  const byMonth = new Map<string, PostEntry[]>()
  for (const post of posts) {
    const month = monthOf(post)
    if (!month) continue
    const list = byMonth.get(month)
    if (list) list.push(post)
    else byMonth.set(month, [post])
  }

  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, list]) => ({
      month,
      label: monthLabel(month),
      posts: sortPosts(list),
    }))
}

/** 新しい順。**一覧の並びはすべてこれ**（カテゴリのハブと同じ） */
export function sortPosts(posts: PostEntry[]): PostEntry[] {
  return [...posts].sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
}

/** そのサービスの記事か。判定は lib/service-pages.ts と同じ「タグの完全一致」 */
export function inService(post: PostEntry, service: ServiceHub): boolean {
  return post.data.tags.includes(service.tag)
}

export interface ArchiveGroup {
  hub: ArchiveHub
  posts: PostEntry[]
}

/**
 * 記事を読者向けのハブ（新着配信／配信終了予定・終了済み）で分ける。
 * **中身が0本のハブは返さない。**
 *
 * ★ カテゴリ（4つ）ではなくハブ（3つ）で分ける。理由は config.ts の CATEGORY_HUBS。
 *   「終了予定」と「終了済み」は読者の用事が同じなので、月の中でも1つの節にする
 *   （見分けはカードのバッジが担う）。
 */
export function archiveGroups(posts: PostEntry[]): ArchiveGroup[] {
  return CATEGORY_HUBS.map((hub) => ({
    hub,
    posts: sortPosts(posts.filter((p) => (hub.includes as readonly string[]).includes(p.data.category))),
  })).filter((g) => g.posts.length > 0)
}

/**
 * その月に記事があるサービス。**0本のサービスは返さない。**
 *
 * ★ ここが「月×サービスのページを作るか」の判定も兼ねる
 *   （pages/archive/[month]/[service].astro）。**空のページを作らない。**
 *   ヘッダーのメニューが月×サービスまでは開かないので、
 *   `/category/<ハブ>/<サービス>` のように「メニューの行き先だから404にしない」
 *   という事情がここには無い。
 */
export function servicesIn(posts: PostEntry[]): ServiceHub[] {
  return SERVICE_HUBS.filter((s) => posts.some((p) => inService(p, s)))
}
