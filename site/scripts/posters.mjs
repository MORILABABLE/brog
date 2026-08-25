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
 * 提供元に照会し、**2026-08-25 に許諾を得た**（回答: "Yes, you can."）。
 * 併せて「画像は最低でも6ヶ月ごとに取り直すこと」を推奨された。
 *   → 取り直しの手順は `npm run refresh:images`（docs/APPEARANCE.md 11節）
 *
 * ■ 絶対に落ちないこと
 * 取得は必ず失敗しうる（URL失効・CDN障害・オフライン・ビルド環境の制限）。
 * **この層は例外を投げない。取れなければ null を返す。**
 * 呼び出し側は画像なしのレイアウト（文字だけのカード）に必ず戻せること。
 * 画像が1枚欠けただけで Cloudflare のビルドが落ちる、という作りにはしない。
 *
 * ■ 取得したものを git に入れない理由
 * 提供元には「ビルドごとに取得する」と説明して許諾を得ており、
 * 規約上は契約終了後に画像を使えない。リポジトリに入れると
 * **git の履歴から消えなくなる。** ローカルのキャッシュ（.image-cache/）は
 * 開発中に同じ画像を何度も落とさないためだけのもので、消しても動く。
 */
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * キャッシュを作り直す間隔（日）。
 * 提供元の推奨「最低でも6ヶ月ごと」に合わせてある。**これより長くしないこと。**
 * Cloudflare のビルドは毎回まっさらなので、実際に効くのは手元の開発時だけ。
 */
export const MAX_AGE_DAYS = 180

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

      const cur = map.get(title)
      const at = expiryOf(url)
      if (!cur || (at ?? '') > (cur.expiresAt ?? '')) {
        map.set(title, { id: String(e.work.id), title, url, expiresAt: at })
      }
    }
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
  const body = {
    note:
      'サイトが実際に使っている作品画像の署名付きURL。' +
      'npm run refresh:images が失効の近いものだけを取り直す。手で編集しない。',
    updatedAt: new Date().toISOString(),
    // 作品IDで並べておくと git の差分が読める
    works: Object.fromEntries(Object.entries(works).sort(([a], [b]) => (a < b ? -1 : 1))),
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
  bytes = 0
  /** 失効が近い／切れている作品名。実行の最後にまとめて出す */
  expiring = []

  constructor(repoDir, { force = false } = {}) {
    this.#dir = join(repoDir, 'site', '.image-cache')
    this.#indexPath = join(this.#dir, 'index.json')
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

  #stale(entry) {
    if (this.force || !entry) return true
    const age = Date.now() - Date.parse(entry.fetchedAt ?? 0)
    return !(age >= 0 && age < MAX_AGE_DAYS * 86_400_000)
  }

  /** 元画像を取ってくる（キャッシュがあれば読むだけ）。取れなければ null */
  async original(url, label = '') {
    if (!url) return null

    const key = this.#keyOf(url)
    const file = join(this.#dir, `${key}.img`)
    const entry = this.#index[key]

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
   * 角を丸めた PNG のサムネイルにして返す。sharp の composite に直接渡せる。
   * ポスターは 2:3 で返ってくるので、同じ比率を渡せば切り取りは起きない。
   */
  async thumbnail(url, w, h, { radius = 12, label = '' } = {}) {
    const src = await this.original(url, label)
    if (!src) return null

    try {
      const mask = Buffer.from(
        `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
      )
      return await sharp(src)
        .resize(w, h, { fit: 'cover', position: 'top' })
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
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
    if (this.downloaded || this.reused || this.failed) {
      const mb = (this.bytes / 1024 / 1024).toFixed(2)
      console.log(
        `  画像: 取得${this.downloaded}枚 (${mb}MB) / キャッシュ${this.reused}枚` +
          (this.failed ? ` / 失敗${this.failed}枚` : ''),
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
    console.warn(
      `  ! 画像URLの期限が近い作品が ${unique.length}件` +
        (expired ? `（うち ${expired}件は失効済み）` : '') +
        `。最短 ${soonest?.slice(0, 10)}\n` +
        '    → npm run refresh:images で取り直してください（docs/APPEARANCE.md 11節）',
    )
  }
}

/**
 * 取得済みの画像をすべて消す。
 * **APIの契約を終了したときは必ず実行すること**（規約上、契約終了後は画像を使えない）。
 */
export function purge(repoDir) {
  const dir = join(repoDir, 'site', '.image-cache')
  rmSync(dir, { recursive: true, force: true })
  return dir
}
