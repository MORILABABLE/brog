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
import { fillJapaneseTitle } from './work-title'
import { adoptedStockWorks } from './availability'

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
  /**
   * 原語表記。**日本の作品は日本語表記のまま返る。**
   * 邦題が空のときの受け皿で、`fillJapaneseTitle()` が邦題に充てる（`work-title.ts`）。
   */
  originalTitle?: string
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
  // （提携が前提。2026-09-02 時点では未提携＝0円。docs/AFFILIATE.md 3-3）
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
 * 作品ポスターを**絶対に付けてはいけない**サービス。
 *
 * ★ 当サイトが持つポスターは配信API（Movie of the Night）から取得したもので、
 *   **そのAPIが扱うカタログの作品に対して**再ホストの許諾を得ている
 *   （docs/APPEARANCE.md 11節）。
 *   U-NEXT は自前収集（メニューを実ブラウザで読む）で、APIのカタログではない。
 *   そこへAPI由来のポスターを結びつけて出すのは、許諾の範囲外になりうる。
 *
 * ★ U-NEXT の作品はそもそも `posterUrl` を持たない（実測 723件すべて）ので、
 *   通常はジャンル別の汎用画像に落ちる。**問題は同じ題名の別作品**で、
 *   台帳が1件に潰れているとAPI側の絵がU-NEXTの行に出た（2026-08-27 に修正）。
 *   台帳を直したうえで、ここでも二重に止めておく。
 */
const NO_POSTER_SERVICES = ['u-next']

/**
 * 作品のサムネイル。ポスターがあればそれ、無ければジャンル別の汎用画像。
 * どちらも用意されていなければ undefined。
 *
 * @param service その行が扱っているサービスキー。**必ず渡すこと。**
 *   渡さないと、ポスターを付けてはいけないサービスの判定ができない。
 */
export function resolveThumb(work: RawWork, service?: string): string | undefined {
  const files = availableThumbs()
  if (files.size === 0) return undefined

  const poster = `${String(work.id)}.webp`
  if (!(service && NO_POSTER_SERVICES.includes(service)) && files.has(poster)) {
    return `${THUMB_BASE}/${poster}`
  }

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

/** 1作品の、あるサービスでの情報 */
interface ServiceLink {
  workId: string
  url: string
  thumb?: string
}

/**
 * 題名1つぶんの台帳。
 *
 * ★ **サービスごとに別の作品を持つ。** 同じ題名の別作品が別々のサービスに
 *   入ることがある（実例: 「ディア・ファミリー」が Netflix と U-NEXT に同日配信開始。
 *   作品IDは別）。1件に潰すと、Netflixの行から U-NEXT の作品ページへ飛び、
 *   絵も相手のものが出る。実際にそうなっていた（2026-08-27 に修正）。
 */
interface Entry {
  title: string
  /** サービスキー → その作品のそのサービスでの情報 */
  byService: Map<string, ServiceLink>
  /** 最後に観測したサービス。サービスが指定されなかったときの既定 */
  latestService: string
}

interface Index {
  byId: Map<string, Entry>
  byTitle: Map<string, Entry>
  /** 表記ゆれを潰した題 → その題のエントリ全部（`workIdsForTitle` 用） */
  byWorkKey: Map<string, Entry[]>
}

let index: Index | null = null

function toLink(entry: Entry, service?: string): WorkLink {
  // ★ サービスを指定されたら**そのサービスの作品**を返す。
  //   「Netflixで配信終了予定」の一覧から Apple TV の作品ページへ飛ばすと、
  //   読者は自分がどこを見ているのか分からなくなる。
  //   指定が無い／そのサービスの記録が無いときだけ、最後に観測したものに落ちる。
  // ★ `service &&` にすると空文字のときに型が string に混ざる。三項で書くこと。
  const hit =
    (service ? entry.byService.get(service) : undefined) ??
    entry.byService.get(entry.latestService)
  return {
    workId: hit?.workId ?? '',
    title: entry.title,
    url: hit?.url ?? amazonSearchUrl(entry.title),
    thumb: hit?.thumb,
  }
}

/**
 * 作品の台帳。題名からも作品IDからも引ける。
 *
 * ★ 題名は**邦題を優先して登録する。** 原題は、その文字列がまだ空いているときだけ
 *   別名として足す。詰めて入れると、ある作品の原題が別の作品の邦題を上書きして、
 *   表の行が**まったく別の作品へ飛ぶ**（例: 原題 `Article 15` と邦題 `Article 15`）。
 *
 * ★ 送り先も絵も**サービスごとに持つ。** 上の Entry の注意書きを参照。
 */
function buildIndex(): Index {
  if (index) return index

  const byId = new Map<string, Entry>()
  const byTitle = new Map<string, Entry>()
  const dir = findUp('data', 'events')
  if (!dir) {
    // 収集前でもページは出す。リンクもサムネイルも付かないだけ。
    index = { byId, byTitle, byWorkKey: new Map() }
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
      /*
       * ★ **邦題が取れていない作品に原語表記を充てる**（2026-09-12 追加）。
       *
       *   `events-data.ts` は読み込みのたびにこれを通しているのに、
       *   **この索引だけが通していなかった。** 記事の表には補完後の日本語題が出るのに
       *   索引には英題しか入らず、**完全一致で外れて、その行だけリンクも
       *   ポスターも付かない**（実測: 公開中の30記事・1,892行のうち12行）。
       *   読者には「この行だけ何も無い」としか見えず、送り先が1つも無い。
       *
       * ★ 規則は `lib/work-title.ts` の1か所。**ここに写さないこと。**
       */
      fillJapaneseTitle(e.work)
      // ★ 出さないと決めた作品は台帳に入れない（data/excluded-works.json）。
      //   入れておくと、記事の表に残っていた場合にリンクだけ付いてしまう。
      if (!isPublishable(e.work.id)) continue
      const key = `${String(e.work.id)} ${e.service}`
      const cur = latest.get(key)
      if (!cur || e.collectedAt > cur.collectedAt) latest.set(key, e)
    }
  }

  /*
   * ★ **在庫から採用した作品も台帳に入れる**（2026-09-10 追加）。
   *
   *   ここまでは変化ログしか見ていなかったので、
   *   `npm run availability -- --adopt` で拾った作品は**題名から引けず、
   *   記事の表でリンクにもサムネイルにもならなかった**
   *   （実測: クレヨンしんちゃんは30行中4行しか付いていなかった）。
   *
   * ★ **変化ログを優先する。** 同じ作品・同じサービスの組が両方にあるときは
   *   変化ログを残す。あちらは `kind`（終了済みかどうか）を持っていて、
   *   `resolveUrl()` の判断が変わる（終了した作品をサービスの作品ページへ送らない）。
   * ★ 在庫の観測は `kind: 'new'`。**在庫は「いまある」としか言わない**ので、
   *   終了済みとして扱う理由が無い（`article-types/series.ts` の `stockEvents` と同じ）。
   */
  /*
   * ★ **題名でも重複を見る。** IDだけで弾くと、同じ映画が
   *   配信元ごとに別のIDで入っている場合（U-NEXT の SID… と配信APIの数値ID）に
   *   **後から入れた在庫のほうが `byTitle` を上書きして、送り先が入れ替わる。**
   *   在庫の観測は変化ログより必ず新しいので、放っておくと必ず勝つ。
   */
  const seen = new Set<string>()
  for (const e of latest.values()) {
    for (const t of [e.work.localizedTitle, e.work.title]) {
      if (t) seen.add(`${t} ${e.service}`)
    }
  }
  for (const s of adoptedStockWorks()) {
    if (!isPublishable(s.work.id)) continue
    if (latest.has(`${s.id} ${s.service}`)) continue
    const names = [s.work.localizedTitle, s.work.title].filter(Boolean) as string[]
    if (names.some((t) => seen.has(`${t} ${s.service}`))) continue
    latest.set(`${s.id} ${s.service}`, {
      collectedAt: s.fetchedAt,
      service: s.service,
      kind: 'new',
      work: s.work,
    })
  }

  // 観測の古い順に流し込む。後から来たものが latestService を上書きする。
  const ordered = [...latest.values()].sort((a, b) => a.collectedAt.localeCompare(b.collectedAt))

  const put = (map: Map<string, Entry>, key: string, e: RawEvent) => {
    const title = e.work.localizedTitle ?? e.work.title
    const entry: Entry =
      map.get(key) ?? { title, byService: new Map<string, ServiceLink>(), latestService: '' }
    entry.title = title
    entry.latestService = e.service
    entry.byService.set(e.service, {
      workId: String(e.work.id),
      url: resolveUrl(e.work, e.kind),
      thumb: resolveThumb(e.work, e.service),
    })
    map.set(key, entry)
  }

  for (const e of ordered) {
    put(byId, String(e.work.id), e)
    put(byTitle, e.work.localizedTitle ?? e.work.title, e)
  }

  // 原題は後回し。空いている文字列にだけ足す。
  for (const e of ordered) {
    const original = e.work.title
    if (original && !byTitle.has(original)) put(byTitle, original, e)
  }

  /*
   * ★ **Markdown が消してしまう記号ぶんの別名**（2026-09-12 追加）。
   *
   *   `~…~` は GFM で**取り消し線**になり、表のセルからは `~` が消える。
   *   題名にそれを含む作品は、台帳にあっても完全一致で外れて
   *   **その行だけリンクもポスターも付かない**
   *   （実測: `KKCP 90's ~KYOKO KOIZUMI CLUB PARTY 2023~`。U-NEXT の音楽もの）。
   *
   * ★ 別名は**空いている文字列にだけ**足す（原題と同じ扱い）。
   *   詰めて入れると、別作品の題を上書きして行がまったく別の場所へ飛ぶ。
   * ★ 表示に使う題名（`entry.title`）は台帳のまま。ここで作るのは**引き当ての鍵だけ**。
   */
  for (const e of ordered) {
    for (const t of [e.work.localizedTitle, e.work.title]) {
      if (!t) continue
      const stripped = t.replace(/~([^~]+)~/g, '$1')
      if (stripped !== t && !byTitle.has(stripped)) put(byTitle, stripped, e)
    }
  }

  /*
   * 表記ゆれを潰した索引。**在庫の印を引くときの受け皿**（`workIdsForTitle`）。
   * 同じ映画が配信元ごとに別の題・別のIDで入っているため（下の説明）。
   */
  const byWorkKey = new Map<string, Entry[]>()
  for (const entry of new Set(byTitle.values())) {
    const k = workKey(entry.title)
    if (!k) continue
    const list = byWorkKey.get(k)
    if (list) list.push(entry)
    else byWorkKey.set(k, [entry])
  }

  index = { byId, byTitle, byWorkKey }
  return index
}

/**
 * 題の表記ゆれを潰した突き合わせ用の鍵。
 *
 * ★ **`theme-packs/streaming-jp/article-types/series.ts` の `workKey` と同じ規則。**
 *   あちらは記事の表を1行にまとめるのに使う。**site は theme-packs を import しない**
 *   という境界のために写してある（`availability.ts` が見放題の規則を写しているのと同じ）。
 *   **どちらかを変えるときは両方を変えること。**
 *
 * ★ **これを送り先やサムネイルの解決に使わないこと。** 正規化を効かせすぎると、
 *   別作品どうしが当たって**表の行がまったく別の作品へ飛ぶ**（`buildIndex` の注意書き）。
 *   使ってよいのは**在庫の印**だけで、そこでも当たりが割れたら出さない
 *   （plugins/rehype-availability.ts）。
 */
const TITLE_PREFIX = /^(劇場版|総集編|TVシリーズ特別編集版|テレビシリーズ特別編集版)/

function workKey(title: string): string {
  let s = title
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[「」『』]/g, '')
    .replace(/[～〜―—\-－]/g, '')
    .replace(/[\s　]/g, '')
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(TITLE_PREFIX, '')
  }
  return s
}

/**
 * その題が指しうる**作品IDを全部**返す。完全一致のものが先。
 *
 * ■ 何のためにあるのか
 * **同じ映画が、配信元ごとに別のIDで台帳に入っている。**
 *
 *     U-NEXT   `劇場版 名探偵コナン 黒鉄の魚影（サブマリン）`  → SID…（在庫を取れない）
 *     配信API  `名探偵コナン 黒鉄の魚影`                        → 数値ID（在庫がある）
 *
 * 表のセルに出ている題はどちらか一方なので、**完全一致だけで在庫を引くと、
 * U-NEXT 由来の行にだけ印が出ない。** 読者には
 * 「調べたうえで取り扱いなし」と「そもそも出ていない」の区別が付かず、
 * 不具合に見える（2026-09-06・運用者の指摘）。
 *
 * ★ 呼び出し側は**先頭から順に試して、当たったものを使う**。
 *   複数当たったときの扱いは呼び出し側の責任（上の `workKey` の注意書き）。
 */
export function workIdsForTitle(title: string): string[] {
  const { byTitle, byWorkKey } = buildIndex()
  const exact = byTitle.get(title) ?? byTitle.get(plainPunctuation(title))
  const ids: string[] = []
  const push = (e: Entry) => {
    for (const link of e.byService.values()) if (!ids.includes(link.workId)) ids.push(link.workId)
  }
  if (exact) push(exact)
  for (const e of byWorkKey.get(workKey(title)) ?? []) if (e !== exact) push(e)
  return ids
}

/**
 * 題名から引く。表のセルの文字列をそのまま渡す想定（完全一致）。
 * @param service 分かっていればサービスキー。送り先をそのサービスに合わせる。
 */
/**
 * Markdown の整形で置き換わった約物を、素材の表記に戻す。
 *
 * ★ 台帳の見出しは配信APIの文字列そのままだが、**表のセルは Markdown を通ってくる。**
 *   smartypants が `"` を `“ ”` に、`--` を `–` に変える。完全一致で引いているので、
 *   引用符を含む題名は台帳にあってもサムネイルもリンクも付かない
 *   （例: `Ordinary Men: The "Forgotten Holocaust"`。2026-09-01 の添削）。
 */
function plainPunctuation(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '--')
    /*
     * ★ 三点リーダ。smartypants が `...` を `…` に変える。
     *   実測: `Martin Matte : La vie, la mort... eh la la..!`（2026-09-12）。
     *   台帳側が `…` を持つ題名は**完全一致のほうで当たる**ので、
     *   この置き換えで取りこぼすことはない。
     */
    .replace(/…/g, '...')
}

export function workLinkByTitle(title: string, service?: string): WorkLink | undefined {
  const { byTitle } = buildIndex()
  const entry = byTitle.get(title) ?? byTitle.get(plainPunctuation(title))
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

/**
 * 台帳にある題名をすべて返す（邦題・原題の両方）。
 *
 * 使い道は src/lib/page-intent.ts。Search Console が返した検索語の中に
 * **実在する作品名が含まれているか**を確かめるために要る。
 * 「u-next 配信終了 9月」のような語をそのまま Amazon 検索へ渡さないための関門。
 */
export function allWorkTitles(): string[] {
  return [...buildIndex().byTitle.keys()]
}

/** テスト・再読込用 */
export function resetWorkLinks(): void {
  index = null
  thumbFiles = null
}
