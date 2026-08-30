/**
 * 各社が出した「翌月の配信開始ラインナップ」の告知を取り込む。
 *
 *   npm run collect:announce                    翌月ぶんを取り込む
 *   npm run collect:announce -- --month 2026-09 月を指定する
 *   npm run collect:announce -- --check         出ているかだけ見る（何も書かない）
 *   npm run collect:announce -- --dry-run       解析まで見る（何も書かない）
 *   npm run collect:announce -- --no-images     画像を取りに行かない（API消費0）
 *
 * ■ collect / collect:unext と分けている理由
 * 性質が違うため。
 *
 *   collect          HTTP API。無料枠500req/月。過去の変化を取る
 *   collect:unext    実ブラウザ。時間と相手の負荷が制約。いまの一覧を取る
 *   collect:announce 告知ページ1枚。**月に一度しか中身が変わらない。**
 *                    毎日走らせても取れるものは同じで、意味があるのは月末だけ
 *
 * ■ --check は何のためにあるか
 * 告知は「前月末に出る」だけで、**何日に出るかは各社まちまち**。
 * 25日から毎日見に行き、出た日に通知するのが運用の形になる
 * （.github/workflows/announce.yml）。--check はその判定だけを行い、
 * 台帳にもイベントログにも触らない。**取り込むかどうかは人が決める。**
 *
 * ■ 画像
 * 告知には画像が無いので、邦題から作品を特定して API から取る
 * （pipeline/sources/announced-works.ts）。**特定できた作品1件につき1リクエスト。**
 * 1件も取れなくても記事は書ける（ジャンル別の自前タイルに落ちる）。
 */
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import {
  announcementUrl,
  fetchAnnouncement,
  parseAnnouncement,
  toEvents,
  type AnnouncementConfig,
} from '../sources/announcement.ts'
import {
  DEFAULT_MAX_LOOKUPS,
  loadAnnouncedWorks,
  loadPins,
  resolveAnnouncedWorks,
  saveAnnouncedWorks,
} from '../sources/announced-works.ts'
import { appendEvents, dedupe, loadLedger, saveLedger, eventKey } from '../core/events.ts'
import { addUsage } from '../core/api-usage.ts'
import { formatFullDate } from '../core/datetime.ts'
import type { ChangeEvent } from '../sources/types.ts'
import { appendFileSync } from 'node:fs'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

/** 記事1本として成立する最低件数。これを下回るなら「まだ待つ」と判断する */
const ENOUGH_ITEMS = 20

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 対象月の既定は「翌月」。告知は前月末に出るので、指定なしで走らせる先はいつも翌月 */
function nextYearMonth(offsetMinutes: number): string {
  const now = new Date(Date.now() + offsetMinutes * 60_000)
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1 // 0-indexed の翌月 = 今月の番号
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`
}

/** GitHub Actions から呼ばれたときだけ、後続の判断に使える形で出力する */
function emitOutput(key: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT
  if (!path) return
  try {
    appendFileSync(path, `${key}=${value}\n`, 'utf8')
  } catch {
    // 出力できなくても収集の結果は標準出力に出ている
  }
}

interface ServiceResult {
  cfg: AnnouncementConfig
  url: string
  /** 告知ページがまだ無い（404） */
  pending: boolean
  events: ChangeEvent[]
  fresh: ChangeEvent[]
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const check = process.argv.includes('--check')
  const dryRun = process.argv.includes('--dry-run') || check
  const withImages = !process.argv.includes('--no-images') && !check
  const month = arg('month') ?? nextYearMonth(theme.utc_offset_minutes)
  const maxLookups = Number(arg('max-lookups') ?? DEFAULT_MAX_LOOKUPS)

  const configured = theme.announcements ?? []
  if (configured.length === 0) {
    throw new Error(
      `テーマ ${theme.key} に announcements の設定がありません（theme.yaml の announcements 節）`,
    )
  }
  const only = arg('service')?.split(',')
  const targets = only ? configured.filter((a) => only.includes(a.service)) : configured
  if (targets.length === 0) {
    throw new Error(
      `--service に一致する告知元がありません。有効: ${configured.map((a) => a.service).join(', ')}`,
    )
  }

  console.log(`テーマ: ${theme.label} (${theme.key})`)
  console.log(`対象月: ${month}  告知元: ${targets.map((t) => t.label).join(', ')}`)
  if (check) console.log('※ --check: 出ているかを見るだけで、何も書きません')
  else if (dryRun) console.log('※ --dry-run: 台帳もイベントログも書きません')
  console.log('')

  const ledger = await loadLedger()
  const results: ServiceResult[] = []

  for (const cfg of targets) {
    const url = announcementUrl(cfg, month)
    const html = await fetchAnnouncement(url)
    if (html === null) {
      console.log(`${cfg.label}: まだ出ていません（404）`)
      console.log(`  ${url}\n`)
      results.push({ cfg, url, pending: true, events: [], fresh: [] })
      continue
    }

    const items = parseAnnouncement(cfg.parser, html, month)
    const events = toEvents(items, cfg, { url, utcOffsetMinutes: theme.utc_offset_minutes })
    // 台帳と突き合わせるだけ。--check でも「もう取り込み済みか」は見たい
    const seen = new Set(ledger.seen)
    const fresh = events.filter((e) => !seen.has(eventKey(e)))

    const dated = events.filter((e) => e.at).length
    // ★ ローリング窓の告知元は対象月で絞らない（announcement.ts の
    //   parseNetflixNewToWatch）。窓は進んでいき、落としたぶんは二度と取れないため。
    const scope = cfg.rolling ? '窓の全件・対象月では絞らない' : ''
    console.log(
      `${cfg.label}: ${events.length}件（日付つき ${dated}件 / 新規 ${fresh.length}件）` +
        (scope ? `  ※${scope}` : ''),
    )
    const byCategory = new Map<string, number>()
    for (const e of events) {
      const c = String(e.work.meta.category ?? 'その他')
      byCategory.set(c, (byCategory.get(c) ?? 0) + 1)
    }
    for (const [c, n] of byCategory) console.log(`  ${c}: ${n}件`)
    console.log(`  ${url}\n`)

    results.push({ cfg, url, pending: false, events, fresh })
  }

  const total = results.reduce((n, r) => n + r.events.length, 0)
  const fresh = results.flatMap((r) => r.fresh)
  const ready = results.some((r) => !r.pending && r.events.length >= ENOUGH_ITEMS)

  if (check) {
    console.log(
      ready
        ? `→ 記事にできます（${total}件）。取り込むには npm run collect:announce -- --month ${month}`
        : `→ まだ書けません（${total}件 / ${ENOUGH_ITEMS}件で判断）`,
    )
    emitOutput('ready', String(ready))
    emitOutput('month', month)
    emitOutput('total', String(total))
    emitOutput(
      'services',
      results.filter((r) => !r.pending && r.events.length >= ENOUGH_ITEMS).map((r) => r.cfg.service).join(','),
    )
    emitOutput(
      'summary',
      results
        .map((r) => `${r.cfg.label} ${r.pending ? '未発表' : `${r.events.length}件`}`)
        .join(' / '),
    )
    return
  }

  if (fresh.length === 0) {
    console.log('新しい告知はありません（すべて取り込み済み）。')
    return
  }

  // --- 画像とメタ情報 -------------------------------------------------------
  if (withImages && process.env.STREAMING_API_KEY) {
    const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY, theme)
    const store = await loadAnnouncedWorks()
    const pins = await loadPins()
    try {
      const res = await resolveAnnouncedWorks(fresh, {
        source,
        lang: theme.site_language,
        store,
        pins,
        maxLookups,
        log: (m) => console.log(m),
      })
      console.log(
        `\n画像: ${res.resolved}件で取得  ` +
          `絞れず ${res.ambiguous.length}件  Wikidataに無し ${res.missing.length}件  ` +
          `APIリクエスト ${res.lookups}回`,
      )
      if (res.ambiguous.length) {
        console.log(
          '\n同名の作品が複数あり、画像を諦めました。' +
            'data/announcement-pins.json に書けば次回から使われます:',
        )
        for (const a of res.ambiguous.slice(0, 20)) {
          const cands = a.candidates
            .map((c) => `${c.imdbId}${c.year ? `(${c.year})` : ''}${c.type ? ` ${c.type}` : ''}`)
            .join(' / ')
          console.log(`  "${a.title}": ""   ← 候補: ${cands}`)
        }
      }
    } finally {
      if (!dryRun) await saveAnnouncedWorks(store)
      const usage = await addUsage(source.requestCount, theme.utc_offset_minutes)
      console.log(`${usage.month} の消費 ${usage.used}/${usage.limit}`)
    }
  } else if (withImages) {
    console.log('STREAMING_API_KEY が無いので画像は取りません（記事は文字だけで書けます）')
  }

  // --- 書き出し -------------------------------------------------------------
  if (dryRun) {
    console.log(`\n※ --dry-run のため書き込みません（新規 ${fresh.length}件）`)
    for (const e of fresh.slice(0, 10)) {
      const at = e.at ? formatFullDate(e.at, theme.utc_offset_minutes) : '日付未定'
      const poster = e.work.posterUrl ? ' [画像]' : ''
      console.log(`  ${at}  ${e.work.localizedTitle ?? e.work.title}${poster}`)
    }
    return
  }

  await appendEvents(fresh, theme.utc_offset_minutes)
  ledger.seen.push(...fresh.map(eventKey))
  await saveLedger(ledger)

  const withPoster = fresh.filter((e) => e.work.posterUrl).length
  console.log(`\n${fresh.length}件を記録しました（画像つき ${withPoster}件）。`)
  console.log(`記事にするには: npm run write -- --list`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
