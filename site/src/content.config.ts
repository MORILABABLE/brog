import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

/**
 * 記事コレクション。
 *
 * schema は品質ゲートでもある。パイプライン(P2)が生成する記事が
 * この形を満たさなければビルドが落ちるので、壊れた記事は公開されない。
 */
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string().min(10),
    description: z.string().min(30).max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    // pipeline/core/article.ts の Category と揃えること
    category: z.enum(['leaving', 'arrivals', 'ranking', 'ended']),
    tags: z.array(z.string()).default([]),
    /** 出典。API利用規約の帰属表示義務を満たすため必須。 */
    sources: z
      .array(z.object({ label: z.string(), url: z.string().url() }))
      .min(1),
    /** 配信情報の基準日。配信状況は変わるので必ず明示する。 */
    dataAsOf: z.coerce.date(),
    /**
     * 記事カードの左サムネイルと、記事ページのヘッダーに使う画像。
     * `public/` からの絶対パス（例: `/posters/xxxx.jpg`）。
     *
     * ★ `npm run sections -- --write` が自動で入れる（2026-08-25〜）。
     *   選び方は「記事タイトルと一致する作品」→「記事に最初に出てくる作品」。
     *   **ここに書いてある値が最優先**で、別のパスを書けば自動処理は触らない。
     *   未設定でもレイアウトは崩れず、カテゴリ色のタイルになる。
     *   詳細は docs/APPEARANCE.md の12節。
     *
     * ★ 生成物の `/cards/<スラッグ>.jpg` は**使わない**。
     *   あれは記事タイトルを焼き込んだSNS共有用の画像で、
     *   見出しの上に置くとタイトルが二重に出る。正方形に切ると文字が切れる。
     */
    heroImage: z.string().optional(),
    /** 下書き。true の記事は本番ビルドに含めない。 */
    draft: z.boolean().default(false),
  }),
})

export const collections = { posts }
