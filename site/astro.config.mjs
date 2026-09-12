// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { loadEnv } from 'vite'
import { SITE } from './src/config.ts'
import { lastmodFor } from './src/lib/lastmod.ts'
import { pruneSitemap } from './plugins/prune-sitemap.ts'
import { rehypeAffiliate } from './plugins/rehype-affiliate.ts'
import { rehypeWorkLinks } from './plugins/rehype-work-links.ts'
import { rehypeAvailability } from './plugins/rehype-availability.ts'
import { rehypeCast } from './plugins/rehype-cast.ts'

// astro.config は Astro が .env を読み込む前に評価されるため、
// ここでは import.meta.env が使えない。Vite の loadEnv で明示的に読む。
// （コンポーネント側は従来どおり import.meta.env.PUBLIC_* でよい）
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '')

/**
 * 枠別のAmazonトラッキングid（rehype プラグイン用）。
 *
 * ★ **src/config.ts の AMAZON_TAGS と同じ環境変数を読んでいる。**
 *   astro.config は Astro が .env を読む前に評価されるため import.meta.env が使えず、
 *   loadEnv でもう一度組み立てるしかない（GA・LinkSwitch と同じ事情）。
 *   **変数名を変えるときは両方直すこと。** 片方だけだと、
 *   記事本文のリンクだけ古い枠のIDのまま公開される。
 *
 * 記事本文から出るのは5種類。
 *   poster … 節ごとの作品ポスター（`<a>` の中身が /sections/ の画像）
 *   table  … 表の作品名（rehypeWorkLinks が付ける .work-link）
 *   avail  … 表の在庫行の ○ / △（rehypeAvailability が付ける .avail-link）
 *   find   … 表の×だけの行の「他で探す」（同 .avail-find-link）
 *   body   … それ以外の本文中のリンク
 */
const amazonTags = {
  default: env.PUBLIC_AMAZON_TAG ?? '',
  poster: env.PUBLIC_AMAZON_TAG_POSTER ?? '',
  table: env.PUBLIC_AMAZON_TAG_TABLE ?? '',
  body: env.PUBLIC_AMAZON_TAG_BODY ?? '',
  // 表の在庫行から出る2種類（plugins/rehype-availability.ts）。
  //   avail … ○ / △ のリンク＝「ここで観られる」という答え
  //   find  … ×だけの行の「他で探す」＝答えが出せなかった行の逃げ先
  // **未設定なら既定IDに落ちる**ので、IDを作ってから .env に足せばよい。
  avail: env.PUBLIC_AMAZON_TAG_AVAIL ?? '',
  find: env.PUBLIC_AMAZON_TAG_FIND ?? '',
}

export default defineConfig({
  // 独自ドメイン取得後にここを差し替える。
  // sitemap / RSS / canonical URL がこの値を基準に生成される。
  site: SITE.url,
  integrations: [
    sitemap({
      /*
       * ★ **noindex のページはサイトマップに載せない。**
       *   載せると Search Console に「送信されたURLに noindex タグが追加されています」が
       *   出続ける（2026-09-03 に人物ページ114件で発生、2026-09-10 に `/category/ranking` で再発）。
       *
       *   **その判定はここに書かない。** noindex を決めているページが多すぎて
       *   （人物・サービス別・月×サービス・カテゴリ・カレンダー・`/sitemap`）、
       *   ここで数え直すと必ず片方を直し忘れる。実際そうなった。
       *   代わりに、ビルドし終えた HTML を読んで落とす
       *   （下の `pruneSitemap()`。plugins/prune-sitemap.ts）。
       *   **新しく noindex のページを増やしても、このファイルは直さなくてよい。**
       */
      /*
       * `<lastmod>` を付ける（2026-08-30）。**分かるページにだけ。**
       *
       * それまで XMLサイトマップは `<loc>` だけで、701件すべてが
       * 「いつ変わったか」を持っていなかった。毎日入れ替わる `/leaving/<サービス>` を
       * 抱えているサイトとしては、ここが空なのは損になる。
       *
       * ★ **全部を「いま」にしない。** 毎回すべてが最新だと検索エンジンが
       *   この値を当てにしなくなる。判断は src/lib/lastmod.ts の1か所。
       */
      serialize: (item) => {
        const lastmod = lastmodFor(item.url)
        return lastmod ? { ...item, lastmod } : item
      },
    }),
    /*
     * ★ **`sitemap()` より後ろに置くこと。** `astro:build:done` は配列順に走るので、
     *   前に置くと、まだ書かれていない `sitemap-0.xml` を読んで何もしない。
     */
    pruneSitemap(),
  ],

  // 比較表の横スクロールは rehype プラグインではなく CSS で処理している
  // （styles/global.css の .prose table を参照）。
  markdown: {
    // ★ rehypePlugins は Astro 7 で @deprecated。動くが将来のメジャーで消える。
    //   移行先は markdown.processor に @astrojs/markdown-remark の
    //   unified({ rehypePlugins }) を渡す形。詳細は docs/AFFILIATE.md。
    //
    //   本文のリンクにトラッキングIDと rel="sponsored" を付ける。
    //   IDを記事に焼き込まないのは、変更のたびに全記事を再生成したくないため。
    //
    // ★ 並び順を入れ替えないこと。
    //   rehypeWorkLinks が表の作品名を <a> にし、rehypeAffiliate が
    //   その <a> に tag= と rel を付ける。逆順にすると、表のリンクだけ
    //   トラッキングIDも rel="sponsored" も付かないまま公開される。
    rehypePlugins: [
      // ★ いちばん先。表の直後の「出演者」の箇条書きを小さな枠にたたむ。
      //   他の3つは表の中しか触らないので依存は無いが、先に畳んでおけば
      //   後段が余計なノードを歩かない。
      rehypeCast,
      rehypeWorkLinks,
      // ★ workLinks のあと・affiliate の前。前段が作った作品名のリンクを読み、
      //   ここで作った ○ / △ のリンクに後段が tag= と rel="sponsored" を付ける。
      rehypeAvailability,
      [rehypeAffiliate, { tags: amazonTags }],
    ],
  },

  build: {
    // 記事URLを /posts/xxx/ ではなく /posts/xxx にする
    format: 'file',
  },
})
