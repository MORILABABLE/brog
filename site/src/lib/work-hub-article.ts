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
 *   1巡目 … **ジャンルの合う記事だけ**を相手に、下の 1 → 2（在庫の社も見る）
 *   2巡目 … ジャンルを問わず、下の 1 → 2（**変化ログの社だけ**）
 *
 *     1. 同じサービス・**同じ月**・同じ出来事の記事
 *     2. 同じサービス・同じ出来事の**いちばん新しい**記事（月は合わなくてよい）
 *
 * どれも**そのサービスのハブに載る記事**（タグの完全一致。`archive.ts` の `inService`）。
 * 判定を新しく作らない — 作れば月別まとめ・サービス別ページと食い違う。
 *
 * ★ **サービスは `w.services` の順に試す。** 先頭は「いちばん行動が要るもの」で、
 *   そこにハブが無い（Apple TV+ など）ときは次のサービスで引く。
 * ★ **月は作品の出来事の月**（`head.at`）であって、記事の公開日ではない。
 *   9月の記事は8月末に出る（`archive.ts` の `monthOf()` の★と同じ理由）。
 *
 * ■ ジャンルを見る（2026-09-18 追加）
 *
 * **サービスと月だけで引くと、アニメの読者に無関係な記事を渡していた。**
 * 実測（GA4 2026-09-08〜17）で `/works/14626092`（SAKAMOTO DAYS・アニメ）は
 * **14セッション・1.00PV/s・エンゲージ 28.6%**、回遊**0件**。
 * 渡していたのは「Prime Videoで終了する作品4本｜**野生の島のロズ**」だった。
 * 同じ日の同じテンプレートで `/works/10534`（からかい上手の高木さん）は
 * **1.55PV/s・エンゲージ 81.8%** で、そちらは「Netflixで**アニメ**17本」に当たっている。
 * 差はジャンルの一致で、**サイトはその記事を持っているのに引けていなかった。**
 *
 * ★ 一致の判定は `genres.ts` の `soleGenre()`。**1ジャンルだけを名乗る記事**に限る。
 *   アニメも洋画も混ざる記事は「アニメの記事」ではない（`soleGenre()` の★）。
 * ★ **2巡目は 2026-09-18 より前とそのまま同じ。** ジャンルの合う記事が無いページの
 *   出口を、この変更で減らさないため。
 *
 * ■ 在庫の社も候補にする（2026-09-18 追加）
 *
 * 上の SAKAMOTO DAYS は Prime Video で終了予定だが、**Netflix と Disney+ では見放題**
 * （在庫台帳）。`w.services` は変化ログの社（＝Prime Video）しか持たないので、
 * Netflix のアニメ記事には**構造上ぜったいに当たらなかった。**
 *
 * ★ **変化ログの社を必ず先に試す。** 在庫の社は後ろ。読者が来た目的は
 *   「終わるほうの社」の話で、そこに合う記事があるならそれがいちばん近い。
 * ★ 🔴 **在庫の社でも「この作品を載せた記事」とは名乗らない。** ここが返すのは
 *   載っていないかもしれない記事で、それは在庫の社でも変わらない（上の🔴）。
 *   名乗るのは「同じ月にNetflixで終了する作品のまとめ」まで。
 */
import type { CollectionEntry } from 'astro:content'
import { SERVICE_HUBS, type CategorySlug } from '../config'
import { inService, monthOf, sortPosts } from './archive'
import { soleGenre } from './genres'
import { stockAnswer, type WorkPage, type WorkState } from './works'

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

/** 記事を探しにいく先（サービスのハブ1つぶん） */
interface Candidate {
  hub: (typeof SERVICE_HUBS)[number]
  /** 探す月（`2026-09`） */
  month: string
  /** 探すカテゴリ。**前のほうが望ましい**（`CATEGORIES_FOR`） */
  categories: CategorySlug[]
  /** 枠の上の1行を組むための状態 */
  state: WorkState
  /** 在庫台帳から来た社か。**2巡目はこれが false のものだけを見る** */
  stock: boolean
}

/**
 * 探しにいく先を、**変化ログの社 → 在庫の社**の順に並べる。
 * ハブの無いサービス（Apple TV+ など）は記事そのものが無いので落とす。
 */
function candidatesFor(w: WorkPage): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const push = (service: string, at: Date, state: WorkState, stock: boolean) => {
    const hub = SERVICE_HUBS.find((h) => h.slug === service)
    if (!hub || seen.has(hub.slug)) return
    seen.add(hub.slug)
    out.push({ hub, month: monthOfEvent(at), categories: CATEGORIES_FOR[state], state, stock })
  }

  for (const s of w.services) push(s.service, s.at, s.state, false)

  /*
   * 在庫の社（いま見放題で観られる先）。
   * ★ **月と状態は作品そのものの出来事から取る。** 在庫台帳が持っているのは
   *   「いまある」ことだけで、その社での出来事の日付は持っていない。
   *   読者にとっての「いま」は、この作品が動く月（＝`w.services[0].at` の月）。
   */
  const head = w.services[0]
  if (head) {
    for (const s of stockAnswer(w)?.services ?? []) push(s.service, head.at, w.state, true)
  }
  return out
}

/** 候補を順に試して、最初に当たった記事を返す。**当たらなければ `undefined`。** */
function pick(candidates: Candidate[], posts: PostEntry[]): HubArticle | undefined {
  for (const c of candidates) {
    const mine = posts.filter((p) => inService(p, c.hub))
    if (mine.length === 0) continue

    for (const category of c.categories) {
      const sameCategory = mine.filter((p) => p.data.category === category)
      if (sameCategory.length === 0) continue

      // 1. 同じ月
      const sameMonth = sameCategory.find((p) => monthOf(p) === c.month)
      if (sameMonth) return toHubArticle(sameMonth, labelFor(c.state, c.hub.label, true))

      // 2. 月は合わなくてよい。いちばん新しいもの（`sortPosts` 済み）
      const latest = sameCategory[0]
      if (latest) return toHubArticle(latest, labelFor(c.state, c.hub.label, false))
    }
  }
  return undefined
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
  const candidates = candidatesFor(w)

  /*
   * 1巡目 — **ジャンルの合う記事だけ。** 在庫の社もここで見る。
   * ★ 作品のジャンルが決まらないときは1巡目そのものを飛ばす
   *   （`soleGenre()` との一致が取れないので、当たっても偶然でしかない）。
   */
  if (w.genre) {
    const sameGenre = ordered.filter((p) => soleGenre(p.data) === w.genre)
    if (sameGenre.length > 0) {
      const hit = pick(candidates, sameGenre)
      if (hit) return hit
    }
  }

  // 2巡目 — ジャンルを問わない。**変化ログの社だけ**（2026-09-18 より前と同じ挙動）
  return pick(
    candidates.filter((c) => !c.stock),
    ordered,
  )
}
