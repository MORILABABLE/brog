/**
 * XMLサイトマップから **`noindex` のページを落とす** Astro インテグレーション。
 *
 * ■ なぜコードではなく出力を見るのか
 * 「noindex にするか」はページごとに散らばっている（人物ページの本数、
 * サービス別ページの中身、月×サービスの記事数、`/category/<ハブ>` の空判定…）。
 * それを astro.config 側でもう一度計算すると、**片方を直して片方を忘れる**。
 * 実際 2026-09-10 の実測で `/category/ranking` が noindex のままサイトマップに載っており、
 * Search Console に「送信されたURLに noindex タグが追加されています」が出ていた。
 *
 * ここは**ビルドし終えた HTML を読む**。`<meta name="robots" content="noindex">` が
 * 入っていれば、そのURLをサイトマップから消す。判定の出どころが1つなので、
 * 新しく noindex のページを増やしても**ここは直さなくてよい**。
 *
 * ★ `integrations` の並びで **`sitemap()` より後ろ**に置くこと。
 *   `astro:build:done` は配列順に走る。前に置くと、まだ書かれていない
 *   `sitemap-0.xml` を読むことになり、何も消さずに素通りする。
 *
 * ★ 消すのはサイトマップからだけ。**ページ自体は残る。**
 *   ヘッダーのメニューの行き先を404にしないため（lib/service-pages.ts の注意書き）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ビルド結果のパス → 公開URLのパス。**BaseLayout の `toPublicPath()` と同じ規則。**
 * `rel` は `/` 区切りで渡ってくる（`htmlFiles()` が `path.join` を使わない理由）。
 */
function toPublicPath(rel: string): string {
  const p = '/' + rel
  if (p === '/index.html') return '/'
  return p.replace(/index\.html$/, '').replace(/\.html$/, '')
}

/**
 * `dir` 配下の `.html` を再帰で集める（相対パスで返す）。
 *
 * ★ **`path.join` で繋がないこと。** Windows では区切りが `\` になり、
 *   そのまま公開URLのパスにすると `/person\abc` のような文字列ができて
 *   サイトマップの `<loc>` と**一致しなくなる**（2026-09-10 にこれで
 *   人物ページ160件が消し損ねになった）。ここは常に `/` で繋ぐ。
 *   `readdirSync` は Windows でも `/` 区切りのパスを受け付ける。
 */
function htmlFiles(root: string, sub = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...htmlFiles(root, rel))
    else if (entry.name.endsWith('.html')) out.push(rel)
  }
  return out
}

export function pruneSitemap() {
  return {
    name: 'prune-sitemap',
    hooks: {
      'astro:build:done': ({ dir, logger }: { dir: URL; logger: { info: (m: string) => void } }) => {
        const root = fileURLToPath(dir)

        // 1. noindex のページを集める
        const noindex = new Set<string>()
        for (const rel of htmlFiles(root)) {
          const html = readFileSync(join(root, rel), 'utf8')
          // BaseLayout が出す形（`content="noindex,follow"` など）だけを見る
          if (/<meta\s+name="robots"\s+content="noindex/i.test(html)) {
            noindex.add(toPublicPath(rel))
          }
        }

        // 2. サイトマップから該当の <url> を落とす
        let removed = 0
        for (const name of readdirSync(root)) {
          if (!/^sitemap-\d+\.xml$/.test(name)) continue
          const file = join(root, name)
          const xml = readFileSync(file, 'utf8')
          const next = xml.replace(/<url>.*?<\/url>/g, (block) => {
            const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1]
            if (!loc) return block
            // `<loc>` は絶対URL。ルートだけ末尾のスラッシュが無い形で出る
            const path = new URL(loc).pathname.replace(/\/$/, '') || '/'
            if (!noindex.has(path)) return block
            removed++
            return ''
          })
          if (next !== xml) writeFileSync(file, next)
        }

        logger.info(`noindex ${noindex.size}枚のうち ${removed}件をサイトマップから外した`)
      },
    },
  }
}
