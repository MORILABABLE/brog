/**
 * 公開済み記事の frontmatter を**ファイルから**読む。
 *
 * ■ なぜ `astro:content` を使わないのか
 * これを読むのは rehype プラグイン（`plugins/rehype-next-step.ts`）で、
 * **Markdown を描いている最中に動く。** その時点では `getCollection()` が使えない
 * （コンテンツ層はまだ組み上がっていない）。
 * `src/lib/work-links.ts` が `data/` を直接読んでいるのと同じ立場。
 *
 * ★ **画面に出す値をここから取らないこと。** 画面の値は `.astro` 側が
 *   `astro:content` から取る（型が付き、参照の整合も取れる）。
 *   ここが答えるのは「**どの記事へリンクするか**」という1問だけ。
 *
 * ■ frontmatter を YAML として読まない
 * 依存を増やさないため、必要な行だけ正規表現で取る。
 * `pipeline/core/coverage.ts` の `readPublishedPosts()` と同じ方針・同じ書き方で、
 * **あちらが読めるものはこちらも読める**ようにしてある。
 * 記事は `npm run write` が機械的に書くので、書式は揺れない。
 *
 * ■ 1度だけ読む
 * ビルド中に記事が増えることはない。`dev` で記事を足したときは再起動が要るが、
 * **記事を手で足す運用が無い**ので実害が無い（`npm run write -- --apply` を通す）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface IndexedPost {
  /** `/posts/<slug>` の slug */
  slug: string
  title: string
  /** frontmatter の `category`。取れなければ空文字 */
  category: string
  tags: string[]
  /** `YYYY-MM-DD`。取れなければ空文字 */
  pubDate: string
  heroImage: string
  draft: boolean
}

/**
 * 記事の置き場を探す。
 * サイトのビルドは `site/` から走るが、`npm run build` を
 * リポジトリの根から呼ぶこともあるので両方を見る
 * （`src/lib/work-links.ts` の `findUp()` と同じ事情）。
 */
function postsDir(): string | undefined {
  for (const dir of [
    resolve('src', 'content', 'posts'),
    resolve('site', 'src', 'content', 'posts'),
  ]) {
    if (existsSync(dir)) return dir
  }
  return undefined
}

let cache: IndexedPost[] | null = null

/** 公開済み記事（下書きを除く）。読めなければ空配列＝**何も差し込まない**。 */
export function allPosts(): IndexedPost[] {
  if (cache) return cache

  const dir = postsDir()
  if (!dir) return (cache = [])

  const out: IndexedPost[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    let raw: string
    try {
      raw = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    const front = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
    if (/^draft:\s*true\s*$/m.test(front)) continue
    out.push({
      slug: file.replace(/\.md$/, ''),
      // 題名だけは引用符の中に `''`（エスケープされた `'`）が入りうる
      title: (front.match(/^title:\s*'([\s\S]*?)'\s*$/m)?.[1] ?? '').replace(/''/g, "'"),
      category: front.match(/^category:\s*'([^']*)'/m)?.[1] ?? '',
      tags: (front.match(/^tags:\s*\[([^\]]*)\]/m)?.[1] ?? '')
        .split(',')
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
      pubDate: front.match(/^pubDate:\s*['"]?(\d{4}-\d{2}-\d{2})/m)?.[1] ?? '',
      heroImage: front.match(/^heroImage:\s*'([^']*)'/m)?.[1] ?? '',
      draft: false,
    })
  }
  cache = out
  return out
}

/** テスト・`dev` の作り直し用。 */
export function resetPostIndex(): void {
  cache = null
}

/** 月を名乗る記事の slug は `2026-09-…` で始まる（`templates/naming.md`） */
const MONTHLY_SLUG = /^(\d{4})-(\d{2})-/

/**
 * 同じサービス・同じカテゴリの**いちばん新しい月次記事**。
 *
 * ■ 何のためにあるか
 * 保存版（シリーズ記事）を読んだ人の次の一手。
 * 「ハリー・ポッターが Netflix で9月30日に終わる」を読んだ人にとって、
 * **同じ月に同じサービスで終わる他の作品**は次に知りたいことそのもので、
 * かつ**保存版には絶対に載らない**（主題がシリーズ1つに閉じているため）。
 *
 * ★ **月は指定しない。いちばん新しいものを選ぶ。**
 *   保存版は同じURLを書き直し続けるので、月を焼き込むと古いほうを指し続ける。
 *   ビルドのたびに選び直せば、翌月の記事が出た時点で自動的に移る。
 *
 * @param service リンク先が名乗っているサービスのタグ（`Netflix` など）
 * @param category `leaving` / `ended` / `arrivals`
 */
export function latestMonthlyPost(
  service: string,
  category: string,
  exclude: string,
): IndexedPost | undefined {
  const monthly = allPosts().filter((p) => MONTHLY_SLUG.test(p.slug))

  /*
   * ★ **サイトが持っている最新の月**より古いものへは送らない（2026-09-15）。
   *
   *   保存版はいつまでも読まれるのに、送り先が先月の月次記事だと
   *   「もう終わった作品の一覧」へ送ることになる。
   *   実測で `ultraman` → `2026-08-leaving-u-next`、`conan-movies` → `2026-08-leaving`
   *   のように過去月へ向いた。**無いなら出さないほうがよい**（B だけが残る）。
   *
   * ★ 「今月」ではなく「**記事がある最新の月**」で見る。
   *   月初は当月の記事がまだ書かれていないことがあり（`npm run write` は人が回す）、
   *   今月で切ると月初だけリンクが全部消える。
   */
  const newest = monthly.map((p) => p.slug.slice(0, 7)).sort().at(-1)
  if (!newest) return undefined

  return monthly
    .filter(
      (p) =>
        p.slug !== exclude &&
        p.slug.startsWith(newest) &&
        p.category === category &&
        p.tags.includes(service),
    )
    /*
     * ★ 同じ月に複数あるときは**新しく書かれたほう**。
     *   slug の辞書順で選ぶと `2026-09-upcoming-…` が `2026-09-arrivals-…` に
     *   勝つだけで、意味のある順序にならない。
     */
    .sort((a, b) => b.pubDate.localeCompare(a.pubDate) || b.slug.localeCompare(a.slug))[0]
}

/** slug から1本引く */
export function postBySlug(slug: string): IndexedPost | undefined {
  return allPosts().find((p) => p.slug === slug)
}
