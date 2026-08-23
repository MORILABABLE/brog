// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { loadEnv } from 'vite'
import { SITE } from './src/config.ts'
import { rehypeAffiliate } from './plugins/rehype-affiliate.ts'

// astro.config は Astro が .env を読み込む前に評価されるため、
// ここでは import.meta.env が使えない。Vite の loadEnv で明示的に読む。
// （コンポーネント側は従来どおり import.meta.env.PUBLIC_* でよい）
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '')

export default defineConfig({
  // 独自ドメイン取得後にここを差し替える。
  // sitemap / RSS / canonical URL がこの値を基準に生成される。
  site: SITE.url,
  integrations: [sitemap()],

  // 比較表の横スクロールは rehype プラグインではなく CSS で処理している
  // （styles/global.css の .prose table を参照）。
  markdown: {
    // ★ rehypePlugins は Astro 7 で @deprecated。動くが将来のメジャーで消える。
    //   移行先は markdown.processor に @astrojs/markdown-remark の
    //   unified({ rehypePlugins }) を渡す形。詳細は docs/AFFILIATE.md。
    //
    //   本文のリンクにトラッキングIDと rel="sponsored" を付ける。
    //   IDを記事に焼き込まないのは、変更のたびに全記事を再生成したくないため。
    rehypePlugins: [[rehypeAffiliate, { amazonTag: env.PUBLIC_AMAZON_TAG ?? '' }]],
  },

  build: {
    // 記事URLを /posts/xxx/ ではなく /posts/xxx にする
    format: 'file',
  },
})
