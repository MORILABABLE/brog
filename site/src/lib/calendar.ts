/**
 * カレンダーの升目を組み立てる。**ビルド時にだけ動く。**
 *
 * 常設ページは「終了予定」と「新着」で別々の一覧を出しているが、
 * 読者の用は**日付**にある（「今月中に消えるのはどれか」）。
 * 一覧を上から読ませる代わりに、月の升目を先に見せて
 * 点いている日から本文へ飛ばすための下ごしらえをここでする。
 *
 * ■ 表示はここでは決めない
 * 升目の中身（色・文言・リンク先）は components/EventCalendar.astro が決める。
 * ここが返すのは**日付と件数だけ**。
 *
 * ■ 日付は必ず JST で切る
 * `at` は絶対時刻（ISO）なので、UTC のまま日を取ると9時間ぶん前日に落ちる。
 * 切り出しは utils/date.ts の `isoDate()` に通す。**ここで自前に切らないこと。**
 * （events-data.ts の `jstDay()` と同じ規則。表の日付見出しと升目がずれると
 *   リンク先の見出しが存在しなくなる ＝ カレンダーを押しても何も起きない）
 */
import { isoDate } from '../utils/date'
import type { WorkRow } from './events-data'

/** 升目1つ。その月に属さないマス（前後の月の埋め草）は `null` で表す。 */
export interface CalendarDay {
  /** `2026-09-30`。**表の日付見出しの id と同じ文字列**（WorkTable が `isoDate()` で出す） */
  iso: string
  /** 表示する数字（1〜31） */
  day: number
  /** その日に見放題が終了する本数 */
  leaving: number
  /** その日に見放題へ入った本数 */
  arrivals: number
  /** きょう（JST）。升目に印を出すために持つ */
  isToday: boolean
}

export interface CalendarMonth {
  /** `2026-09` */
  key: string
  /** `2026年9月` */
  label: string
  /** 日曜始まりの7列 × 週の数 */
  weeks: (CalendarDay | null)[][]
  /** その月の合計。月見出しの脇に出す */
  leaving: number
  arrivals: number
}

export interface CalendarData {
  months: CalendarMonth[]
  /** 点いている日が1つでもあるか。無ければカレンダーごと出さない */
  hasEvents: boolean
}

/**
 * 描く月数の上限。
 *
 * ★ 通常は1〜2か月にしかならない（下の「今月より前は描かない」のため）。
 *
 * 上限を置いてあるのは**壊れた日付への保険**。`at` に遠い未来が
 * 1件でも混じると、そこまでの空の月を延々と描いてしまう。
 * 後ろから落とすので、残る月は必ず連続する。
 */
const MAX_MONTHS = 12

/** `2026-09-30` → `2026-09` */
function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

/** `2026-09` → `2026年9月` */
export function formatMonthKey(key: string): string {
  const [y, m] = key.split('-')
  return `${y}年${Number(m)}月`
}

/** `2026-09` の1つ後の月 */
function nextMonth(key: string): string {
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7))
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * 月の升目を組む。**UTC の日付演算だけで作る。**
 *
 * ローカル系のゲッター（`getDate` / `getDay`）はビルド機のタイムゾーンで
 * 答えが変わる。Cloudflare Pages は UTC、手元は JST なので、
 * 使うと**手元と本番でカレンダーの曜日がずれる。**
 * ここで扱うのは「2026年9月1日」という暦の値であって時刻ではないので、
 * `Date.UTC` に載せて UTC のまま読むのが正しい。
 */
function daysOfMonth(key: string): { iso: string; day: number; weekday: number }[] {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  // 翌月の0日 ＝ 今月の末日
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const out: { iso: string; day: number; weekday: number }[] = []
  for (let day = 1; day <= last; day++) {
    out.push({
      iso: `${key}-${String(day).padStart(2, '0')}`,
      day,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    })
  }
  return out
}

/**
 * 終了予定と新着から、月ごとの升目を作る。
 *
 * @param leaving  これから終了する作品（`loadLeaving()` の戻り）
 * @param arrivals 最近見放題に入った作品（`loadArrivals()` の戻り）
 *
 * ★ 引数の並びに意味は無い。**どちらが先かで表示は変わらない。**
 *   掲載順を紹介料で動かさないという決まり（docs/AFFILIATE.md 7節）と同じで、
 *   ここが返す並びは暦の順に固定されている。
 */
export function buildCalendar(leaving: WorkRow[], arrivals: WorkRow[]): CalendarData {
  const counts = new Map<string, { leaving: number; arrivals: number }>()
  const bump = (iso: string, kind: 'leaving' | 'arrivals') => {
    const hit = counts.get(iso) ?? { leaving: 0, arrivals: 0 }
    hit[kind] += 1
    counts.set(iso, hit)
  }
  for (const w of leaving) bump(isoDate(w.at), 'leaving')
  for (const w of arrivals) bump(isoDate(w.at), 'arrivals')

  const today = isoDate(new Date())

  /*
   * 描く月の範囲。**今月から始めて、イベントのある最後の月まで。**
   *
   * ★ **今月より前の月は描かない**（2026-09-07 の判断）。
   *   読者がこのページに来る用は「**今月**のいつ始まって、いつ終わるのか」で、
   *   「7月のいつ見放題に入ったか」を確かめに来る人はいない。
   *   新着は直近60日ぶん持っている（events-data.ts の `ARRIVALS_WINDOW_DAYS`）ので、
   *   素直に全部描くと**過去2か月ぶんの升目が本文を画面2つぶん押し下げる。**
   *   過去の作品が一覧から消えるわけではない（表には従来どおり全部並ぶ）。
   *   升目を今月から始めるだけ。
   *
   * ★ 今月は**イベントが無くても必ず入れる。**
   *   外すと、終了予定が来月にしか無い時期にカレンダーから「きょう」が消え、
   *   読者が自分の現在地を見失う。
   */
  const start = monthOf(today)
  const eventMonths = [...counts.keys()].map(monthOf).filter((m) => m >= start)
  const last = eventMonths.length > 0 ? eventMonths.sort().pop()! : start
  let key = start
  const range: string[] = []
  // 連続させる（イベントの無い月も升目としては描く。日付の距離感が消えるため）
  while (key <= last && range.length < MAX_MONTHS) {
    range.push(key)
    key = nextMonth(key)
  }

  const months: CalendarMonth[] = range.map((monthKey) => {
    const days = daysOfMonth(monthKey)
    const weeks: (CalendarDay | null)[][] = []
    // 1日の曜日ぶんだけ空のマスで押し出す（日曜始まり）
    let week: (CalendarDay | null)[] = Array(days[0]!.weekday).fill(null)
    let leavingSum = 0
    let arrivalsSum = 0
    for (const d of days) {
      const c = counts.get(d.iso) ?? { leaving: 0, arrivals: 0 }
      leavingSum += c.leaving
      arrivalsSum += c.arrivals
      week.push({ iso: d.iso, day: d.day, ...c, isToday: d.iso === today })
      if (week.length === 7) {
        weeks.push(week)
        week = []
      }
    }
    if (week.length > 0) weeks.push([...week, ...Array(7 - week.length).fill(null)])
    return {
      key: monthKey,
      label: formatMonthKey(monthKey),
      weeks,
      leaving: leavingSum,
      arrivals: arrivalsSum,
    }
  })

  /*
   * ★ 点いている日が**描いた範囲の中に**あるか。`counts.size > 0` で見ないこと。
   *   今月より前しかイベントが無いとき（例: 新着が先月で止まっているサービス）、
   *   全部のマスが消灯した空の升目を出してしまう。
   */
  const hasEvents = months.some((m) => m.leaving > 0 || m.arrivals > 0)
  return { months, hasEvents }
}
