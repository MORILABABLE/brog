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
import { formatDate, isoDate } from '../utils/date'
import type { CalendarKind } from './calendar'
import type { WorkRow } from './events-data'
import { isPosterThumb, workLinkById } from './work-links'
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
 * ■ 2026-09-19 に「カレンダー」を名前の芯にした（運用者の指定）
 *   変更前 `Netflixで見放題配信が終了する作品一覧・カレンダー`
 *   変更後 `Netflix 見放題・配信終了カレンダー`
 *
 * ページの中身が「日付をめくって、その日の作品を見る」形になり
 * （components/ServiceCalendarPage.astro の日付めくり）、**一覧ではなくカレンダーそのもの**に
 * なったため。ページの中にあった h2「配信カレンダー」は、この見出しと重複するので外した。
 *
 * ★ **サービス名・「見放題」・「配信終了」は必ず残すこと。**
 *   `/leaving/netflix` は「◯◯ netflix 配信終了」で表示を集めている面（docs/FUNNEL.md 4-1）で、
 *   この3語が当たっている本体。短くしたぶん「作品一覧」が落ちているので、
 *   **これ以上削らない。**
 * ★ 終了予定を持たない社（Disney+）も同じ名前にする。
 *   「終了する／終了した」の言い分けはこの形には無く、
 *   未来と過去の区別は**日付めくりの日付そのもの**が担う。
 */
export function evergreenTitleBase(direction: CalendarDirection, _service: string, label: string): string {
  // ★ 「最近」は入れない。いつ時点かは evergreenTitle() が後ろに付ける。
  return direction === 'leaving'
    ? `${label} 見放題・配信終了カレンダー`
    : `${label} 見放題・新着配信カレンダー`
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
 * ヘッダーのメニューなどで、ハブ×サービスを押したときの行き先。**必ず記事の一覧。**
 *
 * ■ 2026-09-18 に全社を記事の一覧へ戻した（運用者の指定）
 * 前日（2026-09-17）だけ、カレンダーのある社を `/leaving/<サービス>` へ直接送っていた。
 * **メニューの2つのハブ（配信終了済み・予定／新着配信）は過去記事の一覧の入口**で、
 * カレンダーへの入口は左の枠（LeftRail）とトップのカード（TopCalendar）が別に持っている。
 * 入口の名前と行き先が食い違うので、サービスによる出し分けをやめた。
 *
 * ★ カレンダーへは、一覧の先頭に出る常設カード（EvergreenCard）から1手で入れる。
 *   **メニュー → 一覧 → カレンダー**の道は切れていない。
 * ★ 行き先を1つに固定したので、`public/_redirects` に
 *   `/category/<ハブ>/<サービス>` の転送を書かないこと（ページを生成している）。
 */
export function hubServiceHref(hub: string, service: string): string {
  return `/category/${hub}/${service}`
}

/**
 * そのハブ×サービスに、**同じ向きの配信カレンダーがあるか**。
 *
 * ★ 使い道は**索引の出し分けだけ**（pages/category/[category]/[service].astro）。
 *   true のページは記事があっても `noindex` にする。カレンダー
 *   （`/leaving/<サービス>`）と同じ検索語で表示を分け合っていたため
 *   （2026-09-17 の実測。読者の道は残し、検索の受け皿はカレンダー側に寄せる）。
 * ★ **行き先の出し分けには使わない。** 上の `hubServiceHref` の★。
 */
export function hubServiceHasCalendar(hub: string, service: string): boolean {
  return (hub === 'leaving' || hub === 'arrivals') && hasCalendar(service)
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

// --- 升目とポスター（ページ・トップ・カードで共有）--------------------------------

/**
 * 作品のポスター（`/thumbs/<作品ID>.webp`・96×144）を引く関数。**表の行のサムネイルと同じもの**
 * （components/WorkTable.astro の `primary`）。
 * ★ ジャンルの汎用画像は返さない（`isPosterThumb`）。升目やカードに同じ絵が並ぶだけになる。
 */
export function posterOf(service: string): (w: WorkRow) => string | undefined {
  return (w) => {
    const thumb = workLinkById(w.workId, service)?.thumb
    return isPosterThumb(thumb) ? thumb : undefined
  }
}

/**
 * 升目に載せる種類と作品。**種類の名前がそのまま行き先の頭になる**（`leaving` → `#leaving-2026-09-30`）。
 * 並びは「これから → 過去」（ページの表の並びと同じ）。
 */
export function calendarSeries(
  direction: CalendarDirection,
  service: string,
): { kind: CalendarKind; works: WorkRow[] }[] {
  const c = calendarContent(direction, service)
  return direction === 'leaving'
    ? [
        { kind: 'leaving', works: c.future?.works ?? [] },
        { kind: 'ended', works: c.past.works },
      ]
    : [
        { kind: 'upcoming', works: c.future?.works ?? [] },
        { kind: 'arrivals', works: c.past.works },
      ]
}

/**
 * 配信カレンダーのカードに出す絵（2026-09-17 追加・運用者の指定）。
 *
 * 🔴 **いまどこからも呼んでいない**（2026-09-20・運用者の指定）。
 *   カードの絵は `src/assets/services/<キー>.png`（カレンダーの升目にサービス名を
 *   組んだ自作の絵）に固定した。**作品のポスターはカードに出さない。**
 *   やめた理由は `components/CalendarCards.astro` に書いてある（要点は、
 *   ポスターは提供元も許諾を出せず、ここでは1作品がサービス全体を代表する
 *   飾りになるので引用としての筋が立たないこと）。
 *   ★ 戻すときのために**関数は残してある。** 使わないなら消してよいが、
 *     消すときは上の3つのカード（CalendarCards / TopCalendar / EvergreenCard）を見ること。
 *
 * ■ 何を選ぶか
 * そのカレンダーの**今月**の作品を、日付の早い順（同じ日は評価の高い順）に並べ、
 * **アニメ**の中で最初にポスターのある作品。アニメが1本も無ければ（ポスターが無ければ）全ジャンルから同じ順で選ぶ。
 * どれも無ければ undefined（カードは従来の汎用画像 `src/assets/services/<キー>` に戻る）。
 *
 * ★ アニメを先に見るのは**見栄えのため**（運用者の判断）。アニメのポスターは小さく切り抜いても絵が読める。
 * ★ 収集のたびに変わる。月が替わると、翌月の最初の作品に移る。
 * ★ 小さいサムネイル（96×144）を使う。左の枠は**全ページに出る**ので、大きいポスター（480×720・約37KB）は使わない。
 */
export function calendarThumb(direction: CalendarDirection, service: string): string | undefined {
  const month = isoDate(new Date()).slice(0, 7)
  const poster = posterOf(service)
  const rows = calendarSeries(direction, service)
    .flatMap((s) => s.works)
    .filter((w) => isoDate(w.at).slice(0, 7) === month)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (b.rating ?? 0) - (a.rating ?? 0))
  const pick = (list: WorkRow[]) => list.map(poster).find((t): t is string => Boolean(t))
  return pick(rows.filter((w) => w.genre === 'anime')) ?? pick(rows)
}
