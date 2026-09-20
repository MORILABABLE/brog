/**
 * 作品ポスターを**ビルド時に取得し、自分のドメインから配信する**ための取得層。
 *
 * ■ なぜ自前で持つのか（許諾の経緯）
 * 画像は Streaming Availability API (Movie of the Night) が返す**署名付きURL**で、
 * 有効期限は6〜12ヶ月しかない。読者のブラウザから直接その URL を読ませる
 * （ホットリンクする）と、期限が切れた時点で**過去記事の画像が一斉に壊れる。**
 * また読者のアクセスがそのまま提供元のCDN帯域（無料枠 1GB/月）を食う。
 *
 * そこで「ビルド時に1回だけ取得して変換し、自分のドメインから出す」方式を
 * 提供元に照会し、**2026-08-25 に可の回答を得た**（回答: "Yes, you can."）。
 * 併せて「画像は最低でも6ヶ月ごとに取り直すこと」を推奨された。
 * ★ **これは推奨であって、規約上の義務ではない**（2026-09-20 に現行規約6節の原文で確認）。
 *   6節は「必要なあいだ手元に保存してよい」と書くだけで、取り直しの期限を置いていない。
 * ★ 一方 **7節の帯域（無料プラン 月1GB）は禁止事項**（"must not use … in a way that exceeds"）。
 *   下の `KEEP_ORIGINALS_FOREVER` が減らしているのはこちら。
 *   → 取り直しの手順は `npm run refresh:images`（docs/APPEARANCE.md 11節）
 * ★ これは**API規約上の可否**であって、ポスターの著作権の許諾ではない（現行規約5節）。
 *
 * ■ 取得した画像はビルドをまたいで持ち続ける（2026-09-17〜）
 * 現行規約6節が「手元に保存して使い続けること」「契約終了後も使うこと」を認めている。
 * そこで**署名付きURLが失効しても、手元に画像があれば掲載を続ける**（`original()`）。
 * ★ **2026-09-20 に、時間での取り直しをやめた**（`KEEP_ORIGINALS_FOREVER`）。
 *   規約の変更で取得済みの画像を持ち続けてよくなり、かつ取り直しても
 *   （鍵が署名なしパスなので）同じ絵が返るだけだった。差し替えは `--refresh` で明示的に行う。
 *
 * ★ **置き場所は環境で変わる**（`cacheDirOf()`）。
 *   Cloudflare Pages のビルドは毎回まっさらで、以前は**ビルドのたびに全ポスターを取り直していた**
 *   （2026-09-17 時点で千枚前後・50〜90MB／回の推定。無料プランの帯域は月1GB＝規約7節）。
 *   Pages の「ビルドキャッシュ」が Astro 用に持ち越す `node_modules/.astro` の中に置くことで、
 *   **取得は新しく出てきた作品のぶんだけ**になる。
 *   キャッシュは「7日間読まれないと消える」。消えても今までと同じ（取り直す）に戻るだけ。
 *
 * ■ 権利者から掲載停止の連絡が来たら — `data/poster-removed.json`
 * 作品IDを足してコミットする。**次のビルドで手元の画像も消え、その作品は汎用画像に戻る。**
 * 記事に焼き込まれた参照は `images` ワークフロー（make-sections --write）が翌朝差し替える。
 * 急ぐなら `cd site && npm run sections -- --write` を手で流してコミットする。
 * 全部を消すときは `npm run posters:purge`（下の `purge()`）。
 *
 * ■ 絶対に落ちないこと
 * 取得は必ず失敗しうる（URL失効・CDN障害・オフライン・ビルド環境の制限）。
 * **この層は例外を投げない。取れなければ null を返す。**
 * 呼び出し側は画像なしのレイアウト（文字だけのカード）に必ず戻せること。
 * 画像が1枚欠けただけで Cloudflare のビルドが落ちる、という作りにはしない。
 *
 * ■ 取得したものを git に入れない理由
 * ポスターの著作権は各作品の権利者にあり、**掲載停止の連絡が来たら消せる必要がある**
 * （規約5節も、提供元から通知があれば速やかに消すことを求めている）。
 * リポジトリに入れると **git の履歴から消えなくなる。** しかもこのリポジトリは公開なので、
 * 入れた時点で画像を第三者に配ることにもなる。キャッシュは消しても動く（取り直すだけ）。
 */
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 手元の原本を**時間では捨てない**（2026-09-20 に 180日 → 無期限）。
 *
 * ■ 何をやめたか
 * それまでは取得から180日で「古い」とみなして取り直していた。
 * 提供元の推奨「最低でも6ヶ月ごとに取り直すこと」に合わせたものだったが、
 * **現行規約6節は、必要なあいだ手元に保存してよいと書くだけで期限を置いていない**
 * （2026-09-20 に原文で確認）。推奨に合わせた自主規制であって、義務ではなかった。
 *
 * ■ やめてよい理由はもう1つある。**取り直しても中身が変わらない。**
 * キャッシュの鍵は `#keyOf()` が作る**署名を外したパス**で、
 * 署名付きURLを取り直しても変わるのは署名だけ。つまり180日ごとの再取得は
 * **同じ絵をもう一度落としていた。**
 *
 * ■ いくら浮くか
 * `site/.image-cache` は 1,771枚・97MB（2026-09-20 実測）。
 * 提供元CDNの無料枠は**月1GB**（規約7節）なので、この再取得の波が来ると
 * それだけで1割を使う。ビルドは1日に数回あり、キャッシュが飛んだ回は
 * どのみち全部を落とし直すので、**避けられる往復は避けておく。**
 *
 * ★ 絵そのものを入れ替えたいときは `force`（`npm run sections -- --refresh`）。
 *   時間では取り直さないので、**差し替えは明示的に行うこと。**
 */
export const KEEP_ORIGINALS_FOREVER = true

/**
 * 取得した元画像の置き場所。
 *
 * - **Cloudflare Pages のビルド**（`CF_PAGES` が立つ）… `site/node_modules/.astro/poster-cache`。
 *   Pages のビルドキャッシュが Astro 用に持ち越すディレクトリなので、次のビルドに残る
 * - **それ以外**（手元・GitHub Actions）… `site/.image-cache`。
 *   `images` ワークフローはこちらを actions/cache に載せている（.github/workflows/images.yml）
 *
 * ★ `npm run build:fresh` / `dev:fresh`（scripts/clear-cache.mjs）は `node_modules/.astro` を消す。
 *   **Pages のビルドコマンドをそちらに変えると、毎回全部を取り直す状態に戻る。**
 * ★ どちらも git には入れない（node_modules と .image-cache は .gitignore 済み）。
 *   このリポジトリは公開で、掲載停止の連絡が来たら消せる必要がある。
 */
export function cacheDirOf(repoDir) {
  return process.env.CF_PAGES
    ? join(repoDir, 'site', 'node_modules', '.astro', 'poster-cache')
    : join(repoDir, 'site', '.image-cache')
}

/** 掲載をやめた作品の台帳。`data/` にあり、git に入れる */
export const REMOVED_NAME = 'poster-removed.json'

/**
 * 掲載をやめた作品IDの集合。ファイルが無ければ空。
 *
 * 形式: `{ "works": { "<作品ID>": { "at": "YYYY-MM-DD", "reason": "…" } } }`
 * 作品IDは画像URLの `/show/<ID>/` と同じもの（作品ページ `/works/<ID>` とも同じ）。
 */
export function loadRemoved(repoDir) {
  try {
    const json = JSON.parse(readFileSync(join(repoDir, 'data', REMOVED_NAME), 'utf8'))
    return new Set(Object.keys(json.works ?? {}))
  } catch {
    return new Set()
  }
}

/** 画像URLから作品IDを抜く（`…/show/<ID>/poster/…`）。読めなければ undefined */
export function workIdOfImage(url) {
  try {
    return /\/show\/([^/]+)\//.exec(new URL(url).pathname)?.[1]
  } catch {
    return undefined
  }
}

/** 署名付きURLの残り日数がこれを下回ったら警告する（取り直しの催促） */
const WARN_EXPIRY_DAYS = 60

/** 1枚あたりの上限。これを超える応答は画像ではないとみなして捨てる */
const MAX_BYTES = 4 * 1024 * 1024

const FETCH_TIMEOUT_MS = 15_000

/**
 * 画像の取得元と、いま手元にある署名付きURLの台帳。
 *
 * `data/image-manifest.json` は**サイトが実際に使っている作品だけ**を記録する。
 * 取り直し（refresh:images）はこの台帳を見て、失効が近いものだけAPIを叩く。
 * 収集済み1,000件超すべてを取り直すと無料枠(500req/月)を軽く超えるため。
 */
export const MANIFEST_NAME = 'image-manifest.json'

// --- 収集データから画像URLを引く ------------------------------------------

/** 署名付きURLの `Expires=`（Unix秒）を ISO 文字列にする。読めなければ undefined */
export function expiryOf(url) {
  const m = /[?&]Expires=(\d+)/.exec(url ?? '')
  if (!m) return undefined
  const ms = Number(m[1]) * 1000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** URLの署名が切れている（もう取得できない）か */
export function isExpired(url, now = Date.now()) {
  const at = expiryOf(url)
  return at ? Date.parse(at) <= now : false
}

/**
 * ポスターを持たない作品に、APIが返す**代替画像**か。
 *
 * 実物が無い作品には `…/media/image.svg?title=One+Piece%3A+Stampede&…` のような
 * 「題名を書いただけのSVG」が返ってくる（収集済み1,126件中52件）。
 * これを載せても読者には何も伝わらないうえに、
 *   - SVG の文字は描画マシンのフォントで出る → Cloudflare(Linux)で豆腐になる
 *   - 署名が無いので期限も無く、取り直し(refresh:images)が毎回の対象にしてしまう
 * ので、**画像が無いものとして扱う**（その節は文字だけのカードに戻る）。
 */
export function isPlaceholder(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg')
  } catch {
    return false
  }
}

/**
 * 収集済みイベントから「作品名 → 画像」の対応を作る。
 *
 * キーは記事の表に出ている名前（邦題があれば邦題）。make-sections.mjs が
 * 表から拾った文字列でそのまま引けるようにするため、`loadWorkYears()` と
 * 同じキーの作り方にしてある。**片方だけ変えないこと。**
 *
 * 同じ作品が複数回出てくる場合は**期限が最も先のURL**を採る。
 * 収集日が違えば署名も違い、古い回のURLは先に切れるため。
 */
export function loadWorkImages(repoDir) {
  const dir = join(repoDir, 'data', 'events')
  /** @type {Map<string, {id: string, title: string, url: string, expiresAt?: string}>} */
  const map = new Map()
  /** 原題ぶんの控え。**本文の鍵を全部入れ終わってから**、空いている鍵にだけ足す */
  const pendingOriginals = []
  if (!existsSync(dir)) return map

  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n')) {
      if (!line) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue // 壊れた行があっても収集ログ全体を捨てない
      }
      const url = e.work?.posterUrl
      if (!url) continue // U-NEXT 由来のイベントには画像が無い
      if (isPlaceholder(url)) continue // 題名を書いただけの代替画像は使わない
      const title = e.work.localizedTitle ?? e.work.title
      if (!title) continue

      /*
       * ★ **原題でも引けるようにする**（2026-09-14 追加）。
       *
       *   記事の表に出る題名は `withJapaneseWorkTitle()`（pipeline/core/events.ts）で
       *   **邦題が無ければ `originalTitle` を充てた**あとのもの。ここが
       *   `localizedTitle ?? title` しか鍵にしていないと、邦題を持たない作品は
       *   **英題でしか引けず、記事の日本語題では当たらない。**
       *
       *     実測（2026-09-14・「ガンダム」）
       *       閃光のハサウェイ キルケーの魔女
       *         title          MOBILE SUIT GUNDAM HATHAWAY The Sorcery of Nymph Circe
       *         localizedTitle （無し）
       *         originalTitle  機動戦士ガンダム  閃光のハサウェイ キルケーの魔女
       *       → 節の代表2作のうち1作が引けず、**節がまるごと文字だけに落ちた**
       *         （ポスターは節の全員ぶん揃ったときだけ使う決まりのため）
       *
       * ★ **規則は写さない。** `originalTitle` がかなを含むかどうかの判定は
       *   `src/lib/work-title.ts` が持っている（サイト側の写しはあの1か所だけ）。
       *   ここは**鍵を増やすだけ**にしてあるので、引くのは
       *   `imageFor(記事に書かれた題名)` の側で、判定を二重に持たない。
       *
       * ★ **原題は後回し**（`work-links.ts` の索引と同じ順序）。
       *   別の作品が邦題として使っている文字列を、原題で上書きさせない。
       */
      const at = expiryOf(url)
      const cur = map.get(title)
      if (!cur || (at ?? '') > (cur.expiresAt ?? '')) {
        map.set(title, { id: String(e.work.id), title, url, expiresAt: at })
      }
      /*
       * ★ **記事に出るのは空白を詰めた版**（`src/lib/work-title.ts` の
       *   `fillJapaneseTitle`／`pipeline/core/events.ts` の `withJapaneseWorkTitle`）。
       *   配信APIの `originalTitle` には全角空けの名残で二重空白が入ることがあり、
       *   詰める前の文字列だけを鍵にすると**記事の題名と一致しない。**
       *
       *     実測: "機動戦士ガンダム␣␣閃光のハサウェイ キルケーの魔女"（API）
       *           "機動戦士ガンダム␣閃光のハサウェイ キルケーの魔女"（記事）
       *
       *   両方を鍵にする。**詰め方の規則だけを合わせ、かなの判定は持たない。**
       */
      const original = e.work.originalTitle
      if (original) {
        for (const key of new Set([original, original.replace(/ {2,}/g, ' ').trim()])) {
          if (key && key !== title) {
            pendingOriginals.push({ key, id: String(e.work.id), title, url, expiresAt: at })
          }
        }
      }
    }
  }

  // 原題ぶん。**空いている鍵にだけ足す**（邦題を持つ作品の鍵は奪わない）
  for (const p of pendingOriginals) {
    if (!map.has(p.key)) {
      map.set(p.key, { id: p.id, title: p.title, url: p.url, expiresAt: p.expiresAt })
    }
  }

  /*
   * ★ **在庫から採用した作品の絵も拾う**（2026-09-10 追加）。
   *
   *   ここまでは変化ログ（`data/events`）しか見ていなかった。
   *   だが `npm run availability -- --adopt` で拾った作品は変化ログに現れないので、
   *   **その作品だけ絵が引けず、節がまるごと「文字だけ」に落ちていた**
   *   （ポスターは節の全員ぶん揃ったときだけ使う決まりのため。make-sections.mjs）。
   *
   *     実測（2026-09-10・クレヨンしんちゃん）
   *       Netflixの節27作はすべて在庫から採用したもので、絵が1枚も引けなかった
   *
   *   台帳の `work` は在庫APIが返した Work そのままで、`posterUrl` を持っている。
   *   出どころが同じ（Movie of the Night）なので、絵の質も期限の形も変わらない。
   *
   * ★ **変化ログを優先する。** 上と同じく「期限が先のほう」を採るだけにしてある。
   * ★ **`work` を持つ行だけ。** 注釈のために取っただけの行は変化ログ側が絵を持つ。
   */
  try {
    const led = JSON.parse(readFileSync(join(repoDir, 'data', 'availability.json'), 'utf8'))
    for (const [id, entry] of Object.entries(led.works ?? {})) {
      const work = entry?.work
      const url = work?.posterUrl
      if (!url || isPlaceholder(url)) continue
      const title = work.localizedTitle ?? work.title
      if (!title) continue
      const cur = map.get(title)
      const at = expiryOf(url)
      if (!cur || (at ?? '') > (cur.expiresAt ?? '')) {
        map.set(title, { id: String(work.id ?? id), title, url, expiresAt: at })
      }
    }
  } catch {
    // 台帳が無くても絵は出る。**変化ログのぶんだけになる。**
  }

  return map
}

// --- 台帳（data/image-manifest.json） --------------------------------------

export function loadManifest(repoDir) {
  const path = join(repoDir, 'data', MANIFEST_NAME)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { works: {}, ...raw }
  } catch {
    return { works: {} }
  }
}

export function saveManifest(repoDir, works) {
  const path = join(repoDir, 'data', MANIFEST_NAME)
  // 作品IDで並べておくと git の差分が読める
  const sorted = Object.fromEntries(Object.entries(works).sort(([a], [b]) => (a < b ? -1 : 1)))

  /*
   * ★ 中身が変わっていなければ書かない。
   *   この台帳はビルドのたびに書き出されるので、時刻を毎回更新すると
   *   **何も変わっていないのに1行だけ差分が出る**。コミットのノイズになる。
   */
  const current = loadManifest(repoDir)
  if (JSON.stringify(current.works ?? {}) === JSON.stringify(sorted)) return

  const body = {
    note:
      'サイトが実際に使っている作品画像の署名付きURL。' +
      'npm run refresh:images が失効の近いものだけを取り直す。手で編集しない。',
    updatedAt: new Date().toISOString(),
    works: sorted,
  }
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

// --- 取得とキャッシュ -------------------------------------------------------

/**
 * ビルド時のポスター取得。
 *
 * 使い方:
 *   const posters = new PosterCache(repoDir)
 *   const buf = await posters.thumbnail(url, 170, 255)   // 取れなければ null
 *   posters.report()
 */
export class PosterCache {
  #dir
  #index
  #indexPath
  /** 同じURLを1回の実行で二度落とさない（節ごとに同じ作品が出る） */
  #inflight = new Map()

  downloaded = 0
  reused = 0
  failed = 0
  /** `data/poster-removed.json` に載っていて出さなかった枚数 */
  removed = 0
  bytes = 0
  #removedIds
  /** 失効が近い／切れている作品名。実行の最後にまとめて出す */
  expiring = []

  constructor(repoDir, { force = false } = {}) {
    this.#dir = cacheDirOf(repoDir)
    this.#indexPath = join(this.#dir, 'index.json')
    this.#removedIds = loadRemoved(repoDir)
    this.force = force
    mkdirSync(this.#dir, { recursive: true })
    try {
      this.#index = JSON.parse(readFileSync(this.#indexPath, 'utf8'))
    } catch {
      this.#index = {}
    }
  }

  /**
   * キャッシュのキー。
   * **署名（クエリ）を外したパスで持つ。** URLを取り直すと署名だけが変わるので、
   * クエリ込みで持つと同じ画像を何度も落とすことになる。
   */
  #keyOf(url) {
    let path = url
    try {
      path = new URL(url).origin + new URL(url).pathname
    } catch {
      // URL として読めないものはそのまま鍵にする
    }
    return createHash('sha1').update(path).digest('hex').slice(0, 16)
  }

  /**
   * 取り直しに行くか。
   *
   * **手元に原本があるなら行かない**（`KEEP_ORIGINALS_FOREVER` の注記）。
   * 鍵は署名を外したパスなので、取り直しても同じ絵が返るだけ。
   * 入れ替えたいときは `force`（`npm run sections -- --refresh`）。
   */
  #stale(entry) {
    return this.force || !entry
  }

  /** 元画像を取ってくる（キャッシュがあれば読むだけ）。取れなければ null */
  async original(url, label = '') {
    if (!url) return null

    const key = this.#keyOf(url)
    const file = join(this.#dir, `${key}.img`)
    const entry = this.#index[key]

    // 掲載をやめた作品。手元の画像も消す（持ち越しているキャッシュに残さない）
    const id = workIdOfImage(url)
    if (id && this.#removedIds.has(id)) {
      rmSync(file, { force: true })
      delete this.#index[key]
      this.removed++
      return null
    }

    if (!this.#stale(entry) && existsSync(file)) {
      this.reused++
      return readFileSync(file)
    }

    if (isExpired(url)) {
      // 署名切れ。取りに行っても 403 が返るだけなので投げない。
      this.expiring.push({ label, expiresAt: expiryOf(url), expired: true })
      // 期限切れでも手元にファイルが残っていれば、それを使い続ける
      // （手元の絵は消えないので、見た目は保たれる）。
      // 新しいURLの取得は refresh:images 側の仕事。
      if (existsSync(file)) {
        this.reused++
        return readFileSync(file)
      }
      this.failed++
      return null
    }

    const at = expiryOf(url)
    if (at && Date.parse(at) - Date.now() < WARN_EXPIRY_DAYS * 86_400_000) {
      this.expiring.push({ label, expiresAt: at, expired: false })
    }

    if (this.#inflight.has(key)) return this.#inflight.get(key)

    const task = this.#download(url, key, file, label)
    this.#inflight.set(key, task)
    return task
  }

  async #download(url, key, file, label) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'image/*' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_BYTES) {
        throw new Error(`想定外のサイズ ${buf.length} バイト`)
      }

      writeFileSync(file, buf)
      this.#index[key] = { fetchedAt: new Date().toISOString(), bytes: buf.length, label }
      this.downloaded++
      this.bytes += buf.length
      return buf
    } catch (err) {
      // 画像1枚のためにビルドを落とさない。呼び出し側が文字だけの版に戻す。
      console.warn(`  ! 画像を取得できませんでした（${label || url.slice(0, 60)}）: ${err.message}`)
      this.failed++
      return existsSync(file) ? readFileSync(file) : null
    } finally {
      this.#inflight.delete(key)
    }
  }

  /**
   * そのまま記事に置ける WebP にして返す。
   *
   * **枠も角丸も焼き込まない。** 記事に出るのはポスターの絵だけで、
   * 角の丸みは CSS（`.prose img[src^='/sections/posters/']`）が付ける。
   * 画像に焼き込むと、配色やテーマを変えたときに全部作り直しになる。
   *
   * ポスターは 2:3 で返ってくるので、同じ比率を渡せば切り取りは起きない。
   */
  async poster(url, w, h, { label = '' } = {}) {
    const src = await this.original(url, label)
    if (!src) return null

    try {
      return await sharp(src)
        .resize(w, h, { fit: 'cover', position: 'top' })
        .webp({ quality: 78 })
        .toBuffer()
    } catch (err) {
      // 画像として読めなかった（HTMLのエラーページを掴んだ等）
      console.warn(`  ! 画像を変換できませんでした（${label}）: ${err.message}`)
      this.failed++
      return null
    }
  }

  save() {
    try {
      writeFileSync(this.#indexPath, JSON.stringify(this.#index, null, 2) + '\n', 'utf8')
    } catch {
      // キャッシュの索引が書けなくても本体は完成している
    }
  }

  /** 実行のあとに1度呼ぶ。帯域の消費と、取り直しが要るかを出す。 */
  report() {
    this.save()
    if (this.downloaded || this.reused || this.failed || this.removed) {
      const mb = (this.bytes / 1024 / 1024).toFixed(2)
      console.log(
        `  画像: 取得${this.downloaded}枚 (${mb}MB) / キャッシュ${this.reused}枚` +
          (this.failed ? ` / 失敗${this.failed}枚` : '') +
          (this.removed ? ` / 掲載停止${this.removed}枚` : '') +
          `（置き場所: ${this.#dir.replace(/\\/g, '/').replace(/^.*\/site\//, 'site/')}）`,
      )
    }

    if (this.expiring.length === 0) return
    // 同じ作品が複数の節に出るので、作品名で1件にまとめてから数える
    const unique = [...new Map(this.expiring.map((e) => [e.label, e])).values()]
    const expired = unique.filter((e) => e.expired).length
    const soonest = unique
      .map((e) => e.expiresAt)
      .filter(Boolean)
      .sort()[0]
    /*
     * ★ **急かさない**（2026-09-20）。
     *   規約の変更で、取得済みの画像は手元に持ったまま使い続けてよくなった。
     *   失効しても、手元に原本があるかぎり絵は出続ける（`original()`）。
     *   取り直しが効くのは「手元に原本が無い環境で、URLも切れている」ときだけ。
     *   以前の「取り直してください」は、月80件の平準化（refresh:images）と噛み合わず、
     *   **毎ビルド出るのに月の大半は何もできない**警告になってしまう。
     */
    console.log(
      `  ・画像URLの期限が近い作品が ${unique.length}件` +
        (expired ? `（うち ${expired}件は失効済み）` : '') +
        `。最短 ${soonest?.slice(0, 10)}\n` +
        '    掲載は続きます（手元の原本を使います）。取り直しは月ぶんずつ:' +
        ' npm run refresh:images（docs/APPEARANCE.md 11節）',
    )
  }
}

/**
 * ポスターに付ける導線リンク。**Amazonのビデオ内検索**（レンタル・購入）。
 *
 * ■ なぜ Amazon なのか
 *   - 対象4社のうち**アフィリエイトが成立するのは Amazon だけ**
 *     （Netflix は提携先が無い、Disney+ はクローズド、Apple TV+ は招待制）
 *   - サービスを問わず**全作品に出せる**。ポスターが出る節すべてが導線になる
 *   - 「見放題が終わっても買えば観られる」は事実として言える。断定を避ける
 *     このサイトの方針（配信状況を主張しない）とも矛盾しない
 *
 * ■ トラッキングIDはここでは付けない
 * ビルド時に plugins/rehype-affiliate.ts が `tag=` と `rel="sponsored"` を付ける。
 * 記事本文にIDを焼き込むと、IDを変えるたびに全記事の再生成が要る。
 *
 * ■ U-NEXT の提携が通ったら
 * バリューコマース LinkSwitch が**ブラウザ側で自動変換**するので、
 * リンク先を `https://video.unext.jp/freeword?query=…` に替えるだけでよい。
 * 記事の再生成は要るが、IDを埋める必要は無い（docs/AFFILIATE.md）。
 *
 * ★ URLの形は次の2か所と同じもの。**片方だけ直さないこと。**
 *     site/src/lib/search-links.ts の amazonVideoLink()
 *     theme-packs/streaming-jp/theme.yaml の search_links
 */
export function posterLink(title) {
  const q = encodeURIComponent(title.replace(/[/／]/g, ' ').replace(/\s+/g, ' ').trim())
  return `https://www.amazon.co.jp/s?k=${q}&i=instant-video`
}

/**
 * 取得済みの画像をすべて消す。
 *
 * 使うのは**ポスターの掲載そのものをやめるとき**（権利上の理由など）。
 * ★ 2026-09-17 までは「契約終了時に必ず実行」としていたが、現行規約6節で
 *   契約終了後も保持・使用してよいことになった。**提供元から削除の通知が来たら**実行する（5節）。
 * ★ 手元で消せるのは手元の置き場所だけ。Cloudflare Pages 側のキャッシュ
 *   （`node_modules/.astro/poster-cache`）は、Pages の管理画面で
 *   **ビルドキャッシュを削除**してから再デプロイすること。
 */
export function purge(repoDir) {
  const dirs = [
    join(repoDir, 'site', '.image-cache'),
    join(repoDir, 'site', 'node_modules', '.astro', 'poster-cache'),
  ]
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  return dirs.join('\n  ')
}
