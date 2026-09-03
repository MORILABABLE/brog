/**
 * **月を名乗る記事を、その月が過ぎたら名乗り直させる。**
 *
 * `staleArticles()`（`core/stale.ts`）と対になる層。答えの出し方が正反対なので分けてある。
 *
 *   stale.ts   月を名乗らない記事（シリーズ）  → **書き直す**（`--refresh` で人が書く）
 *   retire.ts  月を名乗る記事（月次・特報）    → **frontmatter の2行だけ機械が直す**
 *
 * ■ なぜ月次記事は書き直さないのか
 * 月次記事の本文は、書いた月の記録として**古くならない**。
 *
 *   タイトル `【2026年8月】…配信終了する作品32本` … 月を名乗っている
 *   見出し   `## 8月11日：…が一斉に終了`          … 日付を名乗っている
 *   本文     `8月9日時点では32本が…`               … 基準日を名乗っている
 *
 * 月を名乗っていないのは frontmatter の `category` と `tags` だけで、
 * `category` はサイトのバッジ（`site/src/config.ts` の `CATEGORIES`）になって
 * 記事一覧・追従枠・左枠・記事ページ・サイト内検索の5か所に出る。
 * **8月の記事が9月の本物の終了予定記事と同じ「配信終了予定」で並ぶ**のがこの層の直す対象。
 *
 * ■ 作品を1本も見ない
 * 見るのは frontmatter の `tags` と `category` だけ。**本文も収集データも読まない。**
 * 根拠は `leaving` の `select()` が「対象月に終了」かつ「終了日が未来」で絞っていること。
 * その月が終われば、載っている全作品の終了日が過ぎたと確定する（`leaving.ts` の `retire`）。
 *
 * ■ 何度実行しても同じ
 * 対象は「**いま**より前の月を名乗る記事」全部で、先月ぶんだけではない。
 * 実行が1回飛んでも次の実行が拾うので、**失敗が溜まらない**。
 * すでに直っている記事は差分が出ないので、そこで止まる。
 */
import type { ArticleType, RetireRule } from './article.ts'
import type { PublishedPost } from './coverage.ts'

/** 名乗り直しが必要な記事1本ぶん。**そのまま frontmatter に書ける形**で返す。 */
export interface Retirement {
  post: PublishedPost
  /** 当てはまった規則 */
  rule: RetireRule
  /** 記事が名乗っている月（`YYYY-MM`） */
  month: string
  /** 移る先のカテゴリ。変わらない場合は今の値がそのまま入る */
  category: string
  /** 差し替えたあとのタグ。並び順は元のまま */
  tags: string[]
}

/**
 * 記事タイプが宣言した規則を集める。**タグで一意にする。**
 *
 * ★ 同じタグを別々の記事タイプが宣言してよい（`leaving` と特報は同じ `配信終了` を付ける）。
 *   ただし**移る先まで同じであること**。食い違っていれば、どちらが勝つかは
 *   記事タイプの並び順という無関係なものに決まってしまうので、ここで落とす。
 */
export function retireRules(types: readonly ArticleType[]): RetireRule[] {
  const byTag = new Map<string, { rule: RetireRule; typeId: string }>()
  for (const type of types) {
    const rule = type.retire
    if (!rule) continue
    const seen = byTag.get(rule.tag)
    if (!seen) {
      byTag.set(rule.tag, { rule, typeId: type.id })
      continue
    }
    if (seen.rule.becomes !== rule.becomes || seen.rule.category !== rule.category) {
      throw new Error(
        `記事タイプ ${seen.typeId} と ${type.id} が、同じタグ「${rule.tag}」に違う移り先を宣言しています。\n` +
          `  ${seen.typeId}: ${seen.rule.becomes} / ${seen.rule.category ?? '（カテゴリは変えない）'}\n` +
          `  ${type.id}: ${rule.becomes} / ${rule.category ?? '（カテゴリは変えない）'}`,
      )
    }
  }
  return [...byTag.values()].map((v) => v.rule)
}

/**
 * 名乗り直しが要る記事を返す。**外部APIも収集データも見ない**（`core/coverage.ts` と同じ性格）。
 *
 * @param types        登録されている記事タイプ（`loadArticleTypes()`）
 * @param posts        公開済み記事（`readPublishedPosts()`）
 * @param currentMonth いまの月（`YYYY-MM`）。**サイトの基準タイムゾーンで出した値**を渡すこと
 *   （`core/datetime.ts` の `currentYearMonth`）。開発機はJST・CIはUTCで動くので、
 *   ここを素の `new Date()` から作ると月初の1回だけ結果が変わる。
 *
 * ★ `draft: true` の記事も対象にする。読者には出ていないが、**記事の名乗りが違うことは同じ**で、
 *   公開に戻した瞬間から間違ったバッジが出る。直す手間は同じ2行なので、隠れているうちに直す。
 */
export function retirements(
  types: readonly ArticleType[],
  posts: readonly PublishedPost[],
  currentMonth: string,
): Retirement[] {
  const rules = retireRules(types)
  const out: Retirement[] = []

  for (const post of posts) {
    for (const rule of rules) {
      if (!post.tags.includes(rule.tag)) continue

      // 月を名乗っていない記事はこの層の対象ではない（シリーズ記事は `--refresh` が見る）
      const month = rule.monthOf(post.tags)
      if (!month) continue
      // ★ 当月はまだ終わっていない。**文字列の比較で足りる**（`YYYY-MM` は辞書順＝時系列順）
      if (month >= currentMonth) continue

      const category = rule.category ?? post.category
      const tags = post.tags.map((t) => (t === rule.tag ? rule.becomes : t))
      // すでに直っているものは差分が無い。何度実行しても同じ結果になるのはここ
      if (category === post.category && tags.join(' ') === post.tags.join(' ')) continue

      out.push({ post, rule, month, category, tags })
      break
    }
  }

  // 古い月から並べる。取りこぼしが溜まっていたとき、**どこから溜まったか**が上に出る
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.post.slug.localeCompare(b.post.slug))
}
