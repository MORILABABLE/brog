/**
 * 常設ページの一覧。**左の枠とカテゴリページの両方がここを読む。**
 *
 * ページを増やす・減らす・並べ替えるときはこのファイルだけを直せばよい。
 * 表示の形は使う側（LeftRail / EvergreenCard）が決める。
 *
 * ★ `/stats`（見放題の増減）はここに入れていない。
 *   読者にとって用途が伝わりにくく、記事の並びに混ぜると浮くため
 *   （2026-08-23 の判断）。ページ自体は残してあり、
 *   常設ページ下部の関連リンクから辿れる（＝孤立ページにはしない）。
 */
import { ARRIVALS_SERVICES, LEAVING_SERVICES, loadArrivals, loadLeaving } from './events-data'
import { formatDate } from '../utils/date'
import type { CategorySlug } from '../config'

export interface EvergreenPage {
  href: string
  /**
   * 日付を含まない素のタイトル。
   *
   * ★ **これをそのまま画面に出さないこと。** 必ず `evergreenTitle()` を通す。
   *   常設ページは中身が入れ替わり続けるので、いつ時点の情報かを
   *   タイトルに必ず添える方針にしてある（2026-08-25）。
   *   `title` ではなく `titleBase` という名前にしてあるのは、
   *   素で出す実装を書いたときに気づけるようにするため。
   */
  titleBase: string
  /** カテゴリバッジ。styles/global.css の .badge[data-category] と対応する。 */
  category: CategorySlug
  /** サムネイルのキー。src/assets/services/<キー>.png を探す。 */
  thumbKey: string
  /** サービス表示名 */
  label: string
  /**
   * 幅の狭い場所で使う短い名前。
   *
   * ★ 左の枠は1200px時点で文字に使える幅が約158pxしか無く、
   *   「Amazon Prime Video」は2行に折り返してカードの高さが不揃いになる。
   *   1行に収まる名前をここに持たせて並びを保つ。
   */
  shortLabel: string
}

/** 表示名 → 左の枠で使う短い名前 */
const SHORT_LABELS: Record<string, string> = {
  'Amazon Prime Video': 'Prime Video',
}

function shortOf(label: string): string {
  return SHORT_LABELS[label] ?? label
}

export const EVERGREEN_PAGES: EvergreenPage[] = [
  ...LEAVING_SERVICES.map((s) => ({
    href: `/leaving/${s.key}`,
    titleBase: `${s.label}で配信終了予定の作品一覧`,
    category: 'leaving' as CategorySlug,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
  })),
  ...ARRIVALS_SERVICES.map((s) => ({
    href: `/arrivals/${s.key}`,
    // ★ 「最近」は入れない。いつ時点かは evergreenTitle() が頭に付ける。
    //   「最近」と書いたまま日付を添えると、日付が古いときに矛盾して見える。
    titleBase: `${s.label}で見放題になった作品一覧`,
    category: 'arrivals' as CategorySlug,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
  })),
]

/** 指定カテゴリの常設ページだけを返す */
export function evergreenFor(category: CategorySlug): EvergreenPage[] {
  return EVERGREEN_PAGES.filter((p) => p.category === category)
}

// --- 鮮度の見せ方 -----------------------------------------------------------
//
// 常設ページは公開日を持たない。`collect` のたびに中身だけが入れ替わるので、
// 読者から見ると「いつの情報か分からないページ」になりやすい。
// そこで**基準日を必ず前に出す**。組み立てはこの2つの関数だけが行う
// （ページ・カード・左の枠でずれると、同じページが別の日付を名乗ることになる）。

/**
 * 常設ページのタイトル。`【2026年8月25日時点】Netflixで配信終了予定の作品一覧`
 *
 * `<title>` と `<h1>`、一覧カードの見出しはすべてこれを使う。
 * 基準日が取れないときだけ、日付なしのタイトルに落ちる。
 */
export function evergreenTitle(titleBase: string, dataAsOf: Date | null): string {
  return dataAsOf ? `【${formatDate(dataAsOf)}時点】${titleBase}` : titleBase
}

/**
 * 常設枠（左の枠）に出す名前の頭。`【2026年8月25日更新】`
 *
 * タイトル側が「時点」なのに対してこちらが「更新」なのは、
 * 枠の役割が「この一覧はいつ更新されたか」を示すことだから。
 * 基準日が取れないときは空文字を返す（何も出さない）。
 */
export function evergreenStamp(dataAsOf: Date | null): string {
  return dataAsOf ? `【${formatDate(dataAsOf)}更新】` : ''
}

/**
 * 常設ページ1枚ぶんの件数と基準日。
 *
 * 左の枠は全ページで描画されるので、同じ集計が何度も走る。
 * `events-data` 側で読み込みはキャッシュ済みだが、集計もここで持っておく。
 */
const summaries = new Map<string, { count: number; dataAsOf: Date | null }>()

export function evergreenSummary(page: EvergreenPage): { count: number; dataAsOf: Date | null } {
  const hit = summaries.get(page.href)
  if (hit) return hit

  const key = page.href.split('/').pop()!
  const data = page.category === 'leaving' ? loadLeaving(key) : loadArrivals(key)
  const summary = { count: data.works.length, dataAsOf: data.dataAsOf }
  summaries.set(page.href, summary)
  return summary
}
