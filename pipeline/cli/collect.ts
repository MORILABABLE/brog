/**
 * 配信状況の変化を収集する。
 *
 *   npm run collect              直近7日の new / removed / expiring
 *   npm run collect -- --days 14
 *   npm run collect -- --kinds new,expiring
 *
 * 記事化(P2)はここで貯めた data/events/*.jsonl を読む。
 * 収集と執筆を分けているのは、APIリクエストを節約しつつ
 * 記事生成だけを何度でもやり直せるようにするため。
 */
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import type { ChangeKind } from '../sources/types.ts'
import { appendEvents, dedupe, eventKey, loadLedger, saveLedger } from '../core/events.ts'
import {
  loadTitleCache,
  resolveTitles,
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

  const kinds = (arg('kinds')?.split(',') ?? ['new', 'removed', 'expiring']) as ChangeKind[]
  const invalid = kinds.filter((k) => !VALID_KINDS.includes(k))
  if (invalid.length) {
    throw new Error(`不正な kind: ${invalid.join(', ')}（有効: ${VALID_KINDS.join(', ')}）`)
  }

  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY ?? '', theme)

  console.log(`テーマ: ${theme.label} (${theme.key})  国: ${theme.country}`)
  console.log(`対象: ${kinds.join(', ')}  期間: 直近${sinceDays}日\n`)

  const raw = await source.collectChanges({ sinceDays, kinds })
  const ledger = await loadLedger()
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
