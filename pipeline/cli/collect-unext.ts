/**
 * U-NEXT の新着・配信終了予定を収集する。
 *
 *   npm run collect:unext
 *   npm run collect:unext -- --kinds expiring
 *   npm run collect:unext -- --genres anime,youga --pages 1
 *   npm run collect:unext -- --dry-run            台帳もログも書かずに結果だけ見る
 *
 * ■ collect（Streaming Availability API）と何が違うか
 * 別コマンドに分けているのは、性質がまったく違うため。
 *
 *   collect        HTTP API。無料枠500req/月が制約。数秒で終わる
 *   collect:unext  実ブラウザ。枠は無いが**時間**と**相手の負荷**が制約。数分〜数十分
 *
 * 同じコマンドに混ぜると、APIの枠だけ見ていたつもりが
 * 数十分ブラウザを回す羽目になる。止めどきの判断も別物なので分けてある。
 *
 * ■ 期間指定が無い理由
 * U-NEXT に「いつ何が変わったか」を返す仕組みは無い。毎回いまの一覧を読み、
 * **台帳(data/ledger.json)との差分**を「前回以降の変化」とみなす。
 * したがって --days に相当するものは無い。頻度が期間を決める。
 */
import { loadTheme } from '../theme.ts'
import { PoliteBrowser } from '../sources/browser.ts'
import { UnextSource, DEFAULT_MAX_DETAIL_VIEWS, type UnextConfig } from '../sources/unext.ts'
import type { ChangeEvent, ChangeKind } from '../sources/types.ts'
import { loadStore, saveStore, UNEXT_STORE_PATH } from '../sources/unext-store.ts'
import { appendEvents, dedupe, eventKey, loadLedger, saveLedger } from '../core/events.ts'
import { daysUntil, formatFullDate } from '../core/datetime.ts'

const VALID_KINDS: ChangeKind[] = ['new', 'expiring']

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function num(name: string): number | undefined {
  const v = arg(name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} には0以上の数を指定してください`)
  return n
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const theme = await loadTheme()

  if (!theme.unext) {
    throw new Error(
      `テーマ ${theme.key} に unext の設定がありません` +
        '（theme.yaml の unext 節。`npm run unext:menu` でIDを調べられます）',
    )
  }

  const kinds = (arg('kinds')?.split(',') ?? ['new', 'expiring']) as ChangeKind[]
  const invalid = kinds.filter((k) => !VALID_KINDS.includes(k))
  if (invalid.length) {
    throw new Error(
      `不正な kind: ${invalid.join(', ')}（U-NEXTで有効なのは ${VALID_KINDS.join(', ')}）\n` +
        'removed（配信終了済み）は取りません。全カタログの棚卸しが必要で重すぎる一方、' +
        'expiring が取れるので事後まとめを書く理由がないためです。',
    )
  }

  // 設定を CLI で上書きできるようにする。ジャンルを絞れると試し打ちが速い。
  const only = arg('genres')?.split(',')
  const genres = only
    ? theme.unext.genres.filter((g) => only.includes(g.key))
    : theme.unext.genres
  if (genres.length === 0) {
    throw new Error(
      `--genres に一致するジャンルがありません。有効: ${theme.unext.genres.map((g) => g.key).join(', ')}`,
    )
  }

  const pages = num('pages')
  const cfg: UnextConfig = {
    ...theme.unext,
    genres,
    arrivals_pages: pages ?? theme.unext.arrivals_pages,
    expiring_pages: pages ?? theme.unext.expiring_pages,
    expiring_horizon_days: num('horizon') ?? theme.unext.expiring_horizon_days,
    max_detail_views: num('max-detail') ?? theme.unext.max_detail_views ?? DEFAULT_MAX_DETAIL_VIEWS,
  }

  const browser = new PoliteBrowser({
    minIntervalMs: cfg.min_interval_ms,
    // 一覧 + 作品ページ の合計。作品ページ側は max_detail_views で別に絞る。
    maxPageViews: genres.length * (cfg.arrivals_pages + cfg.expiring_pages) + cfg.max_detail_views! + 50,
  })
  const source = new UnextSource(cfg, browser)

  console.log(`テーマ: ${theme.label} (${theme.key})`)
  console.log(`対象: ${cfg.label} / ${kinds.join(', ')} / ${genres.length}ジャンル`)
  console.log(
    `設定: 新着${cfg.arrivals_pages}ページ  終了予定${cfg.expiring_pages}ページ・${cfg.expiring_horizon_days}日先まで  ` +
      `作品ページ上限${cfg.max_detail_views}  間隔${cfg.min_interval_ms}ms`,
  )
  console.log(dryRun ? '※ --dry-run: 台帳もイベントログも書きません\n' : '')

  // 作品台帳を先に読む。既に記録済みの作品は作品ページを開き直さずに済む。
  const ledger = await loadLedger()
  const store = await loadStore()
  source.useStore(store, ledger.seen)
  console.log(`作品台帳: ${Object.keys(store.titles).length}件 (${UNEXT_STORE_PATH})\n`)

  let raw: ChangeEvent[] = []
  let fresh: ChangeEvent[] = []

  try {
    raw = await source.collectChanges({ sinceDays: 0, kinds })

    fresh = dedupe(raw, ledger)

    // 作品ページは1件1遷移と高いので、**台帳で落としたあとの新規だけ**に足す。
    // expiring は収集の時点で日付が要る（期限の判定に使う）ので既に済んでいる。
    const enriched = await source.enrich(fresh.filter((e) => e.kind === 'new'))

    // --- 結果 ---------------------------------------------------------
    const tally = new Map<string, number>()
    for (const e of fresh) {
      const g = String(e.work.meta.genreLabel ?? '?')
      tally.set(`${e.kind} / ${g}`, (tally.get(`${e.kind} / ${g}`) ?? 0) + 1)
    }
    console.log('\n--- 新規に見つかった変化 ---')
    for (const [k, n] of [...tally].sort()) {
      console.log(`  ${k.padEnd(28)} ${String(n).padStart(4)}件`)
    }

    const expiring = fresh
      .filter((e) => e.kind === 'expiring' && e.at)
      .sort((a, b) => a.at!.localeCompare(b.at!))
    if (expiring.length) {
      console.log('\n--- 配信終了予定（近い順・先頭20件） ---')
      for (const e of expiring.slice(0, 20)) {
        const d = daysUntil(e.at!, theme.utc_offset_minutes)
        const lineup = e.work.meta.lineup === 'svod' ? '見放題' : String(e.work.meta.lineup)
        console.log(
          `  ${formatFullDate(e.at!, theme.utc_offset_minutes).padEnd(12)} ` +
            `あと${String(d).padStart(3)}日  [${lineup}] ${e.work.title}`,
        )
      }
    }

    // 配信終了日が前回から動いた作品。延長も前倒しも、記事の訂正に直結する。
    if (source.endDateChanges.length) {
      console.log('\n--- 配信終了日が変わった作品 ---')
      for (const c of source.endDateChanges) {
        console.log(
          `  ${c.title}: ${formatFullDate(c.from, theme.utc_offset_minutes)} → ` +
            formatFullDate(c.to, theme.utc_offset_minutes),
        )
      }
      console.log('  ※ すでに記事にしている作品なら、記事側の訂正が要ります')
    }

    if (!dryRun) {
      await appendEvents(fresh, theme.utc_offset_minutes)
      ledger.seen.push(...fresh.map(eventKey))
      await saveLedger(ledger)
      await saveStore(store)
    }

    console.log(
      `\n取得 ${raw.length}件 / 新規 ${fresh.length}件` +
        `（${raw.length - fresh.length}件は既出のため除外）`,
    )
    console.log(`作品台帳: ${Object.keys(store.titles).length}件`)
    console.log(`配信開始日を足した新着: ${enriched}件`)
    console.log(`作品ページを開かずに済んだ既知の作品: ${source.detailSkipped}件`)
    if (source.detailFailed) {
      console.log(`取得できなかった作品ページ: ${source.detailFailed}件（次回の実行で拾い直せます）`)
    }
    if (source.detailBudgetLeft <= 0) {
      console.log(
        '※ 作品ページの上限に達しました。取りこぼしたぶんは次回の実行で拾えます' +
          '（--max-detail で上限を変えられます）',
      )
    }
  } finally {
    await browser.close()
    console.log(
      `\n開いたページ: ${browser.pageViews}（うち作品ページ ${source.detailViews}）` +
        `  所要の目安 ${Math.round((browser.pageViews * cfg.min_interval_ms) / 1000)}秒`,
    )
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
