/**
 * 常設ページ（配信カレンダー）の一覧。**左の枠・サービス別ページ・メニューがここを読む。**
 *
 * ページを増やす・減らす・並べ替えるときはこのファイルだけを直せばよい。
 * 表示の形は使う側（LeftRail / EvergreenCard / Header）が決める。
 *
 * ■ 2026-09-17 に形を変えた（docs/WHERE-TO-EDIT.md の「配信カレンダー」）
 * サービスごとに2枚。**両方ともカレンダーで、ページの上の切り替え（CalendarPicker）で行き来する。**
 *
 *   /leaving/<サービス>  … 終了予定（これから）＋ 終了済み（前月から）
 *   /arrivals/<サービス> … 配信開始予定（これから）＋ 新着（直近60日）
 *
 * それまでの `/calendar/<サービス>`（両方を1枚にしたページ）は `/leaving/<サービス>` へ、
 * ヘッダーのメニューの行き先だった `/category/<ハブ>/<サービス>` は、
 * カレンダーのある社について同じ向きのカレンダーへ転送した（public/_redirects）。
 *
 * ★ `/stats`（サービス別見放題の追加・削除一覧）はここに入れていない。
 *   読者にとって用途が伝わりにくく、記事の並びに混ぜると浮くため
 *   （2026-08-23 の判断）。ページ自体は残してあり、
 *   常設ページ下部の関連リンクから辿れる（＝孤立ページにはしない）。
 */
import {
  CALENDAR_SERVICES,
  hasCalendar,
  hasExpiring,
  loadArrivals,
  loadEnded,
  loadLeaving,
  loadUpcoming,
} from './events-data'
import { formatDate } from '../utils/date'
import type { CategorySlug } from '../config'

/**
 * カレンダーの向き。URL の頭（`/leaving` `/arrivals`）と同じ文字列で、
 * **カテゴリ（バッジの色）とも同じ文字列**（config.ts の CATEGORIES）。
 */
export type CalendarDirection = Extract<CategorySlug, 'leaving' | 'arrivals'>

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
  category: CalendarDirection
  /** サムネイルのキー。src/assets/services/<キー>.png を探す。**サービスキーでもある** */
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
  /** 中身の呼び名。「◯◯を12本、カレンダーと一覧にまとめています」の ◯◯ */
  contents: string
}

/** 表示名 → 左の枠で使う短い名前 */
const SHORT_LABELS: Record<string, string> = {
  'Amazon Prime Video': 'Prime Video',
}

export function shortOf(label: string): string {
  return SHORT_LABELS[label] ?? label
}

/**
 * 常設ページの素のタイトル。**ここが唯一の定義。**
 *
 * ★ 以前は `EVERGREEN_PAGES` とページの**両方**に同じ文字列が書いてあった。
 *   ページ側を直して一覧側を直し忘れると、**同じページがカードと見出しで別の名前を名乗る。**
 *
 * ★ **「見放題」を落とさないこと。** レンタル・購入と区別する言葉がここにしかない
 *   （記事タイトルの決まりと同じ理由。templates/naming.md）。
 *
 * ■ 「一覧」を残して「カレンダー」を足した（2026-09-17）
 * `/leaving/netflix` は「◯◯ netflix 配信終了」で表示を集めている面（docs/FUNNEL.md 4-1）。
 * **検索で当たっている先頭の言葉は変えず**、後ろに「カレンダー」を足して
 * 「netflix 配信終了 カレンダー」の語形にも当てる（docs/KEYWORDS.md 2-2）。
 *
 * ★ 終了予定を持たない社（Disney+）は「終了した」と過去形にする。
 *   中身が終了済みだけなのに「終了する作品」と名乗ると、未来の予定があるように読める。
 */
export function evergreenTitleBase(direction: CalendarDirection, service: string, label: string): string {
  if (direction === 'leaving') {
    return hasExpiring(service)
      ? `${label}で見放題配信が終了する作品一覧・カレンダー`
      : `${label}で見放題配信が終了した作品一覧・カレンダー`
  }
  // ★ 「最近」は入れない。いつ時点かは evergreenTitle() が後ろに付ける。
  return `${label}の見放題 新着・配信予定の作品一覧・カレンダー`
}

function contentsOf(direction: CalendarDirection, service: string): string {
  if (direction === 'arrivals') return '配信開始予定と新着'
  return hasExpiring(service) ? '配信終了予定と終了した作品' : '見放題が終了した作品'
}

function pageOf(direction: CalendarDirection, s: { key: string; label: string }): EvergreenPage {
  return {
    href: `/${direction}/${s.key}`,
    titleBase: evergreenTitleBase(direction, s.key, s.label),
    category: direction,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
    contents: contentsOf(direction, s.key),
  }
}

/** 常設ページ全部。**サービスの定義順**（紹介料で並べ替えない・events-data.ts の CALENDAR_SERVICES） */
export const EVERGREEN_PAGES: EvergreenPage[] = [
  ...CALENDAR_SERVICES.map((s) => pageOf('leaving', s)),
  ...CALENDAR_SERVICES.map((s) => pageOf('arrivals', s)),
]

/**
 * 左の枠のカード。**サービス1社につき1枚**（2026-09-17）。
 *
 * 行き先は `/leaving/<サービス>`。新着・配信予定へはページの上の切り替えで移る。
 * ★ 2026-09-07 に一度「サービス1枚」に畳んで戻した経緯がある（LeftRail.astro）。
 *   そのときはカードの外に「終了予定／新着」のリンクをぶら下げる必要があって見た目が悪かった。
 *   **いまは切り替えをページの中（CalendarPicker）が持つ**ので、カードにぶら下げるものが無い。
 */
export const CALENDAR_CARDS = CALENDAR_SERVICES.map((s) => pageOf('leaving', s))

/** 指定サービスの常設ページだけを返す。サービス別まとめページ（/service/…）で使う。 */
export function evergreenForService(service: string): EvergreenPage[] {
  return EVERGREEN_PAGES.filter((p) => p.thumbKey === service)
}

/**
 * ヘッダーのメニューなどで、ハブ×サービスを押したときの行き先。
 *
 * ★ **カレンダーのある社は、同じ向きのカレンダーへ直接送る**（2026-09-17）。
 *   `/category/<ハブ>/<サービス>` は転送してあるので、そこを指したままでも着くが、
 *   **転送を1回挟む内部リンクを残さない**（クロールの無駄・計測の参照元がずれる）。
 * ★ カレンダーの無い社（U-NEXT）は従来どおり記事の一覧へ。
 */
export function hubServiceHref(hub: string, service: string): string {
  if ((hub === 'leaving' || hub === 'arrivals') && hasCalendar(service)) return `/${hub}/${service}`
  return `/category/${hub}/${service}`
}

/** そのハブ×サービスが**記事一覧ではなくカレンダー**になっているか（生成の出し分けに使う） */
export function hubServiceIsCalendar(hub: string, service: string): boolean {
  return hubServiceHref(hub, service) !== `/category/${hub}/${service}`
}

// --- 鮮度の見せ方 -----------------------------------------------------------
//
// 常設ページは公開日を持たない。`collect` のたびに中身だけが入れ替わるので、
// 読者から見ると「いつの情報か分からないページ」になりやすい。
// そこで**基準日を必ず添える**。組み立てはこの2つの関数だけが行う
// （ページ・カードでずれると、同じページが別の日付を名乗ることになる）。

/**
 * 常設ページのタイトル。`Netflixで見放題配信が終了する作品一覧・カレンダー【9月1日更新】`
 *
 * `<title>` と `<h1>`、一覧カードの見出しはすべてこれを使う。
 * 基準日が取れないときだけ、日付なしのタイトルに落ちる。
 *
 * ■ 2026-09-06 に、日付を**頭から後ろへ移した**（docs/FUNNEL.md 4-1）
 * 変更前は `【2026年9月1日時点】Netflixで配信終了予定の作品一覧`。
 * スマホの検索結果は全角30文字前後で切れるので、頭に日付を置くと
 * サービス名も「終了」も後ろへ押し出されていた。
 *
 * ★ **「時点」ではなく「更新」。** 「時点」は情報の古さを、「更新」は手入れの新しさを名乗る。
 * ★ **年を落とす。** 常設ページの基準日は必ず直近の収集日で、年をまたいだ日付にはならない。
 */
export function evergreenTitle(titleBase: string, dataAsOf: Date | null): string {
  if (!dataAsOf) return titleBase
  const md = formatDate(dataAsOf).replace(/^\d+年/, '')
  return `${titleBase}【${md}更新】`
}

/**
 * 常設ページ1枚ぶんの中身。**ページとカードが同じものを読む。**
 *
 * ★ 基準日は2つの一覧のうち**新しいほう**。片方だけを見ると、
 *   片方が空のサービス（Disney+ の終了予定など）で日付が付かなくなる。
 */
export interface CalendarContent {
  /** これから（終了予定 / 配信開始予定）。**持たない社は null**（空配列と区別する） */
  future: ReturnType<typeof loadLeaving> | null
  /** 過去（終了済み / 新着） */
  past: ReturnType<typeof loadLeaving>
  dataAsOf: Date | null
}

const contents = new Map<string, CalendarContent>()

export function calendarContent(direction: CalendarDirection, service: string): CalendarContent {
  const key = `${direction}/${service}`
  const hit = contents.get(key)
  if (hit) return hit

  const future =
    direction === 'leaving' ? (hasExpiring(service) ? loadLeaving(service) : null) : loadUpcoming(service)
  const past = direction === 'leaving' ? loadEnded(service) : loadArrivals(service)
  const dates = [future?.dataAsOf, past.dataAsOf].filter((d): d is Date => Boolean(d))
  const out: CalendarContent = {
    future,
    past,
    dataAsOf: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
  }
  contents.set(key, out)
  return out
}

/** 常設ページ1枚ぶんの件数と基準日（カード用）。 */
export function evergreenSummary(page: EvergreenPage): { count: number; dataAsOf: Date | null } {
  const c = calendarContent(page.category, page.thumbKey)
  return { count: (c.future?.works.length ?? 0) + c.past.works.length, dataAsOf: c.dataAsOf }
}
