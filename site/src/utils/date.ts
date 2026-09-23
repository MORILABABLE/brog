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

/**
 * 「NEW」を出す日数（2026-09-24 追加・運用者の指定）。
 *
 * **3日**。当日を1日目と数えるので、9月23日の記事は9月25日まで NEW になる。
 */
export const NEW_DAYS = 3

/**
 * 公開（または書き直し）から `NEW_DAYS` 以内か。記事カードのリボンの出し分けに使う。
 *
 * ★ **見ているのは `pubDate` だけ。** `--apply` は書き直しのたびに `pubDate` を
 *   その日に振り直す（実測: transformers は 9月6日 → 9月23日）。
 *   だから新しく書いた記事も、事実が変わって書き直した記事も、同じ1本の条件で拾える。
 *   `updatedDate` は月次記事の書き直しでも付かないので使わない。
 *
 * ★ **日付だけで比べる**（時刻を持ち込まない）。frontmatter の `pubDate` は
 *   日付だけなので JST の 00:00 として読まれる。ビルドが UTC で走る都合と合わせて
 *   `isoDate` に寄せておかないと、日本時間の朝に1日ずれる。
 *
 * ★ ビルド時に決まる値なので、**ビルドが走らない日は古い印が残る**。
 *   収集・retire・画像の各ワークフローがほぼ毎日 push するので実用上は追随するが、
 *   「NEW が消えない」ときはビルドが止まっていないかを先に疑うこと。
 */
export function isNew(pubDate: Date, now: Date = new Date()): boolean {
  const day = 24 * 60 * 60 * 1000
  const from = Date.parse(isoDate(pubDate))
  const today = Date.parse(isoDate(now))
  if (Number.isNaN(from) || Number.isNaN(today)) return false
  const elapsed = Math.round((today - from) / day)
  // 未来日の記事（予約投稿）も NEW 扱いにする。0 未満で落とさない
  return elapsed < NEW_DAYS
}
