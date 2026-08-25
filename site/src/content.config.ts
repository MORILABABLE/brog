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
     * ★ いまは空。**縦長のポスターは使えない**（ここは 16:7 で切り抜くので、
     *   縦長の絵を入れると中央の帯だけが出て何の作品か分からなくなる）。
     *   要るのは横位置のキーアート（API の `horizontalBackdrop`）で、
     *   2026-08-25 に収集側へ保存を足した。**次回以降の収集で集まる作品**から
     *   パイプラインが入れられるようになる。
     *   未設定でもレイアウトは崩れず、カテゴリ色のタイルになる。
     *   ポスターの許諾と運用は docs/APPEARANCE.md の11節。
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
