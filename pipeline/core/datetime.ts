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
