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
import {
  ARRIVALS_SERVICES,
  CALENDAR_SERVICES,
  LEAVING_SERVICES,
  hasArrivals,
  hasLeaving,
  loadArrivals,
  loadLeaving,
} from './events-data'
import { formatDate } from '../utils/date'
import type { CategorySlug } from '../config'

export interface EvergreenPage {
  href: string
  /**
   * 日付を含まない素のタイトル。
   *
   * ★ **これをそのまま画面に出さないこと。** 必ず `evergreenTitle()` を通す。
   *   常設ページは中身が入れ替わり続けるので、いつ更新した情報かを
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

/**
 * 常設ページの素のタイトル。**ここが唯一の定義。**
 *
 * ★ 以前は `EVERGREEN_PAGES` と `pages/leaving/[service].astro` の**両方**に
 *   同じ文字列が書いてあった。ページ側を直して一覧側を直し忘れると、
 *   **同じページがカードと見出しで別の名前を名乗る。** 関数にして口を1つにした。
 *
 * ★ **「見放題」を落とさないこと。** レンタル・購入と区別する言葉がここにしかない
 *   （記事タイトルの決まりと同じ理由。templates/naming.md）。
 */
export function evergreenTitleBase(category: CategorySlug, label: string): string {
  return category === 'leaving'
    ? `${label}で見放題配信が終了する作品一覧`
    : // ★ 「最近」は入れない。いつ時点かは evergreenTitle() が後ろに付ける。
      //   「最近」と書いたまま日付を添えると、日付が古いときに矛盾して見える。
      `${label}で見放題になった作品一覧`
}

export const EVERGREEN_PAGES: EvergreenPage[] = [
  ...LEAVING_SERVICES.map((s) => ({
    href: `/leaving/${s.key}`,
    titleBase: evergreenTitleBase('leaving', s.label),
    category: 'leaving' as CategorySlug,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
  })),
  ...ARRIVALS_SERVICES.map((s) => ({
    href: `/arrivals/${s.key}`,
    titleBase: evergreenTitleBase('arrivals', s.label),
    category: 'arrivals' as CategorySlug,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
  })),
]

// --- 配信カレンダー -----------------------------------------------------------
//
// 2026-09-07 追加。**サービス1社につき1枚**の常設ページで、
// 終了予定（`/leaving/…`）と新着（`/arrivals/…`）を1枚にまとめ、
// 先頭に月の升目を置く（components/EventCalendar.astro）。
//
// ■ 左の枠が指すのはこちら（LeftRail.astro）
// カード5枚（終了2＋新着3）を**3枚**に畳むための入れ替え。
// 読者にとって「Netflix の終了予定」と「Netflix の新着」は
// **同じ関心の裏表**で、別々のカードにする理由が無かった。
//
// ■ ★ 従来の5ページは**消していない**
// `/leaving/netflix` は単体で表示115件（サイト最多）の面で、
// タイトルの直し（docs/FUNNEL.md 7-2）を 2026-09-06 に入れたばかり。
// **効果を測る前にURLを畳むと、測り直せなくなる。**
// カレンダーは足すだけにして、5ページはそのまま残してある。
// 畳むと決めたら public/_redirects に301を2行足せばよい（それだけで済む形にしてある）。

export interface CalendarPage {
  href: string
  /** ★ 素で画面に出さない。`evergreenTitle()` を通して基準日を添える（上と同じ決まり） */
  titleBase: string
  thumbKey: string
  label: string
  shortLabel: string
}

/**
 * 配信カレンダーの素のタイトル。**ここが唯一の定義。**
 *
 * ★ **`/leaving/<サービス>` のタイトルと言葉をずらしてある。**
 *   あちらは `Netflixで見放題配信が終了する作品一覧` で、
 *   狙っている検索語は「netflix 配信終了予定」。
 *   同じ言葉で始めると自社の2ページが同じ語で競合する（共食い）ので、
 *   こちらは「カレンダー」を主語にして別の探し方に当てる。
 *
 * ★ **「見放題」を落とさないこと。** レンタル・購入と区別する言葉がここにしかない
 *   （常設ページと同じ理由。templates/naming.md）。
 */
export function calendarTitleBase(label: string): string {
  return `${label}の見放題カレンダー`
}

export const CALENDAR_PAGES: CalendarPage[] = CALENDAR_SERVICES.map((s) => ({
  href: `/calendar/${s.key}`,
  titleBase: calendarTitleBase(s.label),
  thumbKey: s.key,
  label: s.label,
  shortLabel: shortOf(s.label),
}))

/** 指定カテゴリの常設ページだけを返す */
export function evergreenFor(category: CategorySlug): EvergreenPage[] {
  return EVERGREEN_PAGES.filter((p) => p.category === category)
}

/**
 * 指定サービスの常設ページだけを返す。サービス別まとめページ（/service/…）で使う。
 * ★ `thumbKey` がサービスキー。href から切り出さないこと（形が変わると壊れる）。
 */
export function evergreenForService(service: string): EvergreenPage[] {
  return EVERGREEN_PAGES.filter((p) => p.thumbKey === service)
}

// --- 鮮度の見せ方 -----------------------------------------------------------
//
// 常設ページは公開日を持たない。`collect` のたびに中身だけが入れ替わるので、
// 読者から見ると「いつの情報か分からないページ」になりやすい。
// そこで**基準日を必ず添える**。組み立てはこの2つの関数だけが行う
// （ページ・カード・左の枠でずれると、同じページが別の日付を名乗ることになる）。

/**
 * 常設ページのタイトル。`Netflixで見放題配信が終了する作品一覧【9月1日更新】`
 *
 * `<title>` と `<h1>`、一覧カードの見出しはすべてこれを使う。
 * 基準日が取れないときだけ、日付なしのタイトルに落ちる。
 *
 * ■ 2026-09-06 に、日付を**頭から後ろへ移した**（docs/FUNNEL.md 4-1）
 * 変更前は `【2026年9月1日時点】Netflixで配信終了予定の作品一覧`。
 * 実測でこうなっていた:
 *
 *     /leaving/netflix   表示115件（サイト最多）・クリック2件・**CTR 1.7%**・8.1位
 *
 * 8.1位でこのCTRは順位相応（3〜5%）を大きく下回る。原因は先頭の12文字。
 *
 *   1. **スマホの検索結果は全角30文字前後で切れる。** 頭に日付を置くと、
 *      読者が最初に読むのが「2026年9月1日時点」になり、
 *      **サービス名も「終了」も後ろへ押し出される**
 *   2. 9月中旬に見た読者にとって「9月1日時点」は**古い情報に見える。**
 *      鮮度を出すつもりの表示が、逆に働いていた
 *
 * ★ **「時点」ではなく「更新」。** 同じ日付でも、
 *   「時点」は情報の古さを、「更新」は手入れの新しさを名乗る。
 *   左の枠（`evergreenStamp`）が最初から「更新」だったので、そちらに揃えた。
 *
 * ★ **年を落とす。** 常設ページの基準日は必ず直近の収集日で、
 *   年をまたいだ日付にはならない（またぐ前に収集が走る）。
 *   作品ページの見出し（lib/works.ts の `headlineDate`）は
 *   過去の日付を名乗ることがあるので、あちらは年を残している。
 */
export function evergreenTitle(titleBase: string, dataAsOf: Date | null): string {
  if (!dataAsOf) return titleBase
  const md = formatDate(dataAsOf).replace(/^\d+年/, '')
  return `${titleBase}【${md}更新】`
}

/**
 * 常設枠（左の枠）に出す名前の頭。`【2026年8月25日更新】`
 *
 * ★ タイトル側（`evergreenTitle`）と**言葉は「更新」で揃えてある**
 *   （2026-09-06 に、タイトル側の「時点」を「更新」へ寄せた）。
 *   違うのは位置と年の有無だけ — こちらは枠の**頭**に出し、年も残す。
 *   枠は検索結果に出ないので文字数の制約が無く、正確さを優先できる。
 *
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

/**
 * 配信カレンダー1枚ぶんの件数と基準日。
 *
 * ★ **基準日は2つの一覧のうち新しいほう。** 片方だけを見ると、
 *   終了予定が0件のサービス（Disney+）で日付が付かなくなる。
 *
 * 左の枠は全ページで描画されるので、上の `evergreenSummary` と同じく
 * 集計をここで持っておく。
 */
const calendarSummaries = new Map<
  string,
  { leaving: number; arrivals: number; dataAsOf: Date | null }
>()

export function calendarSummary(page: CalendarPage): {
  leaving: number
  arrivals: number
  dataAsOf: Date | null
} {
  const hit = calendarSummaries.get(page.href)
  if (hit) return hit

  const service = page.thumbKey
  const lv = hasLeaving(service) ? loadLeaving(service) : { works: [], dataAsOf: null }
  const ar = hasArrivals(service) ? loadArrivals(service) : { works: [], dataAsOf: null }
  const dates = [lv.dataAsOf, ar.dataAsOf].filter((d): d is Date => d !== null)
  const summary = {
    leaving: lv.works.length,
    arrivals: ar.works.length,
    dataAsOf: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
  }
  calendarSummaries.set(page.href, summary)
  return summary
}
