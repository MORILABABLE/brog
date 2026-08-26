/**
 * 「この作品をクリックしたら、どこへ送るか」を決める1か所。
 *
 * ■ なぜ1か所に集めるか
 * 作品への導線は3つの経路で出る。**送り先がずれると成果計測もずれる。**
 *   記事本文の表   … plugins/rehype-work-links.ts（ビルド時にリンクを張る）
 *   常設ページの表 … components/WorkTable.astro
 *   節のポスター   … scripts/posters.mjs の posterLink()（Amazon検索のみ）
 *
 * ■ 収集データに「作品ページの直リンク」が入っている
 * 配信API は作品ごとに、そのサービス上の作品ページURLを返す
 * （`work.link`。pipeline/sources/streaming-availability.ts で保存している）。
 * 実測で 1,849件中 1,671件（90%）が持っており、U-NEXT は 723件すべてが持つ。
 * **検索結果ページへ送るより1クリック短い。** これを第一候補にする。
 *
 * ■ ただし直リンクが常に得とは限らない（下の resolveUrl の判断）
 *   app.primevideo.com … Amazonアソシエイトの tag= が乗らない。**成果が出ない。**
 *                        同じ作品でも amazon.co.jp/gp/video/detail 形式なら乗る。
 *                        乗らない形式のときは Amazon のビデオ内検索へ落とす。
 *   配信終了済み(removed) … その作品ページはもう見放題ではない。
 *                        リンクは生きているが読者の期待とずれるので検索へ落とす。
 *
 * ■ アフィリエイト化はここではやらない
 * tag= と rel は build 時に rehype-affiliate が一括で付ける（src/lib/affiliate.ts）。
 * ここは**URLを決めるだけ**。ID を記事にもコンポーネントにも焼き込まない。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { genreKeyOf, genreThumbName } from '../../scripts/genre-art.mjs'
import { isPublishable } from './excluded'

/** サムネイルの公開パスの根。scripts/make-thumbs.mjs の出力先と揃える。 */
const THUMB_BASE = '/thumbs'

export interface WorkLink {
  workId: string
  /** 表示に使う題名（邦題優先） */
  title: string
  /** 送り先。**必ず1つ決まる**（直リンクが無くても検索URLに落ちる） */
  url: string
  /** サムネイルの src。用意されていなければ undefined（絵を出さない） */
  thumb?: string
}

// --- 収集データ ---------------------------------------------------------------

interface RawWork {
  id: number | string
  title: string
  localizedTitle?: string
  genres?: string[]
  link?: string
  posterUrl?: string
}

interface RawEvent {
  collectedAt: string
  service: string
  kind: string
  work: RawWork
}

/**
 * `data/events` を探す。
 *
 * ★ `import.meta.url` からの相対解決は使えない。Astro はビルド時にこのファイルを
 *   チャンクへバンドルするので、位置がソースと変わる（events-data.ts と同じ事情）。
 *   実行時のカレントから上へ辿る。
 */
function findUp(...segments: string[]): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

// --- 送り先の決定 -------------------------------------------------------------

/** サービスの作品ページとして、そのまま送ってよいホスト。 */
const DIRECT_HOSTS = [
  // Amazon。**この形式だけ tag= が乗る**（app.primevideo.com は乗らない）
  'www.amazon.co.jp',
  'amazon.co.jp',
  // 提携先が無いので収益にはならないが、読者にとっては最短の行き先
  'www.netflix.com',
  'www.disneyplus.com',
  'tv.apple.com',
  // バリューコマース LinkSwitch がブラウザ側でアフィリエイト化する
  'video.unext.jp',
  'www.hulu.jp',
]

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : null
  } catch {
    return null
  }
}

/**
 * Amazon のビデオ内検索。直リンクが使えないときの共通の逃げ先。
 *
 * 見放題ではなく**レンタル・購入**の売り場に当たる。
 * 見放題が終わった作品でも買えば観られることが多く、これは事実として言える。
 * tag= は付けない（build 時に rehype-affiliate が付ける）。
 */
export function amazonSearchUrl(title: string): string {
  const q = title.replace(/[/／]/g, ' ').replace(/\s+/g, ' ').trim()
  return `https://www.amazon.co.jp/s?k=${encodeURIComponent(q)}&i=instant-video`
}

/**
 * 作品1つぶんの送り先。
 *
 * @param work 収集データの work
 * @param kind その作品の最後のイベント種別（`removed` なら見放題は終わっている）
 */
export function resolveUrl(work: RawWork, kind: string): string {
  const title = work.localizedTitle ?? work.title
  // 見放題が終わった作品をサービスの作品ページへ送らない。
  // ページは残っていても「もう見放題ではない」ので、読者の期待とずれる。
  if (kind === 'removed') return amazonSearchUrl(title)

  const host = hostOf(work.link)
  if (host && DIRECT_HOSTS.includes(host)) return work.link as string

  // app.primevideo.com など。作品ページではあるが tag= が乗らないので、
  // 成果の出る Amazon のビデオ内検索に落とす。
  return amazonSearchUrl(title)
}

// --- サムネイル ---------------------------------------------------------------

let thumbFiles: Set<string> | null = null

/**
 * `public/thumbs` にあるファイル名。1度だけ読む。
 * ディレクトリが無ければ空集合 ＝ **絵を出さない**（表は文字だけで成立する）。
 */
function availableThumbs(): Set<string> {
  if (thumbFiles) return thumbFiles
  const dir = findUp('public', 'thumbs') ?? findUp('site', 'public', 'thumbs')
  thumbFiles = new Set(dir ? readdirSync(dir).filter((n) => n.endsWith('.webp')) : [])
  return thumbFiles
}

/**
 * 作品のサムネイル。ポスターがあればそれ、無ければジャンル別の汎用画像。
 * どちらも用意されていなければ undefined。
 */
export function resolveThumb(work: RawWork): string | undefined {
  const files = availableThumbs()
  if (files.size === 0) return undefined

  const poster = `${String(work.id)}.webp`
  if (files.has(poster)) return `${THUMB_BASE}/${poster}`

  const generic = genreThumbName(genreKeyOf(work.genres))
  return files.has(generic) ? `${THUMB_BASE}/${generic}` : undefined
}

// --- サービス名 ---------------------------------------------------------------

/**
 * 記事や表に出る**表示名** → 収集データの `service` キー。
 *
 * ★ 記事の表の「サービス」列はこの表示名で書かれている。
 *   plugins/rehype-work-links.ts はこれを使って
 *   「その行がどのサービスの話か」を読み取り、送り先をそのサービスに合わせる。
 * ★ theme-packs/streaming-jp/theme.yaml の catalogs（と unext）と揃えること。
 */
export const SERVICE_BY_LABEL = new Map<string, string>([
  ['Netflix', 'netflix'],
  ['Amazon Prime Video', 'prime-video'],
  ['Disney+', 'disney-plus'],
  ['Apple TV+', 'apple-tv'],
  ['U-NEXT', 'u-next'],
])

// --- 台帳 ---------------------------------------------------------------------

interface Entry {
  workId: string
  title: string
  thumb?: string
  /** サービスキー → そのサービスでの送り先 */
  urls: Map<string, string>
  /** 最後に観測したサービス。サービスが指定されなかったときの既定 */
  latestService: string
}

interface Index {
  byId: Map<string, Entry>
  byTitle: Map<string, Entry>
}

let index: Index | null = null

function toLink(entry: Entry, service?: string): WorkLink {
  // ★ サービスを指定されたら**そのサービスの作品ページ**へ送る。
  //   「Netflixで配信終了予定」の一覧から Apple TV の作品ページへ飛ばすと、
  //   読者は自分がどこを見ているのか分からなくなる。
  //   指定が無い／そのサービスの記録が無いときだけ、最後に観測したものに落ちる。
  const url = (service && entry.urls.get(service)) ?? entry.urls.get(entry.latestService)
  return {
    workId: entry.workId,
    title: entry.title,
    url: url ?? amazonSearchUrl(entry.title),
    thumb: entry.thumb,
  }
}

/**
 * 作品の台帳。題名からも作品IDからも引ける。
 *
 * ★ 題名は**邦題を優先して登録する。** 原題は、その文字列がまだ空いているときだけ
 *   別名として足す。詰めて入れると、ある作品の原題が別の作品の邦題を上書きして、
 *   表の行が**まったく別の作品へ飛ぶ**（例: 原題 `Article 15` と邦題 `Article 15`）。
 *
 * ★ 送り先は**サービスごとに持つ。** 同じ作品が複数のサービスに出ることがあり
 *   （実測 1,760件中17件）、まとめて1つにすると、ページの主題と違うサービスへ
 *   飛ぶ行が混ざる。
 */
function buildIndex(): Index {
  if (index) return index

  const byId = new Map<string, Entry>()
  const byTitle = new Map<string, Entry>()
  const dir = findUp('data', 'events')
  if (!dir) {
    // 収集前でもページは出す。リンクもサムネイルも付かないだけ。
    index = { byId, byTitle }
    return index
  }

  // 作品IDとサービスの組ごとに、最後に観測したイベントを採る
  // （終了日や配信状況は後から変わる。古い方を残すと誤情報になる）
  const latest = new Map<string, RawEvent>()
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      let e: RawEvent
      try {
        e = JSON.parse(s) as RawEvent
      } catch {
        continue // 壊れた行があっても台帳全体を捨てない
      }
      // ★ 出さないと決めた作品は台帳に入れない（data/excluded-works.json）。
      //   入れておくと、記事の表に残っていた場合にリンクだけ付いてしまう。
      if (!isPublishable(e.work.id)) continue
      const key = `${String(e.work.id)} ${e.service}`
      const cur = latest.get(key)
      if (!cur || e.collectedAt > cur.collectedAt) latest.set(key, e)
    }
  }

  // 観測の古い順に流し込む。後から来たものが title・thumb・latestService を上書きする。
  const ordered = [...latest.values()].sort((a, b) => a.collectedAt.localeCompare(b.collectedAt))
  for (const e of ordered) {
    const workId = String(e.work.id)
    const entry: Entry = byId.get(workId) ?? {
      workId,
      title: '',
      urls: new Map<string, string>(),
      latestService: '',
    }
    entry.title = e.work.localizedTitle ?? e.work.title
    entry.thumb = resolveThumb(e.work)
    entry.latestService = e.service
    entry.urls.set(e.service, resolveUrl(e.work, e.kind))
    byId.set(workId, entry)
  }

  for (const entry of byId.values()) byTitle.set(entry.title, entry)
  // 原題は後回し。空いている文字列にだけ足す。
  for (const e of ordered) {
    const original = e.work.title
    if (original && !byTitle.has(original)) {
      const entry = byId.get(String(e.work.id))
      if (entry) byTitle.set(original, entry)
    }
  }

  index = { byId, byTitle }
  return index
}

/**
 * 題名から引く。表のセルの文字列をそのまま渡す想定（完全一致）。
 * @param service 分かっていればサービスキー。送り先をそのサービスに合わせる。
 */
export function workLinkByTitle(title: string, service?: string): WorkLink | undefined {
  const entry = buildIndex().byTitle.get(title)
  return entry ? toLink(entry, service) : undefined
}

/**
 * 作品IDから引く。常設ページの表はこちらを使う。
 * @param service ページが対象にしているサービスキー
 */
export function workLinkById(workId: string, service?: string): WorkLink | undefined {
  const entry = buildIndex().byId.get(workId)
  return entry ? toLink(entry, service) : undefined
}

/** テスト・再読込用 */
export function resetWorkLinks(): void {
  index = null
  thumbFiles = null
}
