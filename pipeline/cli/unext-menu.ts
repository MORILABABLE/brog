/**
 * U-NEXT のジャンルとカテゴリのIDを調べる。
 *
 *   npm run unext:menu              全ジャンルを調べて theme.yaml 用の YAML を出す
 *   npm run unext:menu -- --raw     カテゴリ一覧をそのまま表示する
 *   npm run unext:menu -- --genre MNU0000131
 *
 * ■ なぜ要るか
 * `npm run catalogs` が Streaming Availability API に対してやっているのと同じこと。
 * theme.yaml に書くIDが実在するか、名前が変わっていないかを、
 * 手で確かめられるようにしておく。ID がずれると収集が静かに空振りする。
 *
 * ブラウザを開くので1ジャンルにつき1ページ。全ジャンルでも11ページ。
 */
import { PoliteBrowser } from '../sources/browser.ts'
import { UnextSource, type UnextCategory, type UnextConfig } from '../sources/unext.ts'

/**
 * 映像ジャンルの一覧。https://video.unext.jp/search/top で確認できる。
 * 書籍とスポーツは対象外（記事にしないため）。
 */
const GENRES: { key: string; id: string }[] = [
  { key: 'youga', id: 'MNU0000131' },
  { key: 'houga', id: 'MNU0000132' },
  { key: 'kaigai-drama', id: 'MNU0000133' },
  { key: 'asia-drama', id: 'MNU0000134' },
  { key: 'kokunai-drama', id: 'MNU0000135' },
  { key: 'anime', id: 'MNU0000136' },
  { key: 'kids', id: 'MNU0000137' },
  { key: 'tv-entame', id: 'MNU0000138' },
  { key: 'news', id: 'MNU0000832' },
  { key: 'music', id: 'MNU0000833' },
  { key: 'stage', id: 'MNU0011140' },
]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * theme.yaml に書くのはこの2つ。IDは連番ではないので拾い方を決めておく。
 *
 * **名前では拾わない。** ジャンルごとに呼び方が違うため
 * （キッズは「ぜんぶ」「あたらしい」、音楽は「すべての音楽作品」「新規入荷の音楽作品」）。
 * かわりに構造で拾う。11ジャンルすべてでこの規則が成り立つことを確認済み。
 *
 *   all      … カテゴリ一覧の先頭（＝そのジャンルの全作品）
 *   arrivals … 既定の並び順が PUBLIC_START_DESC の最初のもの（＝新規入荷）
 */
function pickAll(categories: UnextCategory[]): UnextCategory | undefined {
  return categories[0]
}

function pickArrivals(categories: UnextCategory[]): UnextCategory | undefined {
  return categories.find((c) => c.defaultSortOrder === 'PUBLIC_START_DESC')
}

async function main(): Promise<void> {
  const raw = process.argv.includes('--raw')
  const only = arg('genre')
  const targets = only ? [{ key: 'adhoc', id: only }] : GENRES

  const browser = new PoliteBrowser()
  // 設定は使わないが、ブラウザ層を共有するために最小構成で組み立てる
  const cfg: UnextConfig = {
    service_key: 'u-next',
    label: 'U-NEXT',
    genres: [],
    arrivals_pages: 1,
    expiring_pages: 1,
    expiring_horizon_days: 45,
    min_interval_ms: 2500,
  }
  const source = new UnextSource(cfg, browser)

  const rows: {
    key: string
    id: string
    label: string
    arrivals?: UnextCategory
    all?: UnextCategory
  }[] = []

  try {
    for (const g of targets) {
      const { name, categories } = await source.listCategories(g.id)

      if (raw) {
        console.log(`\n${g.id}  ${name}`)
        for (const c of categories) console.log(`  ${c.id}  ${c.name}  [${c.defaultSortOrder}]`)
      }

      rows.push({
        key: g.key,
        id: g.id,
        label: name,
        arrivals: pickArrivals(categories),
        all: pickAll(categories),
      })
    }
  } finally {
    await browser.close()
  }

  const missing = rows.filter((r) => !r.arrivals || !r.all)

  if (!raw) {
    console.log('# theme.yaml の unext.genres にそのまま貼れる形\n')
    console.log('  genres:')
    for (const r of rows) {
      if (!r.arrivals || !r.all) continue
      console.log(`    - key: ${r.key}`)
      console.log(`      label: ${r.label}`)
      console.log(`      id: ${r.id}`)
      console.log(`      arrivals: ${r.arrivals!.id}   # ${r.arrivals!.name}`)
      console.log(`      all: ${r.all!.id}        # ${r.all!.name}`)
    }
  }

  if (missing.length) {
    console.log('\n--- 取れなかったジャンル ---')
    for (const r of missing) {
      const lack = [!r.arrivals && '新規入荷', !r.all && '全作品'].filter(Boolean)
      console.log(`  ${r.id} ${r.label || '(名称不明)'}: ${lack.join(' / ')} が見つからない`)
    }
    console.log('メニューの構造が変わった可能性がある。--raw で実際の一覧を見ること。')
  }

  console.log(`\n開いたページ: ${browser.pageViews}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
