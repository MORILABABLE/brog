/**
 * 公開済みの記事の frontmatter に、ジャンル（`genres` / `genreDetail`）を入れる。
 *
 *   npm run genres                    入れられるものを全部入れる
 *   npm run genres -- --dry-run       何が入るかだけ見る（書き換えない）
 *   npm run genres -- --slug gundam   1本だけ
 *
 * ■ なぜ要るか
 * 新しく書く記事のジャンルは `npm run write` が入れる（write.ts の `finalize`）。
 * あちらは**記事の素材（ChangeEvent）をそのまま持っている**ので正確に数えられる。
 * ところが**すでに公開してある記事にはその素材が残っていない。**
 * `data/articles.json` にレシピが残っているのは17本で、32本の半分だけ。
 *
 * そこで、記事**本文の表**に載っている作品名を読み、収集済みのイベントと
 * 突き合わせてジャンルを数える。表はどの記事タイプにも必ずあり（`| … | 作品 | … |`）、
 * そこに並んでいるのが記事が扱った作品そのものなので、素材の代わりになる。
 *
 * ★ **APIを消費しない。** 読むのは `data/events/*.jsonl` と記事本文だけ。
 *
 * ■ 突き合わせは題名で行う（backfill-images.ts と逆）
 * あちらが題名を使わないのは、**画像を1枚間違えると記事の信用が落ちる**から。
 * こちらが決めるのは「アニメか洋画か邦画か」で、同名の別作品に当たっても
 * ほとんどの場合ジャンルは変わらない。粒度が粗いぶん題名で足りる。
 * 当たらなかった作品は数えないだけで、記事全体のジャンルは残りの作品で決まる
 * （実測: 1930行中1870行が一致。1本も当たらない記事は無い）。
 *
 * ★ 一度入れた値は毎回入れ直す。収集が進んで判定が変われば、次回の実行で更新される。
 *   手で直した値を残したいときは `--dry-run` で差分だけ見ること。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readAllEventsSync } from '../core/events.ts'
import { loadSummarizeGenres, loadTheme } from '../theme.ts'
import type { SummarizeGenres } from '../core/article.ts'
import type { Work } from '../sources/types.ts'

const POSTS_DIR = join('site', 'src', 'content', 'posts')

const flag = (name: string) => process.argv.includes(`--${name}`)
function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 突き合わせ用に題名をならす。全角空白・記号のゆれで外さないため。 */
function normalize(title: string): string {
  return title
    .replace(/\s|　/g, '')
    .replace(/[!！?？:：・,，.。'’"”\-−–—~〜]/g, '')
    .toLowerCase()
}

/** 表のセルから作品名を取り出す。`**強調**` と `[題](url)` を外す。 */
function cellTitle(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\\$/, '')
    .trim()
}

/**
 * 題名 → 作品。同じ題で複数のイベントが当たることがある（別サービス・別月）ので、
 * **ジャンルが決まるほうを優先して1件に絞る。**
 * U-NEXT 由来の作品は原語も imdbId も持たないことがあり、
 * 同じ作品が配信API側にもあれば、そちらのほうがよく決まる。
 */
function buildIndex(summarize: SummarizeGenres): Map<string, Work> {
  const decided = (work: Work) => summarize([work]).genres.length > 0
  const index = new Map<string, Work>()
  for (const event of readAllEventsSync()) {
    const work = event.work
    const better = decided(work)
    for (const title of [work.localizedTitle, work.title, work.originalTitle]) {
      if (!title) continue
      const key = normalize(title)
      if (!key) continue
      const held = index.get(key)
      if (!held || (better && !decided(held))) index.set(key, work)
    }
  }
  return index
}

/**
 * 記事本文の表から作品名を拾う。
 *
 * 見出し行（次の行が `|---|---|` の形）で「作品」の列を探し、
 * 以降の行のその列を読む。**列の位置は記事タイプによって違う**
 * （`| 終了日 | 作品 | 評価 | サービス |` `| 作品 | 公開年 | 評価 |` など）ので、
 * 位置を決め打ちにしないこと。
 */
function tableTitles(body: string): string[] {
  const lines = body.split('\n')
  const titles: string[] = []
  let column = -1

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('|')) {
      column = -1
      continue
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (/^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) {
      column = cells.findIndex((c) => c === '作品')
      continue
    }
    if (column < 0) continue
    const title = cellTitle(cells[column] ?? '')
    // 「—」は状態欄と同じ書き方の空欄
    if (title && title !== '—') titles.push(title)
  }
  return titles
}

/**
 * frontmatter の `genres` / `genreDetail` を入れ替える。
 *
 * ★ 置き場所は **`category:` の直後**。`buildMarkdown()`（pipeline/core/article.ts）が
 *   新しい記事に書く並びと揃える。並びが揃っていないと、
 *   自動生成の記事と手入れした記事で diff の見え方が変わる。
 * ★ 旧 `genre:`（単数・2026-09-15 まで使っていた）が残っていれば消す。
 */
function replaceGenres(md: string, genres: string[], detail?: string): string | null {
  const end = md.indexOf('\n---', 4)
  if (!md.startsWith('---\n') || end < 0) return null

  const head = md.slice(4, end).split('\n')
  const rest = md.slice(end + 1)

  const kept = head.filter((l) => !/^genres?:/.test(l) && !/^genreDetail:/.test(l))
  const added = [
    `genres: [${genres.map((g) => `'${g}'`).join(', ')}]`,
    ...(detail ? [`genreDetail: '${detail}'`] : []),
  ]

  const at = kept.findIndex((l) => l.startsWith('category:'))
  const insert = at >= 0 ? at + 1 : kept.length
  kept.splice(insert, 0, ...added)

  return ['---', ...kept, rest].join('\n')
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run')
  const only = value('slug')

  const summarize = await loadSummarizeGenres(await loadTheme())
  const index = buildIndex(summarize)
  console.log(`収集済みの題名: ${index.size}件`)

  const files = (await readdir(POSTS_DIR))
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !only || f === `${only}.md`)

  if (files.length === 0) {
    console.error(only ? `記事が見つかりません: ${only}` : '記事がありません。')
    process.exit(1)
  }

  let written = 0
  let empty = 0

  for (const file of files) {
    const path = join(POSTS_DIR, file)
    const md = await readFile(path, 'utf8')
    const slug = file.replace(/\.md$/, '')

    const titles = tableTitles(md)
    const works: Work[] = []
    let missed = 0
    for (const title of titles) {
      const work = index.get(normalize(title))
      if (work) works.push(work)
      else missed++
    }

    const { genres, detail } = summarize(works)
    const shown = genres.length
      ? genres.join(' / ') + (detail ? `（${detail}）` : '')
      : '—'
    const miss = missed ? `  未一致${missed}` : ''
    console.log(`  ${slug.padEnd(40)} 作品${String(titles.length).padStart(4)}${miss}  → ${shown}`)

    if (genres.length === 0) {
      empty++
      console.log('    ジャンルが1つも決まりませんでした。frontmatter は触りません。')
      continue
    }
    if (dryRun) continue

    const next = replaceGenres(md, genres, detail)
    if (next === null) {
      console.error(`    frontmatter を読めません: ${file}`)
      continue
    }
    if (next !== md) {
      await writeFile(path, next, 'utf8')
      written++
    }
  }

  console.log(
    dryRun
      ? `\n--dry-run のため書き換えていません（対象 ${files.length}本）。`
      : `\nfrontmatter を ${written}本 更新しました（対象 ${files.length}本）。`,
  )
  if (empty > 0) {
    console.log(
      `ジャンルが決まらなかった記事が ${empty}本あります。` +
        'サイトのビルドは通りますが、その記事にだけバッジが出ません。',
    )
  }
}

await main()
