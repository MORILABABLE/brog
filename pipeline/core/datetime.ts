/**
 * 日付の整形。
 *
 * ■ なぜ専用モジュールにするか
 * 開発機は JST、GitHub Actions は UTC で動く。
 * Date の getMonth() / getDate() は実行環境のローカル時刻を返すため、
 * 環境によって日付が1日ずれる。配信終了日を1日間違える記事は
 * それだけで信用を失うので、ここに閉じ込めて必ず経由させる。
 *
 * 実装方針: UTCのタイムスタンプにオフセットを足し、**UTCのゲッターで読む**。
 * これで実行環境のタイムゾーンに一切依存しない。
 */

/** 日本標準時のUTCオフセット（分） */
export const JST_OFFSET_MINUTES = 9 * 60

/** オフセットを適用した「見かけ上のUTC」Date を返す。UTC系ゲッターでのみ読むこと。 */
function shifted(iso: string, offsetMinutes: number): Date {
  return new Date(new Date(iso).getTime() + offsetMinutes * 60_000)
}

/** 「8月3日」形式 */
export function formatMonthDay(iso: string, offsetMinutes = JST_OFFSET_MINUTES): string {
  const d = shifted(iso, offsetMinutes)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 「2026年8月3日」形式 */
export function formatFullDate(iso: string, offsetMinutes = JST_OFFSET_MINUTES): string {
  const d = shifted(iso, offsetMinutes)
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 「2026-08-03」形式。frontmatter やスラッグ用。 */
export function formatIsoDate(iso: string, offsetMinutes = JST_OFFSET_MINUTES): string {
  return shifted(iso, offsetMinutes).toISOString().slice(0, 10)
}

/** 現在時刻を指定オフセットで見た YYYY-MM */
export function currentYearMonth(offsetMinutes = JST_OFFSET_MINUTES): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 7)
}

/**
 * `YYYY-MM` の前月。
 *
 * 月をまたいで宙に浮いた素材（月末に始まり、翌月に収集されたもの）を
 * 探すのに使う。Date に通さず文字列で数えるのは、ここでも実行環境の
 * タイムゾーンに触れないため。
 */
export function previousYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/**
 * 「あと何日か」を返す。過去なら負。
 *
 * 時刻の差ではなく**基準タイムゾーンの日付の差**で数える。
 * 「今日の23時に終了」は残り0日であって、23時間ではない。
 * 通知で「あと1日」と出てから当日中に消えるのを避けるための丸め方。
 */
export function daysUntil(
  iso: string,
  offsetMinutes = JST_OFFSET_MINUTES,
  now: Date = new Date(),
): number {
  const target = shifted(iso, offsetMinutes)
  const base = new Date(now.getTime() + offsetMinutes * 60_000)
  const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.round((dayOf(target) - dayOf(base)) / 86_400_000)
}
