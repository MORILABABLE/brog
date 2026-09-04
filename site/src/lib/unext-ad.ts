/**
 * U-NEXT（afb）の広告を出すかどうかと、出すなら何を出すかを決める1か所。
 *
 * **文言・リンク・出し分けの判断はすべてここにある。** コンポーネントは
 * ここが返したものを描くだけにしてある。U-NEXT のガイドラインは
 * 「書き方」そのものを縛るので、文言が散ると守れているか誰にも分からなくなる。
 *
 * ■ 未設定なら1バイトも出ない
 * afb のリンクコードを `.env` に入れるまで `unextAd()` は必ず null を返す。
 * 提携が通る前にコードだけ先に入れておける、という設計
 * （Amazon・AdSense・LinkSwitch と同じ扱い方。docs/AFFILIATE.md）。
 *
 * ■ ガイドライン（2026年9月3日改訂）のうち、コードで守れるもの
 *
 *   【4】誤認を招く表現の禁止
 *        「無料で見放題」「全て見放題」と書かない。ポイント作品を見放題と呼ばない。
 *        配信終了済みの作品が**すぐ観られる**と読ませない。
 *        → 文言はこのファイルの COPY だけ。カテゴリごとに言えることだけを書く。
 *   【4】「期間限定」「今だけ」「今なら31日間無料」の禁止（定常キャンペーンのため）
 *        → 煽り文句をコードに持たない。COPY に無い言い回しは出しようがない。
 *   【9】月額プラン1490の訴求禁止 → 料金は 2,189円（税込）しか持たない。
 *   【11】無料視聴訴求の禁止 → 作品に対して「無料」と書かない。
 *        31日間無料トライアルは**サービスの正式名称**なので触れてよいが、
 *        既定では出さない（下の TRIAL_COPY）。
 *   注意事項【2】総額表示 → 料金は税込表記でしか持たない。
 *   注意事項【4】記載必須の注意文言 → `noticeFor()`。広告と同じ枠に必ず出す。
 *   掲載NG権利元・作品 → `unext-ng.ts`。該当ページには広告そのものを出さない。
 *
 * ■ コードでは守れないもの（人が守る）
 *   【1】リスティング広告への出稿禁止 … 出稿しない
 *   【5】LP以外への誘導 … afb 管理画面で正しいLPのリンクコードを取る（下の LP）
 *   注意事項【6】SNS・YouTube の PR 表記 … 投稿する人が付ける
 */
import { ngHitsIn } from './unext-ng'
import type { CategorySlug } from '../config'

/**
 * 枠。**Amazon 側の AMAZON_SLOTS と同じ名前を使う**（affiliate.ts）。
 * 揃えておくと「同じ枠で Amazon と afb のどちらが効いたか」を並べて読める。
 *
 * afb ではリンクコードの末尾に `&id1=<枠>` として付ける。成果データの
 * `keyword` 欄に返ってくる（docs/AFFILIATE.md 11-4）。
 */
export const UNEXT_SLOTS = ['cta', 'rail', 'work', 'table', 'poster', 'body'] as const
export type UnextSlot = (typeof UNEXT_SLOTS)[number]

/**
 * id1 に使える文字（afb の仕様）。半角英数字と `.` `-` `_` `*` だけ。
 * 日本語や `=` `&` `/` は使えない。**枠名を増やすときはここを通ること。**
 */
const SLOT_OK = /^[A-Za-z0-9._*-]+$/

/**
 * ジャンル別LP。**成果はここで指定されたLPからしか認められない**
 * （ガイドライン【5】「下記で紹介しているLP以外での成果は却下となります」）。
 *
 * ★ だから当サイトの U-NEXT 検索リンク（`video.unext.jp/freeword?query=…`）を
 *   afb のリンクへ差し替えても成果にはならない。**作品名を渡す導線と、
 *   成果になる導線は別物として並べる**しかない。docs/AFFILIATE.md 12節。
 *
 * ★ 値は afb 管理画面から取ったリンクコードの href（`https://t.afi-b.com/visit.php?…`）。
 *   **手で組み立てないこと。** `a=` と `p=` は afb が発行する。
 */
const LP = {
  /** 総合（U-NEXT トップ）。他のLPが未設定のときの落とし先 */
  default: import.meta.env.PUBLIC_AFB_UNEXT_LP ?? '',
  anime: import.meta.env.PUBLIC_AFB_UNEXT_LP_ANIME ?? '',
  movie: import.meta.env.PUBLIC_AFB_UNEXT_LP_MOVIE ?? '',
  'overseas-drama': import.meta.env.PUBLIC_AFB_UNEXT_LP_OVERSEAS_DRAMA ?? '',
  'asia-drama': import.meta.env.PUBLIC_AFB_UNEXT_LP_ASIA_DRAMA ?? '',
  'domestic-drama': import.meta.env.PUBLIC_AFB_UNEXT_LP_DOMESTIC_DRAMA ?? '',
  kids: import.meta.env.PUBLIC_AFB_UNEXT_LP_KIDS ?? '',
  music: import.meta.env.PUBLIC_AFB_UNEXT_LP_MUSIC ?? '',
} as const

export type UnextLpKey = keyof typeof LP

/** U-NEXT の広告が1つでも出せる状態か。**既定のLPが唯一の必須。** */
export const UNEXT_AD_ENABLED = Boolean(LP.default)

/**
 * 31日間無料トライアルに触れるか（既定は触れない）。
 *
 * ■ なぜ既定で出さないか
 * トライアル登録が**成果地点そのもの**なので、触れたほうが成約率は上がる。
 * 一方でガイドラインが最も細かく縛っているのもここで、
 * 「期間限定」「今なら」と書けば一発で違反、作品に対して「無料」と読める
 * 書き方をしても違反になる（【4】【11】）。当サイトは自動生成の記事が
 * 700本あり、**文言が1か所崩れると全ページに広がる。**
 *
 * だから既定は「作品の取り扱いを確認する」で止め、トライアルに触れるかどうかを
 * **運用者が明示的に選ぶ**形にしてある。`.env` に `PUBLIC_AFB_UNEXT_TRIAL=1` を
 * 入れると下の TRIAL の1行が増える。文面はここ以外に無い。
 */
const TRIAL_COPY = import.meta.env.PUBLIC_AFB_UNEXT_TRIAL === '1'

/**
 * 料金と特典。**税込表記でしか持たない**（総額表示義務・注意事項【2】）。
 * 数字はガイドライン注意事項【1】の写し。改訂されたら直すこと。
 *
 * ★ 「今なら」「期間限定」を足さないこと。31日間無料トライアルは
 *   定常的に実施されているので、限定であるかのように書くと【4】違反になる。
 * ★ 月額プラン1490は**書けない**（【9】）。ここに増やさないこと。
 */
const TRIAL =
  '31日間無料トライアルの対象サービスです（月額プラン2,189円・税込／600円分のポイント付き）。'

/**
 * 記載必須の注意文言（注意事項【4】）。
 * **広告と同じ枠に必ず出す。** 文面はガイドラインの指定どおり。
 */
export function noticeFor(asOf: Date): string {
  const y = asOf.getFullYear()
  const m = asOf.getMonth() + 1
  return `本ページの情報は${y}年${m}月時点のものです。最新の配信状況はU-NEXTサイトにてご確認ください。`
}

/**
 * カテゴリごとの文面。**言えることだけを言う。**
 *
 * ★ 配信終了（leaving / ended）の記事で「観られます」と書かないこと。
 *   見放題が終わった作品はポイント（レンタル・購入）で残ることがある、
 *   というのが当サイトの持っている事実の限界（ガイドライン【4】）。
 * ★ 「探す」「確認する」より強い動詞を使わないこと。当サイトは
 *   U-NEXT の在庫データを持っていない（AmazonCta.astro と同じ線引き）。
 */
const COPY: Record<string, { body: string; action: string }> = {
  leaving: {
    body: '見放題での配信が終わったあとも、ポイント（レンタル・購入）での取り扱いが続く作品があります。作品ごとの取り扱いはU-NEXTで確認できます。',
    action: 'U-NEXTで作品の取り扱いを見る',
  },
  ended: {
    body: '見放題での配信は終了していますが、ポイント（レンタル・購入）での取り扱いが続く作品があります。作品ごとの取り扱いはU-NEXTで確認できます。',
    action: 'U-NEXTで作品の取り扱いを見る',
  },
  arrivals: {
    body: 'U-NEXTは見放題の作品とポイント（レンタル・購入）の作品が同居しています。どちらの扱いかは作品ごとに違います。',
    action: 'U-NEXTで作品を探す',
  },
  ranking: {
    body: 'U-NEXTは見放題の作品とポイント（レンタル・購入）の作品が同居しています。どちらの扱いかは作品ごとに違います。',
    action: 'U-NEXTで作品を探す',
  },
}

const FALLBACK = {
  body: 'U-NEXTで配信されているかどうかは作品ページで確認できます。見放題とポイント（レンタル・購入）のどちらの扱いかも、そこに書かれています。',
  action: 'U-NEXTで作品を探す',
}

/**
 * ジャンル → LP。**記事の主題に合ったLPへ送る。**
 *
 * 受けるのは2種類の呼び方。どちらも当サイトに実在する値で、
 * 呼び出し側がどちらを持っているかは場所によって違う。
 *   サイトのジャンル（config.ts の GENRES）  … anime / western / japanese
 *   U-NEXT のジャンル（theme.yaml の unext）  … youga / houga / kaigai-drama など
 */
const LP_BY_GENRE: Record<string, UnextLpKey> = {
  // サイトのジャンル軸
  anime: 'anime',
  western: 'movie',
  japanese: 'movie',
  // U-NEXT のジャンル
  youga: 'movie',
  houga: 'movie',
  'kaigai-drama': 'overseas-drama',
  'asia-drama': 'asia-drama',
  'kokunai-drama': 'domestic-drama',
  kids: 'kids',
  music: 'music',
  stage: 'music',
}

/** そのLPのリンク。**未設定のLPは既定に落ちる**（空文字は未設定として扱う）。 */
function hrefFor(lp: UnextLpKey): { href: string; lp: UnextLpKey } {
  const direct = LP[lp]
  return direct ? { href: direct, lp } : { href: LP.default, lp: 'default' }
}

/**
 * リンクコードに枠（`id1`）を足す。
 *
 * afb が認めている改変は `target` を外すこと・`rel` を `noopener` /
 * `sponsored` にすること・**パラメータの追加**まで（docs/AFFILIATE.md 11-3）。
 * `a=` `p=` には触れない。
 */
export function withSlot(href: string, slot: UnextSlot): string {
  if (!href || !SLOT_OK.test(slot)) return href
  try {
    const u = new URL(href)
    u.searchParams.set('id1', slot)
    return u.toString()
  } catch {
    // リンクコードが URL として読めない形（貼り間違い）。
    // 勝手に文字列連結して壊すより、そのまま返して検査に見つけさせる。
    return href
  }
}

export interface UnextAd {
  href: string
  lp: UnextLpKey
  slot: UnextSlot
  body: string
  action: string
  /** 記載必須の注意文言。**必ず一緒に描くこと** */
  notice: string
  /** 31日間無料トライアルの1行。`PUBLIC_AFB_UNEXT_TRIAL=1` のときだけ入る */
  trial?: string
}

export interface UnextAdInput {
  slot: UnextSlot
  /** 記事カテゴリ。文面が変わる */
  category?: CategorySlug
  /** 記事のジャンル、または U-NEXT のジャンルキー。LPの選択に使う */
  genre?: string
  /**
   * そのページに出ている文字列（記事本文・作品名を並べたもの）。
   *
   * ★ **必ず渡すこと。** 掲載NGの作品・権利元が含まれていたら広告を出さない
   *   （ガイドライン「掲載NG権利元、作品について」）。渡さないと素通りする。
   */
  pageText?: string
  /** 注意文言に出す基準日。記事の `dataAsOf` を渡す。無ければビルド日 */
  asOf?: Date
}

/**
 * この場所に U-NEXT の広告を出すか。**出さないときは null。**
 *
 * 出さない条件は4つ。
 *   1. リンクコードが未設定（提携前＝既定の状態）
 *   2. 掲載NGの作品・権利元がページにある
 *   3. 枠名が afb の使える文字でない（実装ミス。静かに壊れるより出さない）
 *   4. そのLPも既定のLPも未設定
 */
export function unextAd(input: UnextAdInput): UnextAd | null {
  if (!UNEXT_AD_ENABLED) return null
  if (!SLOT_OK.test(input.slot)) return null

  if (input.pageText && ngHitsIn(input.pageText).length > 0) return null

  const key = (input.genre && LP_BY_GENRE[input.genre]) || 'default'
  const { href, lp } = hrefFor(key)
  if (!href) return null

  const copy = (input.category && COPY[input.category]) || FALLBACK
  return {
    href: withSlot(href, input.slot),
    lp,
    slot: input.slot,
    body: copy.body,
    action: copy.action,
    notice: noticeFor(input.asOf ?? new Date()),
    trial: TRIAL_COPY ? TRIAL : undefined,
  }
}

