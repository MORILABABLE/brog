/**
 * 配信状況の変化を収集する。
 *
 *   npm run collect              直近7日の new / removed / expiring / upcoming
 *   npm run collect -- --days 14
 *   npm run collect -- --kinds new,expiring
 *
 * 記事化(P2)はここで貯めた data/events/*.jsonl を読む。
 * 収集と執筆を分けているのは、APIリクエストを節約しつつ
 * 記事生成だけを何度でもやり直せるようにするため。
 */
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import type { ChangeEvent, ChangeKind } from '../sources/types.ts'
import {
  appendEvents,
  dedupe,
  eventKey,
  loadLedger,
  readAllEvents,
  saveLedger,
} from '../core/events.ts'
import { appendHistory, type StockChange } from '../core/history.ts'
import { addUsage, warnIfLow } from '../core/api-usage.ts'
import {
  loadCompanyCache,
  loadOriginCache,
  loadTitleCache,
  resolveCompanies,
  resolveOrigins,
  resolveTitles,
  saveCompanyCache,
  saveOriginCache,
  saveTitleCache,
  titleCacheKey,
  type TitleRef,
} from '../sources/wikidata.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かず、環境変数を直接渡す
}

const VALID_KINDS: ChangeKind[] = ['new', 'removed', 'expiring', 'upcoming']

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const sinceDays = Number(arg('days') ?? 7)

  // upcoming（配信開始予定）も既定で取る。配信開始記事の末尾に置く
  // 「これから配信開始予定」の素材になる。追加コストは月10〜20リクエスト程度。
  const kinds = (arg('kinds')?.split(',') ?? ['new', 'removed', 'expiring', 'upcoming']) as ChangeKind[]
  const invalid = kinds.filter((k) => !VALID_KINDS.includes(k))
  if (invalid.length) {
    throw new Error(`不正な kind: ${invalid.join(', ')}（有効: ${VALID_KINDS.join(', ')}）`)
  }

  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY ?? '', theme)

  console.log(`テーマ: ${theme.label} (${theme.key})  国: ${theme.country}`)
  console.log(`対象: ${kinds.join(', ')}  期間: 直近${sinceDays}日\n`)

  let raw: ChangeEvent[]
  try {
    raw = await source.collectChanges({ sinceDays, kinds })
  } finally {
    // 途中で落ちてもリクエストは消費されている。枠の記録だけは必ず残す。
    // ここを finally にしていないと、429 で落ちた回の消費が記録から抜ける。
    const usage = await addUsage(source.requestCount, theme.utc_offset_minutes)
    console.log(
      `\nAPIリクエスト ${source.requestCount}回  ` +
        `${usage.month} の消費 ${usage.used}/${usage.limit}\n`,
    )
    // ★ 残量の警告はここでも出す（2026-09-10 追加。**ここだけ抜けていた**）。
    //   availability / collect-announce / refresh-images は前から出していたが、
    //   **定期収集のログにだけ残量が出ていなかった。**
    //   9月の消費232回のうち定期実行は42回で、残りは手で叩いた分だった。
    //   ブラウザで Actions のログを見たときに残量が分かることが大事。
    warnIfLow(usage)
  }

  const ledger = await loadLedger()

  /*
   * ★ **重複として落とす前に、終了日が動いていないかを見る**（2026-09-07 追加）。
   *
   * 台帳は `service:kind:作品ID` で重複を落とす。同じ作品を二度記事にしないための
   * 仕組みで、そこは正しい。だが**そのせいで、同じ作品の2回目の `expiring`
   * （＝終了日が変わった、延長された）が丸ごと消えていた。**
   *
   *   実測（2026-09-07）: Netflix の expiring 190作のうち、
   *   同じ作品で2回記録されたものは **0件**。構造上ありえない。
   *
   * U-NEXT には `unext:refresh` があって延長に気づけるが、
   * **配信APIの4社には気づく手段が1つも無かった。**
   * `expiring` が実際に返るのは Netflix と Prime Video の2社だけなので
   * （theme.yaml の実測）、ここが**この2社で唯一「時間」を積める場所**。
   *
   * ★ **イベントは今までどおり落とす。** 記事の素材は増やさない
   *   （同じ作品を二度記事にしない決まりは変えない）。
   *   積むのは履歴だけ（`data/history/`）。
   */
  const dateShifts: StockChange[] = []
  {
    const known = new Map<string, string>()
    for (const e of await readAllEvents()) {
      if (!e.at) continue
      known.set(eventKey(e), e.at)
    }
    const observedAt = new Date().toISOString()
    for (const e of raw) {
      if (e.kind !== 'expiring' || !e.at) continue
      const was = known.get(eventKey(e))
      if (!was || was === e.at) continue
      dateShifts.push({
        observedAt,
        service: e.service,
        workId: String(e.work.id),
        title: e.work.localizedTitle ?? e.work.title,
        field: 'endDate',
        from: was,
        to: e.at,
        via: `collect --kinds ${kinds.join(',')}`,
      })
    }
  }
  if (dateShifts.length > 0) {
    console.log(`終了日が動いた作品 ${dateShifts.length}件（履歴に積みます）`)
    for (const c of dateShifts.slice(0, 10)) {
      console.log(`  ${c.title}: ${c.from?.slice(0, 10)} → ${c.to?.slice(0, 10)}`)
    }
  }

  const fresh = dedupe(raw, ledger)

  // 邦題を解決する。APIが日本語を返さないため、Wikidata(CC0)から引く。
  // 失敗しても収集は止めない（原題のまま記録される）。
  const cache = await loadTitleCache()
  const refs: TitleRef[] = fresh.map((e) => ({
    imdbId: typeof e.work.meta.imdbId === 'string' ? e.work.meta.imdbId : undefined,
    tmdbId: typeof e.work.meta.tmdbId === 'string' ? e.work.meta.tmdbId : undefined,
  }))
  await resolveTitles(refs, theme.site_language, cache)
  await saveTitleCache(cache)

  // 原語も解決する。ジャンル別記事（アニメ/洋画/邦画）の振り分けに使う。
  // 同じく Wikidata なので無料。失敗しても収集は止めない。
  const originCache = await loadOriginCache()
  await resolveOrigins(refs, originCache)
  await saveOriginCache(originCache)

  // 制作会社も解決する。「同じ制作会社の作品が一斉に配信開始」というまとまりを
  // 推測ではなく事実として書くための材料になる。
  const companyCache = await loadCompanyCache()
  await resolveCompanies(refs, theme.site_language, companyCache)
  await saveCompanyCache(companyCache)

  let resolved = 0
  for (const [i, e] of fresh.entries()) {
    const key = titleCacheKey(refs[i]!)
    const title = key ? cache[key] : undefined
    if (title) {
      e.work.localizedTitle = title
      resolved++
    }
  }

  // サービス×種別ごとの内訳を出す。取得漏れに気づくため。
  const tally = new Map<string, number>()
  for (const e of fresh) {
    const k = `${e.service} / ${e.kind}`
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...tally].sort()) {
    console.log(`  ${k.padEnd(28)} ${String(n).padStart(4)}件`)
  }

  await appendEvents(fresh, theme.utc_offset_minutes)
  await appendHistory(dateShifts, theme.utc_offset_minutes)
  ledger.seen.push(...fresh.map(eventKey))
  await saveLedger(ledger)

  console.log(
    `\n取得 ${raw.length}件 / 新規 ${fresh.length}件（${raw.length - fresh.length}件は既出のため除外）`,
  )
  if (fresh.length > 0) {
    const pct = Math.round((resolved / fresh.length) * 100)
    console.log(`邦題解決 ${resolved}/${fresh.length}件 (${pct}%)  ※残りは原題のまま`)
  }
  if (fresh.length === 0 && raw.length > 0) {
    console.log('すべて既出でした。期間を延ばすか、次回の実行を待ってください。')
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
