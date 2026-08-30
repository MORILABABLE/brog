/**
 * 公開済みの記事を非公開にする／戻す。
 *
 *   npm run unpublish -- --slug 2026-09-upcoming-netflix   非公開にする（draft: true）
 *   npm run publish   -- --slug 2026-09-upcoming-netflix   公開に戻す（draft: false）
 *   npm run unpublish -- --list                            いまの公開状態を一覧する
 *
 * ■ 何をしているか
 * 記事の frontmatter の `draft` を切り替えるだけ。**記事は消さない。**
 * サイト側は `getCollection('posts', ({ data }) => !data.draft)` で
 * 全ページ・RSS・サイトマップ・検索から除外しているので、
 * `draft: true` にすればどこからも辿れなくなる（`site/src/content.config.ts`）。
 *
 * ★ **URLは残らない。** ページ自体がビルドされないので404になる。
 *   すでに検索エンジンに載っている記事を消すと、しばらく検索結果に
 *   404が残る。**一時的に隠したいだけなら、直してから戻すほうがよい。**
 *
 * ■ 反映のされ方
 * `main` に push すると Cloudflare Pages が自動でビルドし直す（DEPLOY.md）。
 * つまり**このコマンド単体では何も起きない。commit と push まで済ませて反映される。**
 *
 * ■ 手で書き換えてもよい
 * やっていることは1行の書き換えなので、GitHub の画面で
 * 記事の `.md` を開いて `draft: true` を足しても同じ。
 * このコマンドは「YAMLを壊さずに」「一覧から選んで」やるためのもの。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const POSTS_DIR = join('site', 'src', 'content', 'posts')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

/** frontmatter の本文（最初の `---` と次の `---` のあいだ）を取り出す */
function frontmatter(md: string): { start: number; end: number } | undefined {
  if (!md.startsWith('---')) return undefined
  const first = md.indexOf('\n')
  const end = md.indexOf('\n---', first)
  if (first < 0 || end < 0) return undefined
  return { start: first + 1, end: end + 1 }
}

function readDraft(block: string): boolean {
  return /^draft:\s*true\s*$/m.test(block)
}

/**
 * frontmatter の `draft` を書き換える。行が無ければ末尾に足す。
 *
 * ★ YAML を組み立て直さない。**1行だけを触る。**
 *   パースして書き戻すと、引用符やコメントの体裁が変わって
 *   関係のない差分が出る（記事は機械が生成したものだが、人も読む）。
 */
function setDraft(block: string, value: boolean): string {
  const line = `draft: ${value}`
  if (/^draft:\s*.*$/m.test(block)) return block.replace(/^draft:\s*.*$/m, line)
  return block.endsWith('\n') ? `${block}${line}\n` : `${block}\n${line}\n`
}

async function listPosts(): Promise<void> {
  const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith('.md')).sort()
  let hidden = 0
  console.log(`記事 ${files.length}本\n`)
  console.log('  状態      スラッグ')
  console.log('  ' + '-'.repeat(60))
  for (const f of files) {
    const md = await readFile(join(POSTS_DIR, f), 'utf8')
    const fm = frontmatter(md)
    const isDraft = fm ? readDraft(md.slice(fm.start, fm.end)) : false
    if (isDraft) hidden++
    // ★ 全角は2桁ぶんの幅を取るので、文字数ではなく**表示幅**で揃える
    const state = isDraft ? '非公開' : '公開'
    const pad = ' '.repeat(Math.max(1, 10 - state.length * 2))
    console.log(`  ${state}${pad}${f.replace(/\.md$/, '')}`)
  }
  console.log(`\n公開 ${files.length - hidden}本 / 非公開 ${hidden}本`)
  console.log('\n非公開にする: npm run unpublish -- --slug <スラッグ>')
  console.log('公開に戻す:   npm run publish   -- --slug <スラッグ>')
}

async function main(): Promise<void> {
  if (flag('list') || (!arg('slug') && !flag('slug'))) {
    if (!flag('list')) console.log('--slug が指定されていないので一覧を出します。\n')
    await listPosts()
    return
  }

  // npm run publish なら公開に戻す。unpublish なら隠す。
  const draft = !flag('show')
  const slug = arg('slug')!.replace(/\.md$/, '')
  const path = join(POSTS_DIR, `${slug}.md`)

  let md: string
  try {
    md = await readFile(path, 'utf8')
  } catch {
    console.error(`記事が見つかりません: ${path}`)
    console.error('スラッグを確認するには: npm run unpublish -- --list')
    process.exit(1)
  }

  const fm = frontmatter(md)
  if (!fm) {
    console.error(`frontmatter が読めません: ${path}`)
    process.exit(1)
  }

  const block = md.slice(fm.start, fm.end)
  const before = readDraft(block)
  if (before === draft) {
    console.log(`すでに${draft ? '非公開' : '公開'}です: ${slug}`)
    return
  }

  await writeFile(path, md.slice(0, fm.start) + setDraft(block, draft) + md.slice(fm.end), 'utf8')
  console.log(`${draft ? '非公開にしました' : '公開に戻しました'}: ${slug}`)
  console.log('')
  console.log('★ まだサイトには反映されていません。commit して push すると')
  console.log('  Cloudflare Pages が自動でビルドし直します（DEPLOY.md）。')
  console.log('')
  console.log(`  git add site/src/content/posts/${slug}.md`)
  console.log(`  git commit -m "chore(posts): ${slug} を${draft ? '非公開に' : '公開に'}する"`)
  console.log('  git push')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
