/**
 * 記事タイプ: 配信開始予定（サービス別）
 *
 *   npm run write -- --type upcoming-service --service netflix --month 2026-09 --emit
 *
 * ■ なぜ `upcoming`（サービス×ジャンル）と別に要るのか
 * ジャンル軸の `upcoming` は、作品を3区分（アニメ／洋画・海外ドラマ／邦画・国内ドラマ）に
 * 振り分けられることが前提になっている。ところが**告知元によってはジャンルが取れない。**
 *
 *   About Amazon  見出しが「映画（海外・韓国）」「テレビアニメ（日本）」→ 振り分けられる
 *   Disney+       見出しが無い（配信スケジュールは日付だけ）    → 振り分けられない
 *   Netflix       国も種別もページに無い（genre は数値IDのみ）   → 振り分けられない
 *
 * `genres.ts` の方針は「決まらないものは落とす」なので、ジャンル軸の記事では
 * **Netflix と Disney+ の告知が丸ごと消える**（実測: Netflix 20件中0件が分類できた）。
 * 当て推量で振り分けるのは論外なので、**ジャンルを要求しない軸**をもう1本立てる。
 *
 * ■ 中身は特報を借りている
 * `upcoming`（ジャンル軸）と同じく、構成・文体・固定文言は特報の `--kind upcoming`
 * をそのまま使う。**違うのは軸と素材の絞り方だけ**なので、文章の型は1か所に置いておく。
 *
 * ★ ただし `select` と `verifyTitle` は借りない。
 *   - `select`  特報は「絞り込みを1つも渡さないとその月の全件になる」ことを禁じているが、
 *               この記事は**1社の当月全件がまさに中身**なので、その検査に引っかかる。
 *   - verifyTitle 特報は主題軸（`axis: 'topic'`＝サービス横断可）。こちらはサービス軸で、
 *               **他社名を入れてはいけない**という強いほうの検査を使う。
 *
 * ■ ジャンル軸の記事と食い合わないか
 * 食い合う月がありうる。**Prime Video だけは両方書ける**ためで、そこは運用で選ぶ
 * （`docs/ARTICLE-RULES.md` の「同じ月に2本目を作らない」）。
 * Netflix と Disney+ はジャンル軸で書けないので、こちらしか選択肢が無い。
 */
import type { ArticleContext, ArticleType, Category } from '../../../pipeline/core/article.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import { specialArticle } from './special.ts'
import {
  isTargetMonth,
  previousAsOf,
  publishable,
  serviceLabels,
  titleIssues,
} from './shared.ts'

const base = specialArticle

/**
 * 告知を取り込んでいるサービスだけを並べる。
 * **`theme.yaml` の `announcements:` と揃えること。**
 * 素材が無いサービスを並べても `--list` に「素材なし」が増えるだけになる。
 */
const SERVICE_VARIANTS = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'disney-plus', label: 'Disney+' },
] as const

/**
 * 記事として成立する最低件数。
 *
 * ジャンル軸（`upcoming`）に下限を置いていないのは、3本に割ったあとの
 * 薄いジャンルを織り込んでいるため。こちらは割らない1本なので、
 * 10件を下回る月は記事にしないほうがサイトの価値を保てる。
 */
const MIN_ITEMS = 10

/**
 * 特報のプロンプトに入っている枠組みの1文。**差し替える対象。**
 * `special.ts` の buildPrompt にある文字列と1文字も違えないこと
 * （違っていれば buildPrompt が落ちて教える）。
 */
const SPECIAL_FRAMING = 'この記事は**主題を軸にした特報**です。月次のまとめ記事ではありません。'

/** サービス軸の月次記事としての名乗り */
const SERVICE_FRAMING =
  'この記事は**1つのサービスを軸にした月次のまとめ記事**です。' +
  '**他社の作品を混ぜないでください**（タイトルにも本文にも他社名を出さない）。'

/**
 * 特報として解釈させるための文脈。
 *
 * ★ `variant` を落としてから渡す。特報は主題軸なので、バリアントを残すと
 *   「ジャンル軸なのにサービス名がある」という別の検査に引っかかる
 *   （`upcoming.ts` の `asSpecial` と同じ理由）。
 *
 * ★ `topic` は「作品」。固定文言 `special-upcoming-lead-first-sentence` が
 *   「{サービス}で{月}月に見放題配信が始まる予定の{主題}をまとめました。」なので、
 *   ここに入るのは主題の呼び名であってサービス名ではない。
 *   サービス名は文言側の {サービス} に入る。
 */
function asSpecial(ctx: ArticleContext): ArticleContext {
  return {
    ...ctx,
    variant: undefined,
    flags: {
      ...ctx.flags,
      kind: 'upcoming',
      service: ctx.variant?.key ?? '',
      topic: '作品',
      // 特報側の slug() は使わない（このファイルの slug() が上書きする）。
      // 渡しておかないと必須フラグの検査で落ちるので形だけ入れる。
      slug: ctx.variant?.key ?? 'service',
    },
  }
}

export const upcomingServiceArticle: ArticleType = {
  ...base,
  id: 'upcoming-service',
  // ★ サービス軸。1社だけを名乗り、他社名を入れない。
  axis: 'service',
  category: 'arrivals',
  description: '配信開始予定（サービス別。ジャンルを問わない）',
  variants: SERVICE_VARIANTS,
  variantFlag: 'service',
  variantNoun: 'サービス',
  minItems: MIN_ITEMS,
  // 特報の必須フラグ（kind / topic / slug）は asSpecial が埋めるので、人には求めない。
  flags: [],

  categoryOf(): Category {
    return 'arrivals'
  },

  /**
   * 1社ぶんの「対象月に配信開始予定」を全件。
   *
   * ★ 特報の `select` は借りない（このファイル冒頭の理由）。
   *   借りると「絞り込みが要ります」で必ず落ちる。
   */
  select(rawEvents: ChangeEvent[], _ledger: Ledger, ctx: ArticleContext): ChangeEvent[] {
    const service = ctx.variant?.key
    if (!service) return []

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    return publishable(rawEvents)
      .filter((e) => e.kind === 'upcoming')
      .filter((e) => e.service === service)
      // 日付の無い告知は「いつから観られるか」を渡せないので記事にしない
      .filter((e) => e.at)
      .filter((e) => isTargetMonth(e.at!, ctx))
      .sort((a, b) => a.at!.localeCompare(b.at!))
  },

  buildPrompt(items, ctx) {
    // ★ call で this を渡す。特報側は `this.slug(ctx)` で前の版を探すので、
    //   ここで this を渡さないと**特報のスラッグ**を見に行って更新版を見落とす。
    const prompt = base.buildPrompt.call(this, items, asSpecial(ctx))

    // ★ 枠組みの1文だけ差し替える。
    //   特報は「人が決めたときだけ出す記事」なので「月次のまとめ記事ではありません」と
    //   名乗るが、**この記事は毎月出す月次記事**で、そのまま渡すと嘘になる。
    //   文言が見つからなければ**黙って直さずに落とす**（特報側を直したときに気づけるように）。
    // 枠組み文は system 側にも prompt 側にも来うるので、両方を見る
    if (!prompt.system.includes(SPECIAL_FRAMING) && !prompt.prompt.includes(SPECIAL_FRAMING)) {
      throw new Error(
        'special.ts の枠組み文が変わったため、upcoming-service が差し替えられません。' +
          `期待した文: ${SPECIAL_FRAMING}
` +
          '  theme-packs/streaming-jp/article-types/upcoming-service.ts の SPECIAL_FRAMING を直してください',
      )
    }
    return {
      system: prompt.system.replace(SPECIAL_FRAMING, SERVICE_FRAMING),
      prompt: prompt.prompt.replace(SPECIAL_FRAMING, SERVICE_FRAMING),
    }
  },

  verify(md, items, ctx) {
    return base.verify.call(this, md, items, asSpecial(ctx))
  },

  /**
   * ★ 特報から借りない。特報は主題軸（サービス横断可）だが、
   *   こちらはサービス軸なので**他社名を入れない**検査が要る。
   */
  verifyTitle(title, ctx) {
    const issues = titleIssues(title, ctx, {
      axis: 'service',
      // 先頭の【】が「2026年9月配信開始」と動詞まで名乗るので、動詞句は求めない
      verbPhrase: '',
      periodLabel: `${ctx.targetMonth.split('-')[0]}年${Number(ctx.targetMonth.split('-')[1])}月配信開始`,
      axisLabel: ctx.variant?.label,
      isUpdate: previousAsOf(this.slug!(ctx)) !== undefined,
    })

    // ★ 先頭の【】から動詞句の検査を外したぶん、**見放題であることは必ず名乗らせる。**
    //   「配信」だけだと購入・レンタルと区別が付かない（naming.md の決まり）。
    if (!title.includes('見放題')) {
      issues.push({
        level: 'error',
        message:
          'タイトルに「見放題」がありません。購入・レンタルと区別できないタイトルは作りません。' +
          '例:【2026年9月配信開始】Netflixの見放題作品20本｜…',
      })
    }
    return issues
  },

  /**
   * ★ 特報から借りない。借りると「特報」のタグが付くが、これは毎月出す記事。
   */
  tags(items, ctx) {
    const labelOf = serviceLabels(ctx)
    const [y, m] = ctx.targetMonth.split('-')
    return [
      labelOf.get(ctx.variant?.key ?? '') ?? ctx.variant?.label,
      '配信開始予定',
      `${y}年${Number(m)}月`,
    ].filter((t): t is string => Boolean(t))
  },

  /**
   * ジャンル軸（`upcoming`）で同じ月・同じサービスを書いてあれば、そちらが覆っている。
   *
   * ★ Prime Video は告知に区分があるのでジャンル軸で3本書ける。
   *   書いたあとにこちらが「未作成」と出続けると、件数だけを見て書き始めて
   *   **同じ作品の記事が2本立つ**（同じ検索語を自分同士で奪い合う）。
   *   Netflix / Disney+ はジャンル軸で書けないので、ここが当たることはない。
   */
  coveredBy(ctx, existing) {
    const service = ctx.variant?.key
    if (!service) return undefined
    const prefix = `${ctx.targetMonth}-upcoming-${service}-`
    const n = [...existing].filter((s) => s.startsWith(prefix)).length
    return n > 0 ? `ジャンル軸${n}本` : undefined
  },

  /**
   * `2026-09-upcoming-netflix`。
   *
   * ★ `--list` と重複チェックはフラグ無しで呼ぶので、落とさずに形だけ返す。
   *   ジャンル軸（`2026-09-upcoming-prime-video-anime`）とは別のURLになる。
   */
  slug(ctx) {
    return `${ctx.targetMonth}-upcoming-${ctx.variant?.key ?? '<サービス>'}`
  },
}
