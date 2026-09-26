/**
 * 更新したページを IndexNow で Bing などへ知らせる。**読むのは本番のサイトマップだけ。サイトには何も出さない。**
 *
 *   npm run indexnow                   サイトマップの <lastmod> が前日以降のURLを送る
 *   npm run indexnow -- --all          サイトマップの全URLを送る（初回・大きく作り替えたとき）
 *   npm run indexnow -- --dry-run      送らずに一覧だけ出す
 *
 * ■ なぜ要るか（2026-09-26 追加）
 * 2026-09-23 に Google の表示が約9割消えたが、**Bing と AI（ChatGPT など）経由は1本も減らなかった**。
 * 崖の前（9/1〜9/22）でも Google（Yahoo を含む）が約66%で、入口が1つに寄っていた。
 * ChatGPT の検索は Bing の索引を使うので、Bing に早く載せることが AI 経由を増やす近道でもある。
 * 経緯は docs/INDEXING.md 7節。
 *
 * ■ IndexNow とは
 * 「このURLが変わった」を検索エンジンへ直接知らせる仕組み。1回送れば参加している
 * 検索エンジン（Bing・Yandex・Seznam・Naver など）に共有される。**Google は参加していない。**
 * 送り主の確認は、サイトの直下に置いた鍵のファイル（`site/public/<KEY>.txt`）で行われる。
 * ★ 鍵は**秘密ではない**（誰でも読める場所に置く決まり）。
 *
 * ■ 何を送るか
 * 本番のサイトマップの `<lastmod>` を見る。**付け方は src/lib/lastmod.ts の1か所**で、
 * 中身が変わったときだけ日付が動く。noindex のページはサイトマップに載らない（prune-sitemap）ので、
 * ここから送られることもない。
 * ★ 前日以降を送るので、同じURLが2日続けて送られることがある。IndexNow は重複を咎めない。
 *   「送り漏れ」のほうが困る（ビルドがその日の実行より遅れた日の分を次の日に拾える）。
 * ★ `<lastmod>` の無いページ（/about など）は `--all` のときだけ送る。
 */

const SITE = process.env.INDEXNOW_SITE ?? 'https://mihoudairader.com'
/** `site/public/<KEY>.txt` と同じ値。**変えるときはファイル名と中身も一緒に変える。** */
const KEY = '2601986730646cd18484881794802735'
const ENDPOINT = 'https://api.indexnow.org/indexnow'
/** 1回の POST の上限（IndexNow の仕様） */
const MAX_PER_POST = 10_000

const all = process.argv.includes('--all')
const dryRun = process.argv.includes('--dry-run')

interface Entry {
  loc: string
  lastmod?: string
}

async function text(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'brog-indexnow' } })
  if (!res.ok) throw new Error(`${url} が ${res.status}`)
  return res.text()
}

/** サイトマップの索引から、全部の `<url>` を集める */
async function sitemapEntries(): Promise<Entry[]> {
  const index = await text(`${SITE}/sitemap-index.xml`)
  const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
  const out: Entry[] = []
  for (const map of maps) {
    const xml = await text(map)
    for (const m of xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)) {
      out.push({ loc: m[1]!, lastmod: m[2] })
    }
  }
  return out
}

/** 前日（JST）の `YYYY-MM-DD` */
function yesterdayJst(): string {
  return new Date(Date.now() + 9 * 3_600_000 - 86_400_000).toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  /*
   * ★ **鍵のファイルが本番に出ていなければ送らない。** 送っても 403 で弾かれ、
   *   続けると送り主として疑われる。鍵を足したコミットがまだデプロイされていないときに起きる。
   */
  const live = await text(`${SITE}/${KEY}.txt`).catch(() => '')
  if (live.trim() !== KEY) {
    throw new Error(`鍵のファイル ${SITE}/${KEY}.txt が本番で読めません。デプロイを待ってから再実行してください`)
  }

  const entries = await sitemapEntries()
  const since = yesterdayJst()
  const urls = all
    ? entries.map((e) => e.loc)
    : entries.filter((e) => e.lastmod && e.lastmod.slice(0, 10) >= since).map((e) => e.loc)

  console.log(`サイトマップ ${entries.length}件 → 送る ${urls.length}件（${all ? '全部' : `${since} 以降に更新`}）`)
  for (const u of urls.slice(0, 20)) console.log(`  ${u}`)
  if (urls.length > 20) console.log(`  …ほか${urls.length - 20}件`)
  if (urls.length === 0 || dryRun) return

  const host = new URL(SITE).host
  for (let i = 0; i < urls.length; i += MAX_PER_POST) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key: KEY,
        keyLocation: `${SITE}/${KEY}.txt`,
        urlList: urls.slice(i, i + MAX_PER_POST),
      }),
    })
    /*
     * 200 受け付けた ／ 202 受け付けた（鍵の確認はこれから。初回はこちらになる）
     * 400 形式の誤り ／ 403 鍵が合わない ／ 422 URLがこのホストのものではない ／ 429 送りすぎ
     * ★ 403 でも本文が `SiteVerificationNotCompleted` なら**鍵は正しい。** 鍵のファイルを置いた直後は
     *   向こうの確認が終わっておらず、こう返る（2026-09-26 の初回で実際に出た）。時間をおいて送り直せば通る。
     */
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`IndexNow が ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    console.log(`送信しました（${res.status}）`)
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
