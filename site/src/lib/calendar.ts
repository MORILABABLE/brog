/**
 * カレンダーの升目を組み立てる。**ビルド時にだけ動く。**
 *
 * 常設ページ（`/leaving/<サービス>` `/arrivals/<サービス>`）の読者の用は**日付**にある
 * （「今月中に消えるのはどれか」「先月末に何が消えたか」「来週何が始まるか」）。
 * 一覧を上から読ませる代わりに、月の升目を先に見せて
 * 点いている日から本文へ飛ばすための下ごしらえをここでする。
 *
 * ■ 表示はここでは決めない
 * 升目の中身（色・文言・リンク先）は components/EventCalendar.astro が決める。
 * ここが返すのは**日付と種類ごとの件数と、その日に敷くポスター1枚だけ**。
 *
 * ■ 日付は必ず JST で切る
 * `at` は絶対時刻（ISO）なので、UTC のまま日を取ると9時間ぶん前日に落ちる。
 * 切り出しは utils/date.ts の `isoDate()` に通す。**ここで自前に切らないこと。**
 * （events-data.ts の `jstDay()` と同じ規則。表の日付見出しと升目がずれると
 *   リンク先の見出しが存在しなくなる ＝ カレンダーを押しても何も起きない）
 *
 * ■ 「きょう」はここで決めない（2026-09-17 に変えた）
 * ビルドは収集のたびに走る（週2回）ので、ビルド時の「きょう」は読者の「きょう」と
 * **最大で3〜4日ずれる。** 印は読者の画面側で付ける（EventCalendar.astro のスクリプト）。
 */
import { isoDate } from '../utils/date'
import type { WorkRow } from './events-data'

/**
 * 升目に出す種類。**1ページに出るのは2つだけ**（これからの1つと、過去の1つ）。
 *
 *   /leaving/<サービス>  … leaving（終了予定・これから）と ended（終了済み・過去）
 *   /arrivals/<サービス> … upcoming（配信開始予定・これから）と arrivals（新着・過去）
 */
export type CalendarKind = 'leaving' | 'ended' | 'arrivals' | 'upcoming'

/** 升目1つ。その月に属さないマス（前後の月の埋め草）は `null` で表す。 */
export interface CalendarDay {
  /** `2026-09-30`。**表の日付見出しの id の後ろ半分と同じ文字列**（WorkTable が `isoDate()` で出す） */
  iso: string
  /** 表示する数字（1〜31） */
  day: number
  /** 種類ごとの本数。0 の種類は入れない */
  counts: Partial<Record<CalendarKind, number>>
  /**
   * 升目に敷く作品のポスター（`/thumbs/<作品ID>.webp`）。**その日でいちばん評価の高い作品。**
   * ポスターのある作品が1本も無い日は undefined（升目は色のタイルになる）。
   */
  thumb?: string
}

export interface CalendarMonth {
  /** `2026-09` */
  key: string
  /** `2026年9月` */
  label: string
  /** 日曜始まりの7列 × 週の数 */
  weeks: (CalendarDay | null)[][]
  /** その月の種類ごとの合計。月見出しの脇に出す */
  sums: Partial<Record<CalendarKind, number>>
}

export interface CalendarData {
  months: CalendarMonth[]
  /** 点いている日が1つでもあるか。無ければカレンダーごと出さない */
  hasEvents: boolean
  /**
   * ビルド時点の今月（`2026-09`）。**読者の画面で最初に開く月の既定値。**
   * 読者の今月が描いた範囲にあれば、スクリプトがそちらに切り替える。
   */
  buildMonth: string
}

/**
 * 描く月数の上限。
 *
 * ★ 通常は3か月（前月・今月・翌月）にしかならない。
 *
 * 上限を置いてあるのは**壊れた日付への保険**。`at` に遠い未来が
 * 1件でも混じると、そこまでの空の月を延々と描いてしまう。
 * 後ろから落とすので、残る月は必ず連続する。
 */
const MAX_MONTHS = 6

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

/** `2026-09` の1つ前の月 */
function prevMonth(key: string): string {
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
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
 * 種類ごとの作品から、月ごとの升目を作る。
 *
 * ★ **渡すのは表に出しているのと同じ配列**にすること。
 *   別の絞り込みを掛けると、点いているのに飛び先が無い日ができる。
 * ★ 引数の並びに意味は無い。**どちらが先かで表示は変わらない。**
 *   掲載順を紹介料で動かさないという決まり（docs/AFFILIATE.md 7節）と同じで、
 *   ここが返す並びは暦の順に固定されている。
 */
export function buildCalendar(
  series: { kind: CalendarKind; works: WorkRow[] }[],
  /**
   * 作品のポスターを引く関数（2026-09-17 追加）。**渡したときだけ升目に絵が付く。**
   * ★ ジャンルの汎用画像は返さないこと。升目に同じ絵が並ぶだけで、その日の作品が伝わらない。
   */
  thumbOf?: (w: WorkRow) => string | undefined,
): CalendarData {
  const counts = new Map<string, Partial<Record<CalendarKind, number>>>()
  /** 日付 → いま選んでいるポスターと、その作品の評価 */
  const thumbs = new Map<string, { src: string; rating: number }>()
  for (const { kind, works } of series) {
    for (const w of works) {
      const iso = isoDate(w.at)
      const hit = counts.get(iso) ?? {}
      hit[kind] = (hit[kind] ?? 0) + 1
      counts.set(iso, hit)
      /*
       * ★ **評価のいちばん高い作品の絵**を使う。読者が「この日に何があるか」を
       *   1枚で思い浮かべられる作品を選ぶため。同点なら先に並んでいる作品（表の並び）。
       */
      const src = thumbOf?.(w)
      const rating = w.rating ?? 0
      const cur = thumbs.get(iso)
      if (src && (!cur || rating > cur.rating)) thumbs.set(iso, { src, rating })
    }
  }

  const buildMonth = monthOf(isoDate(new Date()))

  /*
   * 描く月の範囲。**前月から始めて、イベントのある最後の月まで。**
   *
   * ★ 2026-09-07 には「今月から先だけ」にしていた。当時の升目は全部の月を
   *   縦に並べていたので、過去の月が本文を画面2つぶん押し下げていたため。
   *   **いまは1か月ずつ切り替えて見せる**（EventCalendar.astro）ので、
   *   前月を持っても画面は伸びない。終了済み・新着（過去の記録）を
   *   升目で引けるように、前月から描く（2026-09-17）。
   * ★ 前月より前は描かない。表の側も前月からしか持っていない
   *   （events-data.ts の `calendarPastStart`。新着だけは直近60日ぶんを表に持つ）。
   * ★ 今月は**イベントが無くても必ず入れる。**
   *   外すと、読者が自分の現在地を見失う。
   */
  const start = prevMonth(buildMonth)
  const eventMonths = [...counts.keys()].map(monthOf).filter((m) => m >= start)
  const last = [buildMonth, ...eventMonths].sort().pop()!
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
    const sums: Partial<Record<CalendarKind, number>> = {}
    for (const d of days) {
      const c = counts.get(d.iso) ?? {}
      for (const [k, n] of Object.entries(c) as [CalendarKind, number][]) {
        sums[k] = (sums[k] ?? 0) + n
      }
      week.push({ iso: d.iso, day: d.day, counts: c, thumb: thumbs.get(d.iso)?.src })
      if (week.length === 7) {
        weeks.push(week)
        week = []
      }
    }
    if (week.length > 0) weeks.push([...week, ...Array(7 - week.length).fill(null)])
    return { key: monthKey, label: formatMonthKey(monthKey), weeks, sums }
  })

  /*
   * ★ 点いている日が**描いた範囲の中に**あるか。`counts.size > 0` で見ないこと。
   *   範囲より前にしかイベントが無いとき、全部のマスが消灯した空の升目を出してしまう。
   */
  const hasEvents = months.some((m) => Object.keys(m.sums).length > 0)
  return { months, hasEvents, buildMonth }
}
