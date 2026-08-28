/**
 * 記事タイプ: 配信開始予定（サービス × ジャンル）
 *
 *   npm run write -- --type upcoming --genre anime --service prime-video --month 2026-09 --emit
 *
 * ■ 何のための記事か
 * 各社が前月末に公表する「翌月のラインナップ」を、**配信が始まる前に**出す記事。
 * 素材は告知の取り込み（`npm run collect:announce` / docs/ANNOUNCEMENTS.md）で貯まる
 * `kind: upcoming` のイベント。
 *
 * ■ なぜ特報（special）と別のタイプなのか
 * 特報は「主題と時期をそのつど人が決めて出す」もので、毎月は出ない。
 * こちらは**毎月・決まった軸（サービス×ジャンル）で出す**ので、
 * `--list` に並んで件数が見えるほうが運用しやすい
 * （index.ts の「サービス別とジャンル別を並べる場合は別タイプにする」と同じ理由）。
 *
 * ■ 中身は特報を借りている
 * 構成・文体・固定文言・品質ゲートは特報の `--kind upcoming` とまったく同じで、
 * **違うのは「素材の絞り方（サービス×ジャンル）」と「毎月出すこと」だけ**。
 * そこで実装は借りて、フラグの組み立てとスラッグだけをこのファイルが持つ。
 * 特報側を直せばこちらも直る（2つの記事の書き方がずれない）。
 *
 * ■ ジャンルで判定できない作品は落ちる
 * スポーツ・バラエティーは3区分のどれでもないので、どの記事にも載らない
 * （`genres.ts` の方針。当て推量で邦画記事に入れるほうが害が大きい）。
 * ラインナップを1本残らず出したい月は、特報として1本書く
 * （`--type special --kind upcoming --from/--to`）。
 */
import type { ArticleContext, ArticleType, Category } from '../../../pipeline/core/article.ts'
import { GENRES } from '../genres.ts'
import { specialArticle } from './special.ts'
import { serviceLabels } from './shared.ts'

const base = specialArticle

/** スラッグに使えるサービスキーの形。テーマ側の catalogs.key と揃える。 */
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9-]{1,32}$/

function serviceOf(ctx: ArticleContext): string {
  const key = ctx.flags?.service ?? ''
  if (key && !SERVICE_PATTERN.test(key)) {
    throw new Error(`--service はサービスキーで指定してください（例: prime-video）: ${key}`)
  }
  return key
}

/**
 * 特報として解釈させるための文脈。
 *
 * ★ `variant` を落としてから渡す。特報は主題軸（`axis: 'topic'`）で、
 *   タイトルの軸の検査は `flags.topic` を見る。バリアントを残すと
 *   「ジャンル軸なのにサービス名がある」という別の検査に引っかかる。
 */
function asSpecial(ctx: ArticleContext): ArticleContext {
  const genre = ctx.variant?.key ?? ''
  return {
    ...ctx,
    variant: undefined,
    flags: {
      ...ctx.flags,
      kind: 'upcoming',
      genre,
      // 主題はジャンルの呼び方そのもの（「アニメ」「洋画・海外ドラマ」…）。
      // タイトルにこの文字列が入っているかを品質ゲートが見る。
      topic: ctx.variant?.label ?? '',
      // 特報側の slug() は使わない（このファイルの slug() が上書きする）。
      // 渡しておかないと必須フラグの検査で落ちるので形だけ入れる。
      slug: `${serviceOf(ctx)}-${genre}`,
    },
  }
}

export const upcomingArticle: ArticleType = {
  ...base,
  id: 'upcoming',
  // ★ 主題軸。サービス名とジャンル名の両方をタイトルに出す記事なので、
  //   サービス軸（他社名を禁止）でもジャンル軸（サービス名を禁止）でもない。
  axis: 'topic',
  category: 'arrivals',
  description: '配信開始予定（サービス×ジャンル。--service が必要）',
  variants: GENRES,
  variantNoun: 'ジャンル',
  flags: [
    { name: 'service', description: '対象のサービスキー（例: prime-video）', required: true },
  ],

  // kind は upcoming 固定なので、実行時に決まる余地が無い。
  categoryOf(): Category {
    return 'arrivals'
  },

  select(events, ledger, ctx) {
    return base.select(events, ledger, asSpecial(ctx))
  },

  buildPrompt(items, ctx) {
    // ★ call で this を渡す。特報側は `this.slug(ctx)` で前の版を探すので、
    //   ここで this を渡さないと**特報のスラッグ**を見に行って更新版を見落とす。
    return base.buildPrompt.call(this, items, asSpecial(ctx))
  },

  /**
   * ★ 特報から借りない唯一のメソッド。
   *   借りると「特報」というタグが付くが、これは毎月出す記事で特報ではない。
   *   かわりにジャンルをタグにして、読者が同じ区分の記事を辿れるようにする。
   */
  tags(items, ctx) {
    const labelOf = serviceLabels(ctx)
    const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
    const [y, m] = ctx.targetMonth.split('-')
    return [
      ...services,
      '配信開始予定',
      ctx.variant?.label,
      `${y}年${Number(m)}月`,
    ].filter((t): t is string => Boolean(t))
  },

  verify(md, items, ctx) {
    return base.verify.call(this, md, items, asSpecial(ctx))
  },

  verifyTitle(title, ctx) {
    return base.verifyTitle!.call(this, title, asSpecial(ctx))
  },

  /**
   * `2026-09-upcoming-prime-video-anime`。
   *
   * ★ `--list` と重複チェックはフラグ無しで呼ぶので、落とさずに形だけ返す。
   */
  slug(ctx) {
    const service = serviceOf(ctx) || '<サービス>'
    const genre = ctx.variant?.key ?? '<ジャンル>'
    return `${ctx.targetMonth}-upcoming-${service}-${genre}`
  },
}
