/**
 * **公開済みの記事を、いまのデータと突き合わせる。** 2つの答えを出す。
 *
 *   `staleArticles()`      書き直せば直るもの（見放題終了予定 → 見放題終了 の移行はここが起点）
 *   `liveElsewhereRows()`  書き直しても直らないもの（「終了しました」と書いた作品が、
 *                          他社では生きている観測のまま。**人が確かめるしかない**）
 *
 * 分けてあるのは、前者だけが `--refresh --emit` の対象だから。
 * 混ぜると「書き直しても何も変わらない記事」が一覧に居座り続ける。
 *
 * ■ なぜ要るか（2026-09-02 追加）
 * シリーズ記事は月を名乗らないURLを何か月も書き直す記事で、
 * 「終了予定」「終了済み」「見放題に復帰」は**素材から自動で決まる**
 * （`article-types/series.ts` の `stanceOf()`）。つまり
 * **書き直しさえすれば正しくなる**ようにできている。
 *
 * **問題は「いつ書き直すか」を誰も見ていなかったこと。**
 * 終了日が過ぎるのは静かな出来事で、収集にも差分として出ない
 * （終了予定は**予告された日に何も起きない**。過ぎるだけ）。
 * `--list` の一覧は「記事が有るか無いか」しか見ないので、
 * 公開済みのシリーズ記事は**書いた翌日から一生「作成済」**のまま並ぶ。
 *
 *   8月30日  conan-movies を公開（32本すべて「終了予定」）
 *   8月31日  32本の終了日が過ぎる  ← 誰にも何も届かない
 *   9月 2日  記事はまだ「終了予定」と書いている（タイトル・バッジ・表の全行）
 *
 * ここが見るのは**記事の控え（`core/article-log.ts`）と今の素材の差**だけ。
 * 外部APIは1回も呼ばない（`core/coverage.ts` と同じ性格の層）。
 *
 * ■ 3つの理由を分けて数える
 *
 *   category … 記事が名乗るカテゴリが、いまの素材から決まる値と違う。
 *              **タイトルの動詞句・リードの固定文言・バッジがまとめて食い違う**ので、
 *              これがいちばん急ぐ（読者に嘘を見せている状態）
 *   passed   … 記事を書いたあとに終了日が過ぎた作品がある。
 *              カテゴリは変わらなくても、表の「終了予定」の行が事実と違う
 *   missing  … その記事の本文に出ていない素材がある（新しく増えたぶん）
 *
 * ■ 月を名乗る記事は見ない
 * 対象は `ArticleType.evergreen` を宣言した記事タイプだけ。
 * 月次記事は「その月に何が起きたか」の記録で、月が過ぎても書き直さない。
 * ここに混ぜると、**公開済みの月次記事が毎日「終了日が過ぎました」と鳴り続ける。**
 * 月次記事の取りこぼしは、いままでどおり `core/coverage.ts` の網で見る。
 *
 * ■ 判定と本文の突き合わせは記事タイプに任せる
 * 「その作品が本文に出ているか」はサービスごとの表記ゆれを知らないと判定できない
 * （`ArticleType.mentions`）。ここは既定を持たず、記事タイプのものを使う。
 */
import type { ChangeEvent } from '../sources/types.ts'
import type { Theme } from '../theme.ts'
import type { ArticleContext, ArticleType } from './article.ts'
import type { Ledger } from './events.ts'
import { mentionsByTitle, type PublishedPost } from './coverage.ts'
import { loadArticleLog, type ArticleRecord } from './article-log.ts'
import { liveElsewhere } from './cross-service.ts'

/** 書き直す理由。**急ぐ順**に並べてある（この順序が一覧と通知の並び順になる） */
export type StaleReason = 'category' | 'passed' | 'missing'

export interface StaleArticle {
  record: ArticleRecord
  type: ArticleType
  /** いまの素材（記事タイプの `select()` を控えのフラグで回し直したもの） */
  items: ChangeEvent[]
  /** 記事が名乗っているカテゴリ（frontmatter） */
  publishedCategory: string
  /** いまの素材から決まるカテゴリ */
  currentCategory: string
  /** 記事を書いたあとに終了日が過ぎた素材 */
  passed: ChangeEvent[]
  /** その記事の本文に出ていない素材 */
  missing: ChangeEvent[]
  /** 当てはまった理由（急ぐ順） */
  reasons: StaleReason[]
}

/** カテゴリの読み手向けの呼び方。**記事の名乗りをそのまま出すための1か所。** */
const CATEGORY_LABELS: Record<string, string> = {
  leaving: '見放題終了予定',
  ended: '見放題終了',
  arrivals: '新着配信',
  ranking: 'ランキング',
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

/**
 * 控えにある記事を1件ずつ突き合わせて、書き直しどきのものを返す。
 *
 * @param types  登録されている記事タイプ（`loadArticleTypes()`）
 * @param events 収集済みの全イベント（`readAllEvents()`）
 * @param ledger 台帳。記事タイプの `select()` に渡す
 * @param posts  公開済み記事（`readPublishedPosts()`）
 * @param base   テーマと現在時刻。`now` は**素材の状態を決める**（終了日が過ぎたか）
 */
export async function staleArticles(
  types: ArticleType[],
  events: ChangeEvent[],
  ledger: Ledger,
  posts: PublishedPost[],
  base: { theme: Theme; now: Date },
): Promise<StaleArticle[]> {
  const out: StaleArticle[] = []

  for (const { record, type, post, ctx, items } of await evergreenArticles(
    types,
    events,
    ledger,
    posts,
    base,
  )) {
    const currentCategory = type.categoryOf?.(ctx, items) ?? type.category
    const publishedCategory = post.category || record.category

    /*
     * **記事を書いたあとに「終了予定」でなくなった素材。**
     * 記事の表の「状態」の欄が、そのぶんだけ事実と違っている。
     *
     * 2通りある。どちらも「書いた時点では終了予定だった」が出発点。
     *
     *   ① 予告された終了日が、書いたあとに過ぎた（`expiring` で `at` が過去）
     *   ② 実際に見放題から外れたのを、書いたあとに観測した（`removed`）
     *
     * ★ `new` は見ない。`at` は配信開始日で**書いた時点ですでに過去**なので、
     *   混ぜると全件が「期日が過ぎた」になる。
     * ★ 基準日は記事の `dataAsOf`。控えの値より**公開されている記事のほうが正**で、
     *   手で直した記事でも食い違わない。
     * ★ ②の基準は `collectedAt`（観測した日）。`at` ではないのは、
     *   終了済みの観測が**遡った日付**を持つことがあるため。
     *   記事に書けたかどうかを決めるのは「いつ把握したか」のほう。
     */
    const since = Date.parse(`${post.dataAsOf || record.writtenAt}T00:00:00Z`)
    const known = (at: string | undefined) =>
      !Number.isFinite(since) || (at !== undefined && Date.parse(at) > since)
    const passed = items.filter((e) =>
      e.kind === 'expiring'
        ? e.at !== undefined && Date.parse(e.at) < base.now.getTime() && known(e.at)
        : e.kind === 'removed' && known(e.collectedAt),
    )

    /*
     * その記事の本文に出ていない素材。
     * ★ `coverageGap()` を使わない。あちらは**同じカテゴリの記事すべて**を見るので、
     *   カテゴリが移りかけている記事（まさにここで拾いたいもの）を数えられない。
     *   ここで比べたいのは**その1本の本文**だけ。
     */
    const mentions = type.mentions ?? mentionsByTitle
    const missing = items.filter((e) => !mentions(e, post.body, items))

    const reasons: StaleReason[] = []
    if (currentCategory !== publishedCategory) reasons.push('category')
    if (passed.length > 0) reasons.push('passed')
    if (missing.length > 0) reasons.push('missing')
    if (reasons.length === 0) continue

    out.push({ record, type, items, publishedCategory, currentCategory, passed, missing, reasons })
  }

  /*
   * 並びは急ぐ順。カテゴリの食い違いが最優先で、次に期日切れの多いもの。
   * **書く順序をそのまま出す**（運用者は上から順に片づければよい）。
   */
  const weight = (s: StaleArticle) => (s.reasons.includes('category') ? 0 : 1)
  return out.sort(
    (a, b) =>
      weight(a) - weight(b) ||
      b.passed.length - a.passed.length ||
      b.missing.length - a.missing.length ||
      a.record.slug.localeCompare(b.record.slug),
  )
}

/** 控えにある記事1本ぶん。突き合わせに要るものを1か所で揃える。 */
interface EvergreenArticle {
  record: ArticleRecord
  type: ArticleType
  post: PublishedPost
  ctx: ArticleContext
  items: ChangeEvent[]
}

/**
 * 控えにある「書き直し続ける記事」を、いまの素材つきで並べる。
 *
 * ★ `staleArticles()` と `liveElsewhereRows()` の**共通の入口**。
 *   同じ復元を2か所で書くと、片方だけ条件が変わったときに
 *   「一覧には出るのに通知には出ない」記事が生まれる。
 */
async function evergreenArticles(
  types: ArticleType[],
  events: ChangeEvent[],
  ledger: Ledger,
  posts: PublishedPost[],
  base: { theme: Theme; now: Date },
): Promise<EvergreenArticle[]> {
  const bySlug = new Map(posts.map((p) => [p.slug, p]))
  const out: EvergreenArticle[] = []

  for (const record of await loadArticleLog()) {
    const type = types.find((t) => t.id === record.typeId)
    // 記事タイプが消えた／テーマを差し替えた。控えだけが残っていても比べようがない
    if (!type?.evergreen) continue

    const post = bySlug.get(record.slug)
    /*
     * ★ 記事ファイルが無い（消した）／下書きに戻した（`npm run unpublish`）ものは見ない。
     *   読者に届いていない記事に「事実と食い違う」も何も無い。
     */
    if (!post || post.draft) continue

    const variant = record.variantKey
      ? type.variants?.find((v) => v.key === record.variantKey)
      : undefined
    const ctx = {
      theme: base.theme,
      now: base.now,
      targetMonth: record.targetMonth,
      variant,
      flags: record.flags,
    }

    const items = type.select(events, ledger, ctx)
    /*
     * ★ 素材が1件も無いなら黙って飛ばす。`--match` が効かなくなった（題名の変更など）
     *   ことはありうるが、**素材ゼロで書き直せる記事は無い。**
     *   ここで鳴らしても打つ手が無く、毎日鳴り続けるだけになる。
     */
    if (items.length === 0) continue

    out.push({ record, type, post, ctx, items })
  }
  return out
}

/**
 * サービスキーを読み手向けの表記に直す。
 * ★ U-NEXT は `catalogs`（配信API）ではなく別枠にある（`theme.ts` の `unext`）。
 */
function serviceLabel(theme: Theme, key: string): string {
  if (theme.unext && theme.unext.service_key === key) return theme.unext.label
  return theme.catalogs.find((c) => c.key === key)?.label ?? key
}

/** 「終了しました」と書いた作品に、他社の生きている観測がある、という報せ1行 */
export interface LiveElsewhereRow {
  /** どの記事の話か */
  slug: string
  /** 作品名（記事に出ている表記） */
  title: string
  /** その記事が「終わった」と書いているサービス */
  offLabel: string
  /** 生きている観測が残っているサービス */
  liveLabel: string
  /** `started`＝配信開始を観測したまま / `leaving`＝終了予定日がまだ先 */
  kind: 'started' | 'leaving'
  /** 生きている観測の日付（ISO）。無ければ undefined */
  at?: string
}

/**
 * **「終了しました」と書いてある記事のうち、他社に生きている観測が残っているもの。**
 *
 * ■ なぜ `staleArticles()` と分けるのか
 * あちらは「**書き直せば直る**」ものだけを並べる。こちらは書き直しても直らない。
 * 分かるのは「当サイトのデータに食い違いがある」ことまでで、
 * **打つ手は人が確かめること**（他社で本当に観られるのか）。
 * 混ぜると `--refresh --emit` が「書き直しても何も変わらない記事」を出し続ける。
 *
 * ■ 全作終了の記事だけを見る
 * 判定が要るのは「もう観られない」と言い切った記事。
 * 終了予定が1本でも残っている記事は、読者に「まだ観られる」と伝えているので急がない
 * （記事タイプ側の検査も `stillOn === 0` のときだけ掛かる。`series.ts` の verify）。
 *
 * ★ **「他社で配信中」ではない。** 返すのは観測の食い違いまで
 *   （`core/cross-service.ts` の説明）。通知でも断定の言い方をしないこと。
 */
export async function liveElsewhereRows(
  types: ArticleType[],
  events: ChangeEvent[],
  ledger: Ledger,
  posts: PublishedPost[],
  base: { theme: Theme; now: Date },
): Promise<LiveElsewhereRow[]> {
  const out: LiveElsewhereRow[] = []

  for (const { record, type, ctx, items } of await evergreenArticles(
    types,
    events,
    ledger,
    posts,
    base,
  )) {
    const category = type.categoryOf?.(ctx, items) ?? type.category
    if (category !== 'ended') continue

    for (const hit of liveElsewhere(items, events, base.now, type.sameWork)) {
      out.push({
        slug: record.slug,
        title: hit.ended.work.localizedTitle ?? hit.ended.work.title,
        offLabel: serviceLabel(base.theme, hit.ended.service),
        liveLabel: serviceLabel(base.theme, hit.live.service),
        kind: hit.kind,
        at: hit.live.at,
      })
    }
  }

  // 記事ごとにまとめて、同じ記事の行が散らばらないようにする
  return out.sort((a, b) => a.slug.localeCompare(b.slug) || a.title.localeCompare(b.title))
}

/** 1件を1行で言い表す。一覧（`--refresh`）と通知（`core/digest.ts`）で同じ文にする。 */
export function staleSummary(s: StaleArticle): string {
  const parts: string[] = []
  if (s.reasons.includes('category')) {
    parts.push(
      `${categoryLabel(s.publishedCategory)} → ${categoryLabel(s.currentCategory)}`,
    )
  }
  if (s.reasons.includes('passed')) parts.push(`期日切れ${s.passed.length}件`)
  if (s.reasons.includes('missing')) parts.push(`未掲載${s.missing.length}件`)
  return parts.join(' / ')
}
