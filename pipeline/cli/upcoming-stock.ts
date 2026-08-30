/**
 * 先出し（配信開始予定）の在庫を1枚にまとめて、運用者が把握できるようにする。
 *
 *   npm run stock                書き出す（data/UPCOMING.md）
 *   npm run stock -- --print     標準出力にも出す
 *
 * ■ 通知（`npm run notify`）と何が違うか
 * 通知は**差分**を送る。「前回以降に増えた変化」だけなので、
 * 1通を読み逃すとその月に何が貯まっているのかが分からなくなる。
 *
 * こちらは**現在の在庫**を毎回まるごと書き直す。
 * ファイルはリポジトリに入るので、GitHub でいつでも今の状態が見られる。
 * 「9月のNetflixは何件貯まっていて、そのうち画像が付いているのは何件で、
 * 記事はもう書いたか」が1画面で分かることを目的にしている。
 *
 * ★ **APIを消費しない。** 読むのは `data/events/*.jsonl` と
 *   `site/src/content/posts/` だけ。毎日の収集のあとに素通しで走らせてよい。
 *
 * ★ サイトには出さない。運用者向けの内部資料で、`site/` からは参照しない。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { readAllEvents } from '../core/events.ts'
import { formatIsoDate } from '../core/datetime.ts'
import type { ChangeEvent } from '../sources/types.ts'

const OUT_PATH = join('data', 'UPCOMING.md')
const POSTS_DIR = join('site', 'src', 'content', 'posts')

/** 記事にするならこれくらいは要る、という目安（upcoming-service.ts の MIN_ITEMS と揃える） */
const MIN_ITEMS = 10

const flag = (name: string) => process.argv.includes(`--${name}`)

/** 公開済みのスラッグ一覧。記事が書かれているかの判定に使う */
async function publishedSlugs(): Promise<Set<string>> {
  try {
    const files = await readdir(POSTS_DIR)
    return new Set(files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')))
  } catch {
    return new Set()
  }
}

interface Row {
  month: string
  service: string
  label: string
  total: number
  withImage: number
  first?: string
  last?: string
  collectedLast?: string
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const tz = theme.utc_offset_minutes
  const label = new Map(theme.catalogs.map((c) => [c.key, c.label]))
  if (theme.unext) label.set(theme.unext.service_key, theme.unext.label)

  const events = (await readAllEvents()).filter((e) => e.kind === 'upcoming' && e.at)
  const slugs = await publishedSlugs()

  // 月 × サービスで束ねる。月は**配信開始日**の月（収集した月ではない）。
  const groups = new Map<string, ChangeEvent[]>()
  for (const e of events) {
    const month = formatIsoDate(e.at!, tz).slice(0, 7)
    const key = `${month}|${e.service}`
    const list = groups.get(key) ?? []
    list.push(e)
    groups.set(key, list)
  }

  const rows: Row[] = []
  for (const [key, list] of groups) {
    const [month, service] = key.split('|') as [string, string]
    const dates = list.map((e) => formatIsoDate(e.at!, tz)).sort()
    rows.push({
      month,
      service,
      label: label.get(service) ?? service,
      total: list.length,
      withImage: list.filter((e) => e.work.posterUrl).length,
      first: dates[0],
      last: dates.at(-1),
      collectedLast: list.map((e) => e.collectedAt).sort().at(-1),
    })
  }
  rows.sort((a, b) => a.month.localeCompare(b.month) || a.service.localeCompare(b.service))

  const now = new Date()
  const lines: string[] = []
  lines.push('# 先出し（配信開始予定）の在庫')
  lines.push('')
  lines.push(`最終更新: ${formatIsoDate(now.toISOString(), tz)}（\`npm run stock\` が自動生成。手で編集しない）`)
  lines.push('')
  lines.push('各社の告知から取り込んだ「これから配信が始まる作品」の貯まり具合。')
  lines.push('**差分ではなく現在の在庫**なので、通知を読み逃してもここを見れば今の状態が分かる。')
  lines.push('')

  if (rows.length === 0) {
    lines.push('いまは在庫がありません。`npm run collect:announce -- --check` で告知の有無を見られます。')
  } else {
    lines.push('| 対象月 | サービス | 件数 | 画像 | 配信開始日の範囲 | 記事 |')
    lines.push('|---|---|---:|---:|---|---|')
    for (const r of rows) {
      const slug = `${r.month}-upcoming-${r.service}`
      // ジャンル軸（…-upcoming-{service}-{genre}）で書いている月もある
      const genreWritten = [...slugs].filter((s) => s.startsWith(`${slug}-`))
      const article = slugs.has(slug)
        ? '✅ 作成済'
        : genreWritten.length
          ? `✅ ジャンル軸で${genreWritten.length}本`
          : r.total >= MIN_ITEMS
            ? '**未作成（書ける）**'
            : `未作成（${MIN_ITEMS}件に満たない）`
      const range = r.first === r.last ? (r.first ?? '—') : `${r.first} 〜 ${r.last}`
      lines.push(
        `| ${r.month} | ${r.label} | ${r.total} | ${r.withImage}/${r.total} | ${range} | ${article} |`,
      )
    }
    lines.push('')

    const writable = rows.filter(
      (r) => r.total >= MIN_ITEMS && !slugs.has(`${r.month}-upcoming-${r.service}`) &&
        ![...slugs].some((s) => s.startsWith(`${r.month}-upcoming-${r.service}-`)),
    )
    if (writable.length) {
      lines.push('## いま書けるもの')
      lines.push('')
      for (const r of writable) {
        lines.push(
          `- **${r.label} ${r.month}**（${r.total}件）  ` +
            `\`npm run write -- --type upcoming-service --service ${r.service} --month ${r.month} --emit\``,
        )
      }
      lines.push('')
    }

    const noImage = rows.filter((r) => r.withImage < r.total)
    if (noImage.length) {
      lines.push('## 画像が足りていないもの')
      lines.push('')
      lines.push(
        '告知は配信が始まる前の情報なので、その時点では画像が取れない作品がある。' +
          '**配信が始まればAPIが同じ作品を返す**ので、`npm run backfill:images` が後から入れる。',
      )
      lines.push('')
      for (const r of noImage) {
        lines.push(`- ${r.label} ${r.month}: ${r.total - r.withImage}件が画像なし`)
      }
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('')
  lines.push('仕組みは [docs/ANNOUNCEMENTS.md](../docs/ANNOUNCEMENTS.md)。')

  const body = lines.join('\n') + '\n'
  await writeFile(OUT_PATH, body, 'utf8')
  console.log(`${OUT_PATH} を書き出しました（${rows.length}行）`)
  if (flag('print')) console.log('\n' + body)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
