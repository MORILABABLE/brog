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
    /** 下書き。true の記事は本番ビルドに含めない。 */
    draft: z.boolean().default(false),
  }),
})

export const collections = { posts }
