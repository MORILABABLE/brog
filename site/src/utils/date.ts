/**
 * 日付整形。
 *
 * ビルドは Cloudflare Pages（UTC）で走るため、ローカル系ゲッターを使うと
 * 日付が1日ずれる。必ずここを経由する。パイプライン側の
 * pipeline/core/datetime.ts と同じ方針。
 */

const JST_OFFSET_MINUTES = 9 * 60

function shifted(d: Date): Date {
  return new Date(d.getTime() + JST_OFFSET_MINUTES * 60_000)
}

/** 2026年8月1日 */
export function formatDate(d: Date): string {
  const s = shifted(d)
  return `${s.getUTCFullYear()}年${s.getUTCMonth() + 1}月${s.getUTCDate()}日`
}

/** 2026-08-01（<time datetime> 用） */
export function isoDate(d: Date): string {
  return shifted(d).toISOString().slice(0, 10)
}
