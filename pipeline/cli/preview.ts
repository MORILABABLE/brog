/**
 * 収集済みイベントから、記事になったときの見え方をプレビューする。
 *
 *   npm run preview                    配信終了（expiring）
 *   npm run preview -- --kind new
 *   npm run preview -- --limit 5
 *
 * LLMを呼ばずに素材だけを組み立てて表示する。
 * 記事テンプレを詰める(P2)前に、データが記事として成立するかを確認するためのもの。
 * APIリクエストは消費しない。
 */
import { loadTheme } from '../theme.ts'
import { readEvents } from '../core/events.ts'
import { buildSearchLinks } from '../core/search-links.ts'
import { ATTRIBUTION } from '../sources/streaming-availability.ts'
import { currentYearMonth, formatMonthDay } from '../core/datetime.ts'
import type { ChangeKind } from '../sources/types.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const kind = (arg('kind') ?? 'expiring') as ChangeKind
  const limit = Number(arg('limit') ?? 10)

  const month = currentYearMonth(theme.utc_offset_minutes)
  const events = (await readEvents(month)).filter((e) => e.kind === kind)

  if (events.length === 0) {
    console.log(`${month} に ${kind} のイベントがありません。先に npm run collect を実行してください。`)
    return
  }

  const labelOf = new Map(theme.catalogs.map((c) => [c.key, c.label]))
  const sorted = events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).slice(0, limit)

  const heading =
    kind === 'expiring'
      ? `【${new Date().getMonth() + 1}月】配信終了予定の作品`
      : `【${month}】新しく配信が始まった作品`
  console.log(`\n# ${heading}\n`)

  for (const e of sorted) {
    const when = e.at ? formatMonthDay(e.at, theme.utc_offset_minutes) : '日付未定'
    const title = e.work.localizedTitle ?? e.work.title
    const original = e.work.localizedTitle ? `（原題: ${e.work.title}）` : '（邦題未確認・原題表記）'

    console.log(`## ${title}`)
    console.log(`${original}`)
    console.log(
      `- ${labelOf.get(e.service) ?? e.service}｜${when}${kind === 'expiring' ? 'に配信終了' : 'に配信開始'}` +
        `${e.work.year ? `｜${e.work.year}年` : ''}` +
        `${e.work.rating ? `｜評価 ${e.work.rating}/100` : ''}`,
    )
    if (e.work.genres.length) console.log(`- ジャンル: ${e.work.genres.join(' / ')}`)
    if (e.work.overview) console.log(`- あらすじ(原文): ${e.work.overview.slice(0, 80)}…`)

    const links = buildSearchLinks(e.work, theme.search_links ?? [])
    if (links.length) {
      console.log(`- 他サービスで探す: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}`)
    }
    console.log('')
  }

  console.log('---')
  console.log(`> ${ATTRIBUTION.text}`)
  console.log(`> ${ATTRIBUTION.url}`)
  console.log(
    `\n（${events.length}件中 ${sorted.length}件を表示。邦題解決 ` +
      `${events.filter((e) => e.work.localizedTitle).length}/${events.length}件）`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
