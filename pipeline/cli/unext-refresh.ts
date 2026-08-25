/**
 * 作品台帳（data/unext-titles.json）の情報を取り直す。
 *
 *   npm run unext:refresh                  古くなったものだけ取り直す
 *   npm run unext:refresh -- --all         全件
 *   npm run unext:refresh -- --max 100     開く作品ページの上限（既定 200）
 *   npm run unext:refresh -- --dry-run     対象を数えるだけ
 *
 * ■ なぜ収集と分けるか
 * collect:unext は「変化を見つける」ためのもので、既に知っている作品は
 * わざと素通りする（作品ページを開き直さないための設計）。
 * その結果、**一度記録した作品の情報は放っておくと古くなる。**
 *
 * 配信終了日は変わる。延びることも、前倒しになることもある。
 * 「8月31日まで」と書いた記事の作品が9月末まで延びていたら、
 * その記事は間違ったまま公開され続ける。それを見つけるのがこのコマンド。
 *
 * ■ 何を古いとみなすか
 *   - 作品ページを一度も開いていない（配信開始日も終了日も持っていない）
 *   - 話数を持っていない（映画かシリーズかの判定が推定のまま）
 *   - 終了日が近い（動きやすいので確かめ直す）
 *   - 最後に確認してから --days 日以上たっている
 */
import { loadTheme } from '../theme.ts'
import { BackoffError, PoliteBrowser } from '../sources/browser.ts'
import { UnextSource, DEFAULT_MAX_DETAIL_VIEWS, type UnextConfig } from '../sources/unext.ts'
import {
  DETAIL_OWNED_FIELDS,
  loadStore,
  saveStore,
  upsert,
  type UnextTitleRecord,
} from '../sources/unext-store.ts'
import { daysUntil, formatFullDate } from '../core/datetime.ts'

/** 最後の確認からこれだけたっていたら取り直す */
const DEFAULT_STALE_DAYS = 14
/** 終了日がこれだけ先までに迫っていたら、古さに関わらず取り直す */
const NEAR_END_DAYS = 60
/**
 * 鮮度のための取り直しは、最後に確認してからこれだけ空ける。
 *
 * 「終了日が近い」作品は毎回そこそこの数になる（実測153件）。
 * この下限が無いと、同じ日に2回流しただけで同じ150件を開き直すことになり、
 * **相手のサーバーに意味のない負荷をかける。**
 * 情報が欠けている作品（作品ページ未取得・話数なし）はこの制限を受けない。
 */
const MIN_RECHECK_HOURS = 12

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 取り直す理由。1件も無い日にログが空にならないよう、理由別に数える。 */
function reasonToRefresh(
  r: UnextTitleRecord,
  now: number,
  staleDays: number,
  offset: number,
): string | undefined {
  // 情報が欠けているものは、いつ確認したかに関わらず取りに行く
  if (!r.detailCheckedAt) return '作品ページ未取得'
  if (r.episodeCount === undefined) return '話数なし（種別が推定のまま）'

  // ここから下は「古いかもしれない」ための取り直しなので、下限を設ける
  const ageHours = (now - new Date(r.detailCheckedAt).getTime()) / 3_600_000
  if (ageHours < MIN_RECHECK_HOURS) return undefined

  if (r.publicEndDate) {
    const left = daysUntil(r.publicEndDate, offset, new Date(now))
    if (left >= 0 && left <= NEAR_END_DAYS) return '終了日が近い'
  }
  if (ageHours / 24 >= staleDays) return `${Math.floor(ageHours / 24)}日前の情報`
  return undefined
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const all = process.argv.includes('--all')
  const max = Number(arg('max') ?? DEFAULT_MAX_DETAIL_VIEWS)
  const staleDays = Number(arg('days') ?? DEFAULT_STALE_DAYS)

  const theme = await loadTheme()
  if (!theme.unext) throw new Error(`テーマ ${theme.key} に unext の設定がありません`)

  const store = await loadStore()
  const records = Object.values(store.titles)
  const now = Date.now()

  const targets: { rec: UnextTitleRecord; reason: string }[] = []
  const byReason = new Map<string, number>()
  for (const rec of records) {
    const reason = all
      ? '--all'
      : reasonToRefresh(rec, now, staleDays, theme.utc_offset_minutes)
    if (!reason) continue
    const bucket = reason.replace(/^\d+日前の情報$/, `${staleDays}日以上前の情報`)
    byReason.set(bucket, (byReason.get(bucket) ?? 0) + 1)
    targets.push({ rec, reason })
  }

  // 終了日が近いものから直す。記事に出ている可能性が高く、間違いの害も大きい。
  targets.sort((a, b) => (a.rec.publicEndDate ?? '9999').localeCompare(b.rec.publicEndDate ?? '9999'))

  console.log(`作品台帳 ${records.length}件 / 取り直す対象 ${targets.length}件`)
  for (const [r, n] of [...byReason].sort()) console.log(`  ${r.padEnd(26)} ${String(n).padStart(4)}件`)
  if (targets.length > max) console.log(`  → 上限 ${max}件まで（残りは次回）`)

  if (dryRun || targets.length === 0) {
    console.log(dryRun ? '\n※ --dry-run: 何も取得していません' : '\n取り直すものはありません')
    return
  }

  const cfg: UnextConfig = { ...theme.unext, max_detail_views: max }
  const browser = new PoliteBrowser({
    minIntervalMs: cfg.min_interval_ms,
    maxPageViews: max + 10,
  })
  const source = new UnextSource(cfg, browser)

  const changes: { title: string; from?: string; to?: string; note: string }[] = []

  let failed = 0

  try {
    for (const { rec } of targets.slice(0, max)) {
      let detail
      try {
        detail = await source.fetchDetail(rec.id)
      } catch (err) {
        // 相手が止めろと言っているなら全体を止める。
        // それ以外（一時的な回線断など）は1件諦めて進む。
        // ここで throw すると、それまでに直した数百件を道連れにしてしまう。
        if (err instanceof BackoffError) throw err
        failed++
        console.warn(`  取得できませんでした: ${rec.title} (${rec.id})`)
        continue
      }
      if (!detail) break

      const before = rec.publicEndDate
      const type = detail.episodeCount
        ? detail.episodeCount > 1
          ? 'series'
          : 'movie'
        : rec.type

      upsert(store, {
        ...rec,
        type,
        year: detail.productionYear ?? rec.year,
        seriesName: detail.seriesName ?? rec.seriesName,
        country: detail.country ?? rec.country,
        publicStartDate: detail.publicStartDate ?? rec.publicStartDate,
        publicEndDate: detail.publicEndDate,
        publicEndText: detail.publicEndText,
        episodeCount: detail.episodeCount ?? rec.episodeCount,
        detailCheckedAt: new Date().toISOString(),
        seenAt: rec.lastSeenAt,
        // 終了日が取り下げられた（無期限になった）ケースを反映する。
        // 古い日付を残すほうが有害なので、ここでは undefined での上書きを許す。
      }, DETAIL_OWNED_FIELDS)

      if (before !== detail.publicEndDate) {
        changes.push({
          title: rec.title,
          from: before,
          to: detail.publicEndDate,
          note: !before ? '新たに判明' : !detail.publicEndDate ? '終了日が消えた' : '変更',
        })
      }
    }
  } finally {
    await browser.close()
    if (!dryRun) await saveStore(store)
  }

  if (changes.length) {
    console.log('\n--- 配信終了日が動いた作品 ---')
    for (const c of changes) {
      const f = c.from ? formatFullDate(c.from, theme.utc_offset_minutes) : '（なし）'
      const t = c.to ? formatFullDate(c.to, theme.utc_offset_minutes) : '（なし）'
      console.log(`  [${c.note}] ${c.title}: ${f} → ${t}`)
    }
    console.log('  ※ すでに記事にしている作品なら、記事側の訂正が要ります')
  } else {
    console.log('\n終了日の変更はありませんでした')
  }

  console.log(`\n開いた作品ページ: ${source.detailViews}`)
  if (failed) {
    console.log(`取得できなかった作品: ${failed}件（もう一度実行すれば拾い直せます）`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
