/**
 * **月を名乗る記事を、その月が過ぎたら名乗り直させる。**
 *
 *   npm run retire            何が変わるかを出すだけ（書き換えない）
 *   npm run retire -- --write 実際に書き換える
 *
 * ■ 何をしているか
 * 記事の frontmatter の `category` と `tags` の**2行だけ**を書き換える。
 * 本文もタイトルも見出しも触らない。理由は `core/retire.ts` の冒頭。
 *
 *   category: 'leaving'                       → category: 'ended'
 *   tags: [..., '配信終了', '2026年8月']       → tags: [..., '配信終了済み', '2026年8月']
 *
 * ■ なぜ人の確認が要らないか
 * 判断材料は frontmatter のタグだけで、**作品も本文も1件も見ない**。
 * `leaving` の `select()` が「対象月に終了」かつ「終了日が未来」で絞っているので、
 * その月が終われば全作品の終了日が過ぎたと確定する。数え直す余地が無い。
 *
 * ■ 何度実行してもよい
 * 対象は「いまより前の月を名乗る記事」全部。すでに直っている記事は差分が出ない。
 * 実行が1回飛んでも次の実行が拾うので、**取りこぼしが溜まらない**。
 *
 * ■ 反映のされ方
 * `npm run publish` と同じで、**このコマンド単体では何も起きない。**
 * commit して push すると Cloudflare Pages がビルドし直す（DEPLOY.md）。
 * 毎月1日に GitHub Actions が自動で回している（`.github/workflows/retire.yml`）ので、
 * 手で実行するのは「いま直したい」ときと、規則を足したあとの確認だけ。
 *
 * ★ **`updatedDate` は足さない。** サイトマップの `lastmod` は `updatedDate` があれば
 *   それを使う（`site/src/lib/lastmod.ts`）。本文が1文字も変わっていないのに
 *   「更新した」と伝えると、鮮度の信号そのものが当てにされなくなる。
 * ★ **frontmatter を組み立て直さない。** `heroImage` も出典も引用符の体裁もそのまま残す
 *   （`--apply` は組み立て直すので画像が消える。あれとは別物）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentYearMonth } from '../core/datetime.ts'
import { POSTS_DIR, readPublishedPosts } from '../core/coverage.ts'
import { retirements, type Retirement } from '../core/retire.ts'
import { loadArticleTypes, loadTheme } from '../theme.ts'

const flag = (name: string) => process.argv.includes(`--${name}`)

/** frontmatter の本文（最初の `---` と次の `---` のあいだ）を取り出す */
function frontmatter(md: string): { start: number; end: number } | undefined {
  if (!md.startsWith('---')) return undefined
  const first = md.indexOf('\n')
  const end = md.indexOf('\n---', first)
  if (first < 0 || end < 0) return undefined
  return { start: first + 1, end: end + 1 }
}

/**
 * `category` の行を書き換える。
 *
 * ★ YAML を読んで書き戻さない。**1行だけを触る**（`cli/publish.ts` と同じ理由）。
 *   組み立て直すと引用符やコメントの体裁が変わり、関係のない差分が出る。
 */
function setCategory(block: string, value: string): string {
  return block.replace(/^category:\s*.*$/m, `category: '${value}'`)
}

/**
 * `tags` の行の中で、タグを1つだけ差し替える。
 *
 * ★ 配列を組み立て直さず、**引用符ごとの文字列置換**にしてある。
 *   並び順も引用符の種類も、他のタグの体裁もそのまま残るため。
 *   `'配信終了'` は `'配信終了済み'` に一致しない（閉じ引用符まで見ている）ので、
 *   2度実行しても二重に置換されない。
 */
function swapTag(block: string, from: string, to: string): string {
  return block.replace(/^tags:\s*.*$/m, (line) =>
    line.replace(`'${from}'`, `'${to}'`).replace(`"${from}"`, `"${to}"`),
  )
}

/** 1本ぶんを書き換える。書き換えたら true。 */
async function apply(r: Retirement): Promise<boolean> {
  const path = join(POSTS_DIR, `${r.post.slug}.md`)
  const md = await readFile(path, 'utf8')
  const fm = frontmatter(md)
  if (!fm) {
    console.error(`  frontmatter が読めません: ${path}`)
    return false
  }

  const before = md.slice(fm.start, fm.end)
  let after = before
  if (r.category !== r.post.category) after = setCategory(after, r.category)
  after = swapTag(after, r.rule.tag, r.rule.becomes)

  if (after === before) {
    // 行の書式が想定と違うと**黙って何も起きない**。それが一番困るので声を上げる
    console.error(`  書き換えられませんでした（frontmatter の形が想定と違います）: ${r.post.slug}`)
    return false
  }

  await writeFile(path, md.slice(0, fm.start) + after + md.slice(fm.end), 'utf8')
  return true
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const types = await loadArticleTypes(theme)
  const posts = await readPublishedPosts(POSTS_DIR)
  const month = currentYearMonth(theme.utc_offset_minutes)

  const targets = retirements(types, posts, month)

  console.log(`いまの月: ${month}　記事 ${posts.length}本`)
  if (targets.length === 0) {
    console.log('名乗り直しが要る記事はありません。')
    return
  }

  console.log(`\n名乗り直しが要る記事 ${targets.length}本\n`)
  console.log('  月        スラッグ                        変わるところ')
  console.log('  ' + '-'.repeat(76))
  for (const r of targets) {
    const changes = [
      r.category !== r.post.category ? `${r.post.category} → ${r.category}` : '',
      `${r.rule.tag} → ${r.rule.becomes}`,
    ].filter(Boolean)
    console.log(`  ${r.month}  ${r.post.slug.padEnd(30)}${changes.join(' / ')}`)
  }

  if (!flag('write')) {
    console.log('\n書き換えるには: npm run retire -- --write')
    return
  }

  console.log('')
  let done = 0
  for (const r of targets) {
    if (await apply(r)) {
      done++
      console.log(`  書き換えました: ${r.post.slug}`)
    }
  }

  console.log(`\n${done}本を書き換えました。`)
  if (done < targets.length) {
    console.error(`${targets.length - done}本は書き換えられませんでした。上の行を確認してください。`)
    process.exit(1)
  }

  console.log('')
  console.log('★ まだサイトには反映されていません。commit して push すると')
  console.log('  Cloudflare Pages が自動でビルドし直します（DEPLOY.md）。')
  console.log('')
  console.log('  cd site && npm run build   ← frontmatter の検証はここで走る')
  console.log('  git add site/src/content/posts/')
  console.log(`  git commit -m "chore(posts): 月が過ぎた記事を配信終了済みにする"`)
  console.log('  git push')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
