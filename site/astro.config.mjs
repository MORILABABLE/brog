// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { loadEnv } from 'vite'
import { SITE } from './src/config.ts'
import { lastmodFor } from './src/lib/lastmod.ts'
import { noindexPersonPaths } from './src/lib/people.ts'
import { rehypeAffiliate } from './plugins/rehype-affiliate.ts'
import { rehypeWorkLinks } from './plugins/rehype-work-links.ts'

// astro.config は Astro が .env を読み込む前に評価されるため、
// ここでは import.meta.env が使えない。Vite の loadEnv で明示的に読む。
// （コンポーネント側は従来どおり import.meta.env.PUBLIC_* でよい）
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '')

/**
 * 索引から外したページのパス。**XMLサイトマップから落とす**（下の filter）。
 * 中身は src/lib/people.ts が決める（`INDEX_MIN_WORKS`）。
 */
const NOINDEX_PATHS = new Set(noindexPersonPaths())

/**
 * 枠別のAmazonトラッキングid（rehype プラグイン用）。
 *
 * ★ **src/config.ts の AMAZON_TAGS と同じ環境変数を読んでいる。**
 *   astro.config は Astro が .env を読む前に評価されるため import.meta.env が使えず、
 *   loadEnv でもう一度組み立てるしかない（GA・LinkSwitch と同じ事情）。
 *   **変数名を変えるときは両方直すこと。** 片方だけだと、
 *   記事本文のリンクだけ古い枠のIDのまま公開される。
 *
 * 記事本文から出るのは3種類だけなので、ここで要るのもその3つと既定。
 *   poster … 節ごとの作品ポスター（`<a>` の中身が /sections/ の画像）
 *   table  … 表の作品名（rehypeWorkLinks が付ける .work-link）
 *   body   … それ以外の本文中のリンク
 */
const amazonTags = {
  default: env.PUBLIC_AMAZON_TAG ?? '',
  poster: env.PUBLIC_AMAZON_TAG_POSTER ?? '',
  table: env.PUBLIC_AMAZON_TAG_TABLE ?? '',
  body: env.PUBLIC_AMAZON_TAG_BODY ?? '',
}

export default defineConfig({
  // 独自ドメイン取得後にここを差し替える。
  // sitemap / RSS / canonical URL がこの値を基準に生成される。
  site: SITE.url,
  integrations: [
    sitemap({
      /*
       * `/sitemap`（人が見るサイトマップ）と、**索引から外した人物ページ**を
       * XMLサイトマップから外す。
       *
       * ★ **noindex のページをサイトマップに載せないこと**（2026-09-03）。
       *   載せると Search Console に「noindex のURLを送信しました」が
       *   114件ぶん出続ける。閾値と理由は src/lib/people.ts の `INDEX_MIN_WORKS`。
       *   **人物ページ側の noindex とここは必ず一緒に直すこと。**
       *   （サービス別ページの noindex は少数なので従来どおり載せたままにしてある。
       *     lib/service-pages.ts の `serviceHasContent()` の注意書き）
       *
       *
       * あれは運営者が全ページを目視するためのページで、読者向けではない。
       * 載せると2つ困る。
       *   1. 検索エンジンにとっての発見経路になる（サイト内リンクを外した意味が消える）
       *   2. ページ側が noindex なので、Search Console に
       *      「noindex のURLを送信しました」の注意が出続ける
       *
       * ★ `/sitemap-index.xml` `/sitemap-0.xml` を巻き込まないこと。
       *   `startsWith('/sitemap')` で書くと**XMLサイトマップ自身が消える**。
       *   末尾一致（`/sitemap` で終わるURLだけ）で判定する。
       *
       * ★ 読者にも出すことにしたら、ここと components/Footer.astro の
       *   リンク、pages/sitemap.astro の noindex を**3つまとめて**外すこと。
       */
      filter: (page) => {
        if (/\/sitemap\/?$/.test(page)) return false
        return !NOINDEX_PATHS.has(new URL(page).pathname.replace(/\/$/, ''))
      },
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
      rehypeWorkLinks,
      [rehypeAffiliate, { tags: amazonTags }],
    ],
  },

  build: {
    // 記事URLを /posts/xxx/ ではなく /posts/xxx にする
    format: 'file',
  },
})
