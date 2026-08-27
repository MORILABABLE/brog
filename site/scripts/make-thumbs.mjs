/**
 * 表の各行に出す作品サムネイルを用意する。
 *
 * **ビルド時に自動で走る**（package.json の prebuild）。手で実行する必要はない。
 *   node scripts/make-thumbs.mjs              通常
 *   node scripts/make-thumbs.mjs --refresh    キャッシュを無視して取り直す
 *   node scripts/make-thumbs.mjs --no-posters 取得せず全部ジャンル汎用画像にする
 *   node scripts/make-thumbs.mjs --audit      ジャンル名の取りこぼしを一覧する
 *
 * ■ 何のためにあるか
 * 記事も常設ページも、作品は**すべて表に載っている**。
 * その表が文字だけだと、読者は「なんとなく気になった作品」を掴めない。
 * 1行に1枚、小さくても絵があるだけで、行そのものが導線になる。
 * リンク自体を張るのは rehype-work-links.ts と WorkTable.astro の仕事で、
 * ここは**絵を用意するだけ**。
 *
 * ■ 出力（すべて public/thumbs/）
 *   <作品ID>.webp     … 配信APIのポスターを 96×144 に縮めたもの
 *   genre-<key>.webp  … 画像が無い作品に使う、ジャンル別の汎用画像
 *
 * 表示は48×72なので、2倍の96×144で書き出している（高解像度ディスプレイ用）。
 * 大きさを変えるときは THUMB と styles/global.css の `.work-thumb` を**両方**直す。
 *
 * ■ ポスターが無い作品が多い
 * U-NEXT 由来の作品には画像が付いてこない（収集がメニュー経由のため）。
 * 実測で 718件すべてが該当する。**そこがジャンル汎用画像の出番**で、
 * 絵柄と色の定義は scripts/genre-art.mjs にある。
 *
 * ■ 絶対に落ちないこと
 * 画像は取れないことがある（署名切れ・CDN障害・オフライン）。
 * 取れなければジャンル汎用画像に落ちるだけで、**ビルドは止めない。**
 * 取得層(posters.mjs)の方針と同じ。
 */
import sharp from 'sharp'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PosterCache, isPlaceholder, expiryOf, loadManifest, saveManifest } from './posters.mjs'
import { GENRE_ART, genreKeyOf, genreSvg, genreThumbName } from './genre-art.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')
const postsDir = join(root, 'src', 'content', 'posts')
const outDir = join(root, 'public', 'thumbs')
const posterOutDir = join(root, 'public', 'posters')

/**
 * 書き出す1枚の大きさ。表示は48×72で、その2倍。
 * ★ 変えたら styles/global.css の `.work-thumb` も直すこと。
 */
const THUMB = { w: 96, h: 144 }

/**
 * 作品ページ（`/works/<ID>`）に出すポスター。表示は240×360で、その2倍。
 *
 * ★ **取得は増えない。** PosterCache が原本をディスクに持つので、
 *   同じURLに poster() を2回呼んでもネットワークアクセスは1回
 *   （scripts/posters.mjs の original()）。かかるのは変換の時間だけ。
 *
 * ★ 変えたら src/pages/works/[id].astro の `.poster` も直すこと。
 */
const POSTER = { w: 480, h: 720 }

/**
 * 同時に走らせる取得の数。
 * 上げすぎると提供元のCDNに負荷をかける。実測でこのあたりが頭打ち。
 */
const CONCURRENCY = 8

const REFRESH = process.argv.includes('--refresh')
const NO_POSTERS = process.argv.includes('--no-posters')
const AUDIT = process.argv.includes('--audit')

// --- 収集データ -------------------------------------------------------------

/**
 * `data/events/*.jsonl` を読んで、作品IDごとに**最後に観測した内容**を返す。
 * 終了日やジャンルが後から変わることがあるので、古い方を残すと誤情報になる
 * （src/lib/events-data.ts の latestPerWork と同じ考え方）。
 */
function readEvents() {
  const dir = join(repo, 'data', 'events')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s))
      } catch {
        // 壊れた行があっても収集ログ全体を捨てない
      }
    }
  }
  return out
}

/**
 * 作品ページ（`/works/<ID>`）を持つ作品のID。**ポスターを書き出す対象。**
 *
 * ★ **掲載判定の本体は src/lib/works.ts の `isWorkPagePublishable()`。**
 *   ここはそれより**ゆるい条件**（配信API由来 かつ expiring/removed を持つ）に
 *   してある。実測で本体が620件、ここが653件。
 *   スクリプトから .ts を読めないので条件を書き写すことになるが、
 *   **ゆるい側に倒しておけば「ページはあるのに絵が無い」が起きない。**
 *   逆に厳しくすると絵の無いページが出るので、条件を足すときは注意する。
 *
 * ★ U-NEXT を入れないこと。作品ページは配信API由来の作品だけで作る
 *   （理由は docs/GROWTH.md 2-3）。
 */
function workPageIds(events) {
  const API_SERVICES = ['netflix', 'prime-video', 'disney-plus', 'apple-tv']
  const ids = new Set()
  for (const e of events) {
    if (!API_SERVICES.includes(e.service)) continue
    if (e.kind === 'expiring' || e.kind === 'removed') ids.add(String(e.work.id))
  }
  return ids
}

/**
 * サムネイルを用意する作品を決める。
 *
 * ★ 常設ページの条件は src/lib/events-data.ts の loadLeaving / loadArrivals と
 *   **同じものを書き写してある。** サイト側は .astro で、スクリプトからは
 *   読み込めないため（search-links と同じ事情）。
 *   **片方だけ直すと、ページに出るのに絵が無い作品が生まれる。必ず両方直す。**
 *
 * 記事側は表の作品名を突き合わせて拾う。過去の記事もずっと絵が出るように、
 * **公開済みの記事に出てくる作品は期間で切らない。**
 */
function worksToRender(events) {
  const LEAVING_SERVICES = ['netflix', 'prime-video']
  const ARRIVALS_SERVICES = ['netflix', 'prime-video', 'disney-plus']
  const ARRIVALS_WINDOW_DAYS = 60

  const latest = new Map()
  const pageIds = workPageIds(events)
  for (const e of events) {
    const key = String(e.work.id)
    const cur = latest.get(key)
    if (!cur || e.collectedAt > cur.collectedAt) latest.set(key, e)
  }

  const now = Date.now()
  const since = now - ARRIVALS_WINDOW_DAYS * 86_400_000
  const picked = new Map()
  const take = (work) => picked.set(String(work.id), work)

  for (const e of latest.values()) {
    // 作品ページを持つ作品は期間で切らない。**ページがあるのに絵が無い**を防ぐ。
    if (pageIds.has(String(e.work.id))) take(e.work)
    const at = e.at ? Date.parse(e.at) : NaN
    if (!Number.isFinite(at)) continue
    if (e.kind === 'expiring' && LEAVING_SERVICES.includes(e.service) && at >= now) take(e.work)
    if (e.kind === 'new' && ARRIVALS_SERVICES.includes(e.service) && at >= since) take(e.work)
  }

  // 記事の表に出てくる作品。邦題でも原題でも引けるようにしておく。
  const byTitle = new Map()
  for (const e of latest.values()) {
    for (const t of [e.work.localizedTitle, e.work.title]) {
      if (t && !byTitle.has(t)) byTitle.set(t, e.work)
    }
  }
  if (existsSync(postsDir)) {
    for (const f of readdirSync(postsDir).filter((n) => n.endsWith('.md'))) {
      for (const line of readFileSync(join(postsDir, f), 'utf8').split('\n')) {
        if (!line.startsWith('|')) continue
        for (const cell of line.split('|')) {
          const hit = byTitle.get(cell.trim())
          if (hit) take(hit)
        }
      }
    }
  }

  return [...picked.values()]
}

// --- ジャンル名の取りこぼし ---------------------------------------------------

/**
 * 収集データに出てくるジャンル名のうち、genre-art.mjs の aliases に無いものを出す。
 * APIやU-NEXTがジャンルを増やしたときに気づくため。`--audit` でだけ走る。
 */
function audit(works) {
  const known = new Set(GENRE_ART.flatMap((g) => g.aliases))
  const unknown = new Map()
  for (const w of works) {
    for (const g of w.genres ?? []) {
      if (!known.has(g)) unknown.set(g, (unknown.get(g) ?? 0) + 1)
    }
  }
  if (unknown.size === 0) {
    console.log('ジャンル名の取りこぼし: なし')
    return
  }
  console.log('genre-art.mjs の aliases に無いジャンル名:')
  for (const [name, n] of [...unknown].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name} … ${n}件`)
  }
}

// --- 生成 -------------------------------------------------------------------

/** 同時実行数を抑えて回す。Promise.all だと600件が一斉に飛ぶ。 */
async function mapLimit(items, limit, fn) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 使われなくなったサムネイルを消す。
 * 残しても壊れはしないが、public/ に古い作品の絵が溜まり続ける。
 */
function prune(dir, keep) {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.webp') || keep.has(name)) continue
    rmSync(join(dir, name), { force: true })
    removed++
  }
  return removed
}

const events = readEvents()
if (events.length === 0) {
  // 収集前でもビルドは通す。絵の無い表になるだけ。
  console.log('作品サムネイル: 収集データが無いので何も作りません（npm run collect 前？）')
  process.exit(0)
}

const works = worksToRender(events)
if (AUDIT) {
  audit(works)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(posterOutDir, { recursive: true })

/** 作品ページを持つ作品。ポスター（480×720）を書き出す対象。 */
const pageIds = workPageIds(events)

/** public/thumbs に残すファイル名。ここに無いものは prune が消す。 */
const keep = new Set()
/** public/posters に残すファイル名。 */
const keepPosters = new Set()

// --- 1. ジャンル汎用画像（key ごとに1枚だけ） --------------------------------
for (const g of GENRE_ART) {
  const name = genreThumbName(g.key)
  keep.add(name)
  const buf = await sharp(Buffer.from(genreSvg(g.key, THUMB.w, THUMB.h)))
    .webp({ quality: 82 })
    .toBuffer()
  writeFileSync(join(outDir, name), buf)
}

// --- 2. 作品ポスター ---------------------------------------------------------
const posters = NO_POSTERS ? null : new PosterCache(repo, { force: REFRESH })
/** 台帳に載せる作品（refresh:images の対象になる） */
const usedWorks = {}
let made = 0
let madePosters = 0
let fellBack = 0

await mapLimit(works, CONCURRENCY, async (w) => {
  const id = String(w.id)
  const title = w.localizedTitle ?? w.title
  const url = w.posterUrl

  // ポスターが無い／題名を書いただけの代替画像 → ジャンル汎用画像に任せる
  if (!posters || !url || isPlaceholder(url)) {
    fellBack++
    return
  }

  const buf = await posters.poster(url, THUMB.w, THUMB.h, { label: title })
  if (!buf) {
    // 取れなかった。表示側が genre-<key>.webp に落ちるので、ここは何もしない。
    fellBack++
    return
  }

  writeFileSync(join(outDir, `${id}.webp`), buf)
  keep.add(`${id}.webp`)
  usedWorks[id] = { id, title, url, expiresAt: expiryOf(url) }
  made++

  // 作品ページを持つ作品には大きいほうも書く。
  // 原本はキャッシュ済みなので、**ここで新しい取得は起きない**（POSTER の注意書き）。
  if (!pageIds.has(id)) return
  const big = await posters.poster(url, POSTER.w, POSTER.h, { label: title })
  if (!big) return
  writeFileSync(join(posterOutDir, `${id}.webp`), big)
  keepPosters.add(`${id}.webp`)
  madePosters++
})

const removed = prune(outDir, keep)
const removedPosters = prune(posterOutDir, keepPosters)

console.log(
  `作品サムネイル: ${made}枚（対象 ${works.length}作品 / ジャンル汎用に落ちたもの ${fellBack}件）` +
    (removed ? ` / 不要になった ${removed}枚を削除` : ''),
)
console.log(
  `作品ページのポスター: ${madePosters}枚（対象 ${pageIds.size}作品）` +
    (removedPosters ? ` / 不要になった ${removedPosters}枚を削除` : ''),
)
console.log(`ジャンル汎用画像: ${GENRE_ART.length}枚`)

if (posters) {
  posters.report()
  /*
   * 台帳（data/image-manifest.json）。
   *
   * ★ **すぐ前に走った make-sections.mjs の分と合わせて書く。**
   *   あちらは「記事の節に使ったポスター」、こちらは「表に使ったポスター」で、
   *   対象が違う。どちらか片方だけを書くと、書かなかった側の署名が
   *   refresh:images の対象から外れ、半年後に静かに画像が消える。
   *
   * ★ 台帳が増えるぶん、取り直しに必要なリクエストも増える
   *   （対象件数 = リクエスト数。無料枠は500/月）。
   *   `npm run refresh:images` は既定で「期限が90日以内」に絞り、
   *   1回あたり300件で止まるので、数回に分けて回すことになる。
   */
  saveManifest(repo, { ...loadManifest(repo).works, ...usedWorks })
}
