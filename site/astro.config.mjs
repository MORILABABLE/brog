// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { SITE } from './src/config.ts'

export default defineConfig({
  // 独自ドメイン取得後にここを差し替える。
  // sitemap / RSS / canonical URL がこの値を基準に生成される。
  site: SITE.url,
  integrations: [sitemap()],

  // 比較表の横スクロールは rehype プラグインではなく CSS で処理している
  // （styles/global.css の .prose table を参照）。
  // Astro 7 の既定 Markdown プロセッサは unified ベースではないため、
  // 表を包むためだけに @astrojs/markdown-remark を追加するのは割に合わない。
  build: {
    // 記事URLを /posts/xxx/ ではなく /posts/xxx にする
    format: 'file',
  },
})
