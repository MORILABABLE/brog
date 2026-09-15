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
    /**
     * 記事のジャンル。**入っているものを全部並べる**（本数の多い順）。
     *
     * ★ site/src/config.ts の GENRES と
     *   theme-packs/streaming-jp/genres.ts の `GenreKey` の**3つを揃えること。**
     *   パイプラインが書き込む値がここを通る。ずれればビルドが落ちる（それが検知の仕組み）。
     *
     * ★ **1つに絞らない**（2026-09-15 に単数の `genre` から変えた）。
     *   「Netflixで配信開始の作品199本」はアニメも洋画も邦画も含んでいるので、
     *   1つだけ名乗らせると読者に嘘をつくことになる。かといって何も名乗らないと、
     *   **32本中29本がジャンルのバッジを持たない**状態になり、読者は一覧で
     *   「何を観る話か」をタイトルから読み取るしかなかった。
     *   入っているものを全部並べれば嘘にならず、全記事に付けられる。
     *   数え方と足切りは theme-packs/streaming-jp/genres.ts の `summarizeGenres()`。
     *
     * ★ **空を許してある。** 収集データと1本も突き合わなかった記事では空になる
     *   （実測では0本。将来ありうる）。そのときはバッジが出ないだけで、
     *   記事そのものは公開できる。ここで止めると、書き上がった記事が
     *   ジャンルを数えられないというだけで公開できなくなる。
     */
    genres: z.array(z.enum(['anime', 'western', 'japanese'])).default([]),
    /**
     * 詳細ジャンル（「洋画(SF)」の括弧の中）。**強制ではない。**
     *
     * ★ **基本ジャンルが1つの記事だけが持つ。** アニメも洋画も混ざる記事に
     *   詳細を1つ足しても、どのジャンルの詳細なのかが読者に分からない。
     * ★ ここだけ**表示する文字そのもの**を入れている（キーではない）。
     *   語彙は theme-packs/streaming-jp/genres.ts の `DETAIL_LABELS` が持つ。
     *   基本ジャンルと違って一覧ページも導線も作らないので、
     *   サイト側にキーと label の対応表をもう1つ置く意味が無い。
     */
    genreDetail: z.string().max(12).optional(),
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
