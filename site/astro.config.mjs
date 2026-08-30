// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { loadEnv } from 'vite'
import { SITE } from './src/config.ts'
import { lastmodFor } from './src/lib/lastmod.ts'
import { rehypeAffiliate } from './plugins/rehype-affiliate.ts'
import { rehypeWorkLinks } from './plugins/rehype-work-links.ts'

// astro.config は Astro が .env を読み込む前に評価されるため、
// ここでは import.meta.env が使えない。Vite の loadEnv で明示的に読む。
// （コンポーネント側は従来どおり import.meta.env.PUBLIC_* でよい）
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '')

export default defineConfig({
  // 独自ドメイン取得後にここを差し替える。
  // sitemap / RSS / canonical URL がこの値を基準に生成される。
  site: SITE.url,
  integrations: [
    sitemap({
      /*
       * `/sitemap`（人が見るサイトマップ）を**XMLサイトマップから外す。**
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
      filter: (page) => !/\/sitemap\/?$/.test(page),
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
      [rehypeAffiliate, { amazonTag: env.PUBLIC_AMAZON_TAG ?? '' }],
    ],
  },

  build: {
    // 記事URLを /posts/xxx/ ではなく /posts/xxx にする
    format: 'file',
  },
})
