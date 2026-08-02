import rss from '@astrojs/rss'
import { getCollection } from 'astro:content'
import { SITE } from '../config'
import type { APIContext } from 'astro'

export async function GET(context: APIContext) {
  const posts = (await getCollection('posts', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  )

  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site ?? SITE.url,
    // canonical と URL 形式を揃える（既定だと末尾スラッシュが付く）
    trailingSlash: false,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/posts/${post.id}`,
    })),
    customData: '<language>ja</language>',
  })
}
