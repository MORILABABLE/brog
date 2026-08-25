/**
 * 記事のセクション（`## ○月○日：…`）ごとに、本文へ挟む画像を生成する。
 *
 *   npm run sections            画像だけ作る（prebuild が自動で呼ぶ）
 *   npm run sections -- --write 記事の Markdown に画像の参照も挿し込む
 *   npm run sections -- --refresh    ポスターのキャッシュを無視して取り直す
 *   npm run sections -- --no-posters ポスターを使わず文字だけの版を作る
 *
 * ■ 作品ポスターを載せている（2026-08-25〜）
 * 配信API(Movie of the Night)の返すポスターを**ビルド時に取得して合成**し、
 * 自分のドメインから配信している。再ホストの可否は提供元に照会して許諾済み。
 * 経緯・取り直しの手順は posters.mjs の冒頭と docs/APPEARANCE.md の10〜11節。
 *
 * **作中キャプチャ（本編の場面写真）は使えない。** 著作権があり、
 * 広告のある当サイトでは引用の要件を満たさない。APIが返すのもポスターと
 * キーアートだけで、本編の画像は含まれない。
 *
 * ■ 画像が取れなくても記事は崩れない
 * 署名付きURLの失効・CDN障害・オフラインで取得は必ず失敗しうる。
 * その節は**従来どおり文字だけのカード**になる。枠・日付・見出し・作品の
 * 選定ロジックは共通なので、絵の有無で情報量は変わらない。
 *
 * ■ この画像が「表の焼き直し」にならないようにしていること
 * 節の全作品を並べると、すぐ上の表と同じものが二度出て情報が過密になる。
 * そこで**その節の地の文が実際に取り上げた作品**を先頭から1〜2本だけ大きく出し、
 * 残りは「ほかN作」に畳む。読者が読む直前の文章と画像の中身が一致する。
 *
 * ■ 文字はすべてパスに変換している
 * 理由と実測結果は make-cards.mjs の冒頭を参照。フォントも同じものを使う。
 *
 * ■ 画像名が位置ではなく見出しのハッシュなのは
 * 節を並べ替えても参照が壊れないようにするため。
 */
import sharp from 'sharp'
import opentype from 'opentype.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PosterCache, isPlaceholder, loadManifest, loadWorkImages, saveManifest } from './posters.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')
const postsDir = join(root, 'src', 'content', 'posts')
const outDir = join(root, 'public', 'sections')

const W = 1200
const H = 460
const WRITE = process.argv.includes('--write')
const REFRESH = process.argv.includes('--refresh')
const NO_POSTERS = process.argv.includes('--no-posters')

/**
 * 作品行の組版（**ポスターが無いときの版**）。カードの内側に必ず収まる値にすること。
 *   1行目 ROW_TOP、以降 ROW_STEP ずつ下がり、最後に「ほかN作」が1行入る。
 *   カード下端は H - 32 なので、ROW_TOP + MAX_HIGHLIGHT * ROW_STEP < H - 44 を守る。
 */
const ROW_TOP = 302
const ROW_STEP = 54

/** 白いカードの位置。両方の版で共通 */
const CARD = { x: 40, y: 32, w: W - 80, h: H - 64 }
const PAD_X = CARD.x + 48

/**
 * ポスターの組版（**ポスターがあるときの版**）。
 *
 * ポスターは 2:3 で返ってくるので、w:h も 2:3 にして切り取りが起きないようにする。
 * カードの右側に並べ、その下に作品名と公開年を添える。
 * 左側（日付・見出し）の幅はここから逆算するので、**幅を変えると見出しの
 * 折り返しも変わる。** 数値を触ったら実際に1枚出して確認すること。
 */
const POSTER = { w: 170, h: 255, gap: 18, right: 42, top: 64, radius: 12 }

/**
 * ポスターの下の作品名・公開年のベースライン。カード下端(428)を超えないこと。
 * 公開年は**その節でいちばん行数の多い作品名に合わせて**下げる（節の中で高さが揃う）。
 */
const CAPTION = { title: 346, step: 24, size: 20, maxLines: 2, yearSize: 18 }

/** ポスターを n 枚並べたときの、左端の x 座標 */
function posterBlockX(n) {
  const width = n * POSTER.w + (n - 1) * POSTER.gap
  return CARD.x + CARD.w - POSTER.right - width
}

/** make-cards.mjs と同じ同梱フォント（SIL OFL 1.1 / scripts/fonts/OFL.txt） */
const font = {
  bold: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Bold.ttf')).buffer),
  regular: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Regular.ttf')).buffer),
}

/**
 * 画像で大きく見せる作品数。
 *
 * 節の全作品を並べると、すぐ上の表と同じものが二度出るうえに情報が過密になる。
 * **その節の地の文が実際に取り上げた作品**を先頭から拾い、この数だけ見せる。
 * 残りは「ほかN作」に畳む。
 */
const MAX_HIGHLIGHT = 2

const NO_LINE_START = '、。，．・：；！？」』）］｝〉》”’ー〜%％'

/**
 * 見出しの先頭に付く日付。**複数日にまたがる見出しもある**
 * （例:「8月6日・8月10日：」「8月25日〜8月29日：」）。
 * ここで全部を掴んでおかないと、バッジに片方しか出ず、
 * 残りが見出し本文に居座って同じ日付が2回出る。
 */
const DATE_PREFIX = /^\d{1,2}月\d{1,2}日(?:\s*[・、,／/〜～―—-]\s*(?:\d{1,2}月)?\d{1,2}日)*/

function textPath(weight, text, x, y, size) {
  const f = font[weight]
  const path = new opentype.Path()
  let cx = x
  for (const ch of [...text]) {
    const g = f.charToGlyph(ch)
    path.extend(g.getPath(cx, y, size))
    cx += (g.advanceWidth / f.unitsPerEm) * size
  }
  roundCommands(path)
  return { d: path.toPathData(2), width: cx - x }
}

/**
 * 座標を小数2桁に丸めてから toPathData() に渡す。**外すと文字が黒い塊になる。**
 * 理由は make-cards.mjs の同名関数に書いてある（opentype.js 2.0.0 の roundDecimal が
 * 小数部を指数表記の文字列にしてしまい NaN を返す）。直すときは両方直すこと。
 */
function roundCommands(path) {
  for (const c of path.commands) {
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (k in c) c[k] = Math.round(c[k] * 100) / 100
    }
  }
}

function textWidth(weight, text, size) {
  const f = font[weight]
  let w = 0
  for (const ch of [...text]) w += (f.charToGlyph(ch).advanceWidth / f.unitsPerEm) * size
  return w
}

function wrap(weight, text, size, maxWidth, maxLines) {
  const lines = []
  let line = ''
  for (const ch of [...text]) {
    if (line !== '' && textWidth(weight, line + ch, size) > maxWidth && !NO_LINE_START.includes(ch)) {
      lines.push(line)
      line = ch
      if (lines.length === maxLines) return lines
    } else {
      line += ch
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines
}

/**
 * 収まる文字サイズを選ぶ。
 *
 * ポスターを置くと見出しに使える幅が 1024 → 636 まで狭まる。
 * 36px のままだと長い見出し（実データで最長45文字）が途中で切れるので、
 * **切れない組み合わせが見つかるまで小さくしていく。**
 * 候補は大きい順に並べること。どれも収まらなければ最後の候補を使う。
 */
function fitLines(weight, text, maxWidth, candidates) {
  const total = [...text].length
  for (const c of candidates) {
    const lines = wrap(weight, text, c.size, maxWidth, c.max)
    if (lines.join('').length >= total) return { ...c, lines }
  }
  const last = candidates[candidates.length - 1]
  return { ...last, lines: wrap(weight, text, last.size, maxWidth, last.max) }
}

function ellipsize(weight, text, size, maxWidth) {
  if (textWidth(weight, text, size) <= maxWidth) return text
  let s = text
  while (s.length > 1 && textWidth(weight, s + '…', size) > maxWidth) s = s.slice(0, -1)
  return s + '…'
}

/**
 * 折り返して、入りきらなければ**最後の行に「…」を付ける。**
 * wrap() は黙って切り捨てるので、ポスターの下の作品名のように
 * 元の文字列が長い場所でそのまま使うと「途中で終わった文」に見える。
 */
function wrapClamp(weight, text, size, maxWidth, maxLines) {
  const lines = wrap(weight, text, size, maxWidth, maxLines)
  if (lines.join('').length >= [...text].length) return lines

  // 最後の行は幅いっぱいまで詰まっている。ellipsize() は「収まっている文字列」を
  // そのまま返すので使えない。「…」の分だけ削ってから足す。
  let s = lines[lines.length - 1]
  while (s.length > 1 && textWidth(weight, s + '…', size) > maxWidth) s = s.slice(0, -1)
  lines[lines.length - 1] = s + '…'
  return lines
}

// --- 収集データ（公開年を引くため） ---------------------------------------

function loadWorkYears() {
  const dir = join(repo, 'data', 'events')
  const map = new Map()
  if (!existsSync(dir)) return map
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n')) {
      if (!line) continue
      const e = JSON.parse(line)
      const title = e.work.localizedTitle ?? e.work.title
      if (title && e.work.year && !map.has(title)) map.set(title, e.work.year)
    }
  }
  return map
}

// --- 記事の解析 -----------------------------------------------------------

/** `| a | b | c |` を列の配列にする */
function cells(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/**
 * 画像を挟む対象の「小段落」を取り出す。
 *
 * 単位は**見出しではなく表**。記事によって
 *   - 日付見出しの直下に表が1つ（配信開始・配信終了済み）
 *   - 日付見出しの下に ### の小見出しがあり、その下に表（配信終了予定）
 * と構造が違うため、表を起点にして直近の見出しを主題として使う。
 *
 * 列の並びも記事によって違う（4列「終了日/作品/評価/サービス」と
 * 3列「作品/公開年/評価」）ので、**見出し行から「作品」列を探す**。
 *
 * 対象は日付の `##` 見出しの配下だけ。全作品リストやまとめには入れない。
 */
function parseBlocks(md) {
  const lines = md.split('\n')
  const out = []
  let dateHeading = null // 直近の `## ○月○日…`
  let subHeading = null // その下の `### …`

  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^## +(.*)$/)
    if (h2) {
      const t = h2[1].trim()
      dateHeading = /^\d{1,2}月\d{1,2}日/.test(t) ? t : null
      subHeading = null
      continue
    }
    const h3 = lines[i].match(/^### +(.*)$/)
    if (h3) {
      subHeading = h3[1].trim()
      continue
    }
    if (!lines[i].startsWith('|') || !dateHeading) continue

    // 表の範囲
    const tableStart = i
    let j = i
    while (j < lines.length && lines[j].startsWith('|')) j++
    const tableEnd = j - 1
    i = tableEnd

    const header = cells(lines[tableStart])
    const titleCol = header.findIndex((c) => c === '作品')
    if (titleCol < 0) continue
    const ratingCol = header.findIndex((c) => c.includes('評価'))

    const rows = []
    // 1行目は見出し、2行目は区切り
    for (const l of lines.slice(tableStart + 2, tableEnd + 1)) {
      const c = cells(l)
      const title = c[titleCol]
      if (title) rows.push({ title, rating: ratingCol >= 0 ? (c[ratingCol] ?? '') : '' })
    }
    if (rows.length === 0) continue

    // 既に挿し込んである画像があれば、その行を差し替える（再実行できるように）
    let k = tableEnd + 1
    while (k < lines.length && lines[k].trim() === '') k++
    const imageLine = lines[k]?.startsWith('![') ? k : -1

    // 表のあとから次の見出し／次の表までが、その小段落の地の文
    let p = imageLine >= 0 ? imageLine + 1 : tableEnd + 1
    const prose = []
    while (p < lines.length && !/^#{2,3} /.test(lines[p]) && !lines[p].startsWith('|')) {
      if (lines[p].trim()) prose.push(lines[p])
      p++
    }

    out.push({
      dateLabel: DATE_PREFIX.exec(dateHeading)[0],
      heading: subHeading ?? dateHeading,
      imageLine,
      tableEnd,
      rows,
      prose: prose.join('\n'),
    })
    subHeading = null
  }
  return out
}

/**
 * 画像で大きく見せる作品を選ぶ。
 *
 * 地の文が触れた作品を**登場順に**拾う。読者が読む直前の文章と、
 * 画像に出る作品が一致するのが狙い。
 * 地の文がどれにも触れていない節（表だけの節）は評価の高い順で代替する。
 */
function pickHighlights(section) {
  const mentioned = section.rows
    .map((r) => ({ ...r, at: section.prose.indexOf(r.title) }))
    .filter((r) => r.at >= 0)
    .sort((a, b) => a.at - b.at)

  if (mentioned.length > 0) return mentioned.slice(0, MAX_HIGHLIGHT)

  return [...section.rows]
    .sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0))
    .slice(0, MAX_HIGHLIGHT)
}

// --- 画像 -----------------------------------------------------------------

/**
 * 節の画像の SVG を組む。
 *
 * `posters` に枚数を渡すと**ポスターを置く前提の組版**になる。
 * SVG 側はポスターの下敷き（角丸の板）と作品名だけを描き、
 * 絵そのものは sharp の composite であとから重ねる。
 * 0 を渡すと従来どおり文字だけの版になる。**両方を保守すること。**
 */
function buildSvg(section, years, posters = 0) {
  // 日付はバッジで別に出すので、主題からは前置きを外す
  const dateLabel = section.dateLabel
  const theme = section.heading.replace(new RegExp(DATE_PREFIX.source + '[：:]\\s*'), '')

  // 地の文が取り上げた作品を大きく見せる。残りは件数だけ添える。
  const shown = pickHighlights(section).map((r) => ({ ...r, year: years.get(r.title) }))
  const rest = section.rows.length - shown.length

  const padX = PAD_X
  // ポスターを置くぶんだけ、文字に使える幅が狭くなる
  const innerW = posters > 0 ? posterBlockX(posters) - 36 - padX : CARD.w - 96

  const parts = []
  parts.push(`<rect width="${W}" height="${H}" fill="#1b3a6e"/>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#dots)"/>`)
  parts.push(
    `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="20" fill="#ffffff"/>`,
  )

  // 日付バッジ
  if (dateLabel) {
    const t = textPath('bold', dateLabel, 0, 0, 24)
    parts.push(`<rect x="${padX}" y="66" width="${(t.width + 36).toFixed(1)}" height="42" rx="21" fill="#e8f0fe"/>`)
    parts.push(`<path d="${textPath('bold', dateLabel, padX + 18, 95, 24).d}" fill="#1a5fd0"/>`)
  }

  if (posters === 0) {
    // --- 文字だけの版（ポスターが取れなかったとき） ---
    wrap('bold', theme, 36, innerW, 2).forEach((l, i) => {
      parts.push(`<path d="${textPath('bold', l, padX, 160 + i * 50, 36).d}" fill="#1a1d21"/>`)
    })

    parts.push(
      `<line x1="${padX}" y1="248" x2="${W - padX}" y2="248" stroke="#e3e6ea" stroke-width="2"/>`,
    )

    // 取り上げた作品。公開年は右端に寄せる。
    const titleSize = 40
    shown.forEach((w, i) => {
      const y = ROW_TOP + i * ROW_STEP
      const yearText = w.year ? `${w.year}年` : ''
      const yearW = yearText ? textWidth('bold', yearText, 26) : 0
      const title = ellipsize('bold', w.title, titleSize, innerW - yearW - 32)
      parts.push(`<path d="${textPath('bold', title, padX, y, titleSize).d}" fill="#1a1d21"/>`)
      if (yearText) {
        parts.push(
          `<path d="${textPath('bold', yearText, W - padX - yearW, y, 26).d}" fill="#1f6feb"/>`,
        )
      }
    })

    if (rest > 0) {
      const y = ROW_TOP + shown.length * ROW_STEP - 8
      parts.push(`<path d="${textPath('regular', `ほか${rest}作`, padX, y, 26).d}" fill="#5c646e"/>`)
    }
  } else {
    // --- ポスターを置く版 ---
    // 見出しは幅が狭いぶん、収まるサイズを選び直す
    const fit = fitLines('bold', theme, innerW, [
      { size: 36, max: 2 },
      { size: 31, max: 3 },
      { size: 27, max: 3 },
    ])
    const step = Math.round(fit.size * 1.38)
    fit.lines.forEach((l, i) => {
      parts.push(`<path d="${textPath('bold', l, padX, 168 + i * step, fit.size).d}" fill="#1a1d21"/>`)
    })

    const dividerY = 168 + (fit.lines.length - 1) * step + 34
    parts.push(
      `<line x1="${padX}" y1="${dividerY}" x2="${posterBlockX(posters) - 36}" y2="${dividerY}" stroke="#e3e6ea" stroke-width="2"/>`,
    )

    // 「ほかN作」は罫線のすぐ下に置く。カード下端に単独で浮かせると、
    // 左側だけ大きく空いて配置が崩れて見える。
    if (rest > 0) {
      parts.push(
        `<path d="${textPath('regular', `ほか${rest}作`, padX, dividerY + 44, 26).d}" fill="#5c646e"/>`,
      )
    }

    // ポスターの下敷きと、その下の作品名・公開年
    const blockX = posterBlockX(posters)
    const captions = shown
      .slice(0, posters)
      .map((w) => wrapClamp('bold', w.title, CAPTION.size, POSTER.w, CAPTION.maxLines))
    const yearY = CAPTION.title + Math.max(...captions.map((c) => c.length)) * CAPTION.step

    shown.slice(0, posters).forEach((w, i) => {
      const x = blockX + i * (POSTER.w + POSTER.gap)
      parts.push(
        `<rect x="${x}" y="${POSTER.top}" width="${POSTER.w}" height="${POSTER.h}" rx="${POSTER.radius}" fill="#eef1f5"/>`,
      )

      captions[i].forEach((l, k) => {
        parts.push(
          `<path d="${textPath('bold', l, x, CAPTION.title + k * CAPTION.step, CAPTION.size).d}" fill="#1a1d21"/>`,
        )
      })

      if (w.year) {
        parts.push(
          `<path d="${textPath('bold', `${w.year}年`, x, yearY, CAPTION.yearSize).d}" fill="#1f6feb"/>`,
        )
      }
    })
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="#aed0ff" fill-opacity="0.13"/>
    </pattern>
  </defs>
  ${parts.join('\n  ')}
</svg>`
}

function nameFor(slug, heading) {
  const h = createHash('sha1').update(`${slug}\n${heading}`).digest('hex').slice(0, 8)
  return `${slug}-${h}.jpg`
}

function altFor(section, years) {
  const shown = pickHighlights(section).map((r) => {
    const y = years.get(r.title)
    return y ? `${r.title}（${y}年）` : r.title
  })
  const rest = section.rows.length - shown.length
  return `${section.heading}。${shown.join('、')}${rest > 0 ? `ほか${rest}作` : ''}`
}

// --- 実行 -----------------------------------------------------------------

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const years = loadWorkYears()

/**
 * 画像の出どころは2つある。**期限が先のほうを採る。**
 *   収集ログ(data/events)      … 収集した時点の署名付きURL
 *   台帳(data/image-manifest)  … refresh:images で取り直した新しいURL
 * 取り直した直後は台帳のほうが新しく、まだ取り直していなければ収集ログしかない。
 */
const workImages = NO_POSTERS ? new Map() : loadWorkImages(repo)
const manifest = loadManifest(repo)
const manifestByTitle = new Map(
  Object.values(manifest.works ?? {}).map((w) => [w.title, w]),
)
const posters = NO_POSTERS ? null : new PosterCache(repo, { force: REFRESH })

/** サイトが実際に使った作品だけを台帳に残す。取り直しの対象を絞るため。 */
const usedWorks = {}

function imageFor(title) {
  const found = [manifestByTitle.get(title), workImages.get(title)]
    .filter((w) => w?.url && !isPlaceholder(w.url))
    .sort((a, b) => (b.expiresAt ?? '').localeCompare(a.expiresAt ?? ''))[0]
  if (found) {
    usedWorks[found.id] = {
      id: found.id,
      title: found.title,
      url: found.url,
      expiresAt: found.expiresAt,
    }
  }
  return found
}

let images = 0
let inserted = 0
let withPosters = 0

for (const file of readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
  const slug = file.replace(/\.md$/, '')
  const path = join(postsDir, file)
  let md = readFileSync(path, 'utf8')
  const sections = parseBlocks(md)
  if (sections.length === 0) continue

  for (const s of sections) {
    const name = nameFor(slug, s.heading)
    const out = join(outDir, name)
    const shown = pickHighlights(s)

    /*
     * ポスターは**その節の全員ぶん揃ったときだけ**使う。
     * 1枚だけ欠けた状態で並べると、空の板が残って事故に見える。
     * 揃わない節は文字だけの版に戻す（情報量は変わらない）。
     */
    let arts = []
    if (posters) {
      arts = await Promise.all(
        shown.map((w) => {
          const src = imageFor(w.title)
          return src
            ? posters.thumbnail(src.url, POSTER.w, POSTER.h, {
                radius: POSTER.radius,
                label: w.title,
              })
            : null
        }),
      )
      if (!(arts.length > 0 && arts.every(Boolean))) arts = []
    }

    const image = sharp(Buffer.from(buildSvg(s, years, arts.length)))
    if (arts.length > 0) {
      const blockX = posterBlockX(arts.length)
      image.composite(
        arts.map((input, i) => ({
          input,
          left: blockX + i * (POSTER.w + POSTER.gap),
          top: POSTER.top,
        })),
      )
      withPosters++
    }
    await image.jpeg({ quality: 88, mozjpeg: true }).toFile(out)
    images++
  }

  if (!WRITE) continue

  // 後ろの節から挿し込む。前から入れると行番号がずれるため。
  const lines = md.split('\n')
  for (const s of [...sections].reverse()) {
    const ref = `![${altFor(s, years)}](/sections/${nameFor(slug, s.heading)})`
    if (s.imageLine >= 0) {
      if (lines[s.imageLine] === ref) continue
      lines[s.imageLine] = ref
    } else {
      lines.splice(s.tableEnd + 1, 0, '', ref)
    }
    inserted++
  }
  const next = lines.join('\n')
  if (next !== md) {
    writeFileSync(path, next)
    md = next
  }
}

console.log(
  `セクション画像: ${images}枚を生成` +
    (posters ? `（うちポスター入り ${withPosters}枚）` : '（ポスターなし）') +
    (WRITE ? ` / 参照 ${inserted}件を記事に反映` : ''),
)

if (posters) {
  posters.report()
  // 台帳は「サイトが使った作品」だけに絞って書き直す。
  // 使わなくなった作品を残すと、取り直し(refresh:images)が無駄にAPIを叩く。
  saveManifest(repo, usedWorks)
}
