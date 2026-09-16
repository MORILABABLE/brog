/**
 * **その作品を載せていないが、同じ出来事を扱っている記事**を引く。
 *
 * ■ 何のためにあるか（2026-09-16）
 * 作品ページから記事への出口は、それまで2つしかなかった。
 *
 *   1. シリーズ記事（`series-for-work.ts` … 題名が `--match` に当たる）
 *   2. その作品が**実際に表に載っている**記事（`works.ts` の `seriesArticleFor()`）
 *
 * **実測（2026-09-16）で、673枚中411枚がどちらにも当たらなかった。**
 * 記事への出口が1本も無いページが、作品ページの**61%**あったということ。
 * `docs/WORK-PAGES.md` が書いている253枚より、実態はずっと悪い。
 *
 * 出口が無い理由は「その作品が記事に載っていない」で、そこは動かせない
 * （載っていないものを「載せた記事」と呼ぶことはできない）。
 * **だが「同じ月に、同じサービスで、同じことが起きた作品のまとめ」なら嘘にならない。**
 * リコリス・リコイル（Netflix・9月26日終了予定）を読んでいる人にとって、
 * 「9月にNetflixで終了する作品のまとめ」は**実際に次に読みたいもの**である。
 *
 * ■ 🔴 「この作品を載せた記事」と名乗らせないこと
 * ここが返すのは**載っていないかもしれない記事**。文言は呼び出し側が分けている
 * （`works/[id].astro` の `nextArticle`）。
 * 混ぜると、開いた読者がその作品を探して見つけられない。
 *
 * ■ 引き当ての順（上から、当たった時点で止める）
 *
 *   1. 同じサービス・**同じ月**・同じ出来事の記事
 *   2. 同じサービス・同じ出来事の**いちばん新しい**記事（月は合わなくてよい）
 *
 * どちらも**そのサービスのハブに載る記事**（タグの完全一致。`archive.ts` の `inService`）。
 * 判定を新しく作らない — 作れば月別まとめ・サービス別ページと食い違う。
 *
 * ★ **サービスは `w.services` の順に試す。** 先頭は「いちばん行動が要るもの」で、
 *   そこにハブが無い（Apple TV+ など）ときは次のサービスで引く。
 * ★ **月は作品の出来事の月**（`head.at`）であって、記事の公開日ではない。
 *   9月の記事は8月末に出る（`archive.ts` の `monthOf()` の★と同じ理由）。
 */
import type { CollectionEntry } from 'astro:content'
import { SERVICE_HUBS, type CategorySlug } from '../config'
import { inService, monthOf, sortPosts } from './archive'
import type { WorkPage, WorkState } from './works'

type PostEntry = CollectionEntry<'posts'>

export interface HubArticle {
  /** `/posts/<slug>` の slug */
  slug: string
  /** frontmatter の title。**リンクの文字はこれをそのまま出す** */
  title: string
  /** 枠の上に出す1行。**「この作品を載せた」とは言わない** */
  label: string
  heroImage?: string
  category?: CategorySlug
}

/**
 * 作品の状態 → 探す記事のカテゴリ。**前のほうが望ましい。**
 *
 * ★ `ended`（もう見放題に無い）は `ended` の記事を先に探すが、
 *   無ければ `leaving` に落とす。終了済みだけを集めた記事は月に1本出るかどうかで、
 *   **落とし先が無いと出口がまた消える。**
 *   `leaving` の記事は「その月に終了する作品」なので、終わった作品の読者にも外れない。
 * ★ `passed`（予定日は過ぎたが終了は観測していない）は `leaving` のまま。
 *   終了を観測していないのに「終了した作品のまとめ」へ送らない。
 */
const CATEGORIES_FOR: Record<WorkState, CategorySlug[]> = {
  leaving: ['leaving'],
  passed: ['leaving'],
  ended: ['ended', 'leaving'],
  started: ['arrivals'],
}

/** 状態 × サービス名 → 枠の上に出す1行。**自前の観測で言えることだけ** */
function labelFor(state: WorkState, serviceLabel: string, sameMonth: boolean): string {
  const when = sameMonth ? '同じ月に' : ''
  switch (state) {
    case 'leaving':
    case 'passed':
      return `${when}${serviceLabel}で終了する作品のまとめ`
    case 'ended':
      return `${when}${serviceLabel}で終了した作品のまとめ`
    case 'started':
      return `${when}${serviceLabel}で配信が始まった作品のまとめ`
  }
}

/** その作品の出来事の月（`2026-09`）。JST で見る */
function monthOfEvent(at: Date): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60_000)
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`
}

function toHubArticle(post: PostEntry, label: string): HubArticle {
  return {
    slug: post.id,
    title: post.data.title,
    label,
    heroImage: post.data.heroImage,
    category: post.data.category as CategorySlug,
  }
}

/**
 * 同じ出来事を扱っている記事。**当たらなければ `undefined`。**
 *
 * @param w 作品ページ
 * @param posts 公開済みの記事（下書きは呼び出し側で除いておくこと）
 * @param excludeSlugs 既に同じページへ出しているもの（同じリンクを2本並べない）
 */
export function hubArticleFor(
  w: WorkPage,
  posts: PostEntry[],
  excludeSlugs: (string | undefined)[] = [],
): HubArticle | undefined {
  const skip = new Set(excludeSlugs.filter((s): s is string => Boolean(s)))
  const ordered = sortPosts(posts.filter((p) => !p.data.draft && !skip.has(p.id)))

  for (const s of w.services) {
    const hub = SERVICE_HUBS.find((h) => h.slug === s.service)
    // ハブの無いサービス（Apple TV+ など）は記事そのものが無い。次のサービスへ
    if (!hub) continue
    const month = monthOfEvent(s.at)
    const mine = ordered.filter((p) => inService(p, hub))
    if (mine.length === 0) continue

    for (const category of CATEGORIES_FOR[s.state]) {
      const sameCategory = mine.filter((p) => p.data.category === category)
      if (sameCategory.length === 0) continue

      // 1. 同じ月
      const sameMonth = sameCategory.find((p) => monthOf(p) === month)
      if (sameMonth) return toHubArticle(sameMonth, labelFor(s.state, hub.label, true))

      // 2. 月は合わなくてよい。いちばん新しいもの（`sortPosts` 済み）
      const latest = sameCategory[0]
      if (latest) return toHubArticle(latest, labelFor(s.state, hub.label, false))
    }
  }
  return undefined
}
