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
 * 記事が初めて読者に届いた日。書き直した記事は `firstPubDate`、それ以外は `pubDate`。
 *
 * ★ **「新着」はこの日で決める**（2026-09-25・運用者の指定）。トップの「最新記事」、
 *   右の枠の「最新記事」、NEW の帯の3つ。
 *   `pubDate` は `--apply` が書き直しのたびに振り直す（実測: transformers は 8月31日 → 9月23日）ので、
 *   それで並べると**書き直しただけの記事が新しく書いた記事より上に出る。**
 * ★ カテゴリ・月別まとめ・サービス別などの一覧は `pubDate`（最後に書いた順）のまま。
 */
export function firstPublished(data: { pubDate: Date; firstPubDate?: Date }): Date {
  return data.firstPubDate ?? data.pubDate
}

/**
 * 記事を最後に直した日。`pubDate`（最後に書き出した日）と `updatedDate`（手で直した日）の新しいほう。
 *
 * ★ 記事ページの「更新」と構造化データの `dateModified` に使う（2026-09-25）。
 *   `updatedDate` は `--apply` で書き直すと消えるので、それだけを見ると書き直した日が漏れる。
 */
export function lastModified(data: { pubDate: Date; updatedDate?: Date }): Date {
  return data.updatedDate && data.updatedDate > data.pubDate ? data.updatedDate : data.pubDate
}

/** 初回公開日の新しい順に並べるときの比較関数 */
export function byFirstPublishedDesc(
  a: { data: { pubDate: Date; firstPubDate?: Date } },
  b: { data: { pubDate: Date; firstPubDate?: Date } },
): number {
  return firstPublished(b.data).valueOf() - firstPublished(a.data).valueOf()
}

/**
 * 初回公開から `NEW_DAYS` 以内か。記事カードのリボンの出し分けに使う。
 *
 * ★ **渡すのは `firstPublished()` の値。** 書き直した記事には NEW を付けない
 *   （2026-09-25 まではそれも付いていた。`pubDate` だけを見ていたため）。
 *
 * ★ **日付だけで比べる**（時刻を持ち込まない）。frontmatter の `pubDate` は
 *   日付だけなので JST の 00:00 として読まれる。ビルドが UTC で走る都合と合わせて
 *   `isoDate` に寄せておかないと、日本時間の朝に1日ずれる。
 *
 * ★ ビルド時に決まる値なので、**ビルドが走らない日は古い印が残る**。
 *   収集・retire・画像の各ワークフローがほぼ毎日 push するので実用上は追随するが、
 *   「NEW が消えない」ときはビルドが止まっていないかを先に疑うこと。
 */
export function isNew(published: Date, now: Date = new Date()): boolean {
  const day = 24 * 60 * 60 * 1000
  const from = Date.parse(isoDate(published))
  const today = Date.parse(isoDate(now))
  if (Number.isNaN(from) || Number.isNaN(today)) return false
  const elapsed = Math.round((today - from) / day)
  // 未来日の記事（予約投稿）も NEW 扱いにする。0 未満で落とさない
  return elapsed < NEW_DAYS
}
