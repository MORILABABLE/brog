/**
 * 記事のセクション（`## ○月○日：…`）ごとに、本文へ挟む画像を生成する。
 *
 *   npm run sections           画像だけ作る（prebuild が自動で呼ぶ）
 *   npm run sections -- --write 記事の Markdown に画像の参照も挿し込む
 *
 * ■ なぜ作品の場面写真ではないのか
 * 作中キャプチャは著作権があり、広告のある当サイトでは使えない。
 * 配信APIが返すのもポスターとキーアートだけで、本編の画像は無い。
 * 詳細は docs/APPEARANCE.md の9節。
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

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')
const postsDir = join(root, 'src', 'content', 'posts')
const outDir = join(root, 'public', 'sections')

const W = 1200
const H = 460
const WRITE = process.argv.includes('--write')

/**
 * 作品行の組版。カードの内側に必ず収まる値にすること。
 *   1行目 ROW_TOP、以降 ROW_STEP ずつ下がり、最後に「ほかN作」が1行入る。
 *   カード下端は H - 32 なので、ROW_TOP + MAX_HIGHLIGHT * ROW_STEP < H - 44 を守る。
 */
const ROW_TOP = 302
const ROW_STEP = 54

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

function textPath(weight, text, x, y, size) {
  const f = font[weight]
  const path = new opentype.Path()
  let cx = x
  for (const ch of [...text]) {
    const g = f.charToGlyph(ch)
    path.extend(g.getPath(cx, y, size))
    cx += (g.advanceWidth / f.unitsPerEm) * size
  }
  return { d: path.toPathData(2), width: cx - x }
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

function ellipsize(weight, text, size, maxWidth) {
  if (textWidth(weight, text, size) <= maxWidth) return text
  let s = text
  while (s.length > 1 && textWidth(weight, s + '…', size) > maxWidth) s = s.slice(0, -1)
  return s + '…'
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
      dateLabel: dateHeading.match(/^(\d{1,2}月\d{1,2}日)/)[1],
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

function buildSvg(section, years) {
  // 日付はバッジで別に出すので、主題からは前置きを外す
  const dateLabel = section.dateLabel
  const theme = section.heading.replace(/^\d{1,2}月\d{1,2}日[：:]\s*/, '')

  // 地の文が取り上げた作品を大きく見せる。残りは件数だけ添える。
  const shown = pickHighlights(section).map((r) => ({ ...r, year: years.get(r.title) }))
  const rest = section.rows.length - shown.length

  const cardX = 40
  const cardW = W - cardX * 2
  const padX = cardX + 48
  const innerW = cardW - 96

  const parts = []
  parts.push(`<rect width="${W}" height="${H}" fill="#1b3a6e"/>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#dots)"/>`)
  parts.push(`<rect x="${cardX}" y="32" width="${cardW}" height="${H - 64}" rx="20" fill="#ffffff"/>`)

  // 日付バッジ
  if (dateLabel) {
    const t = textPath('bold', dateLabel, 0, 0, 24)
    parts.push(`<rect x="${padX}" y="66" width="${(t.width + 36).toFixed(1)}" height="42" rx="21" fill="#e8f0fe"/>`)
    parts.push(`<path d="${textPath('bold', dateLabel, padX + 18, 95, 24).d}" fill="#1a5fd0"/>`)
  }

  // 節の主題（見出しから日付を除いたもの）
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

let images = 0
let inserted = 0

for (const file of readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
  const slug = file.replace(/\.md$/, '')
  const path = join(postsDir, file)
  let md = readFileSync(path, 'utf8')
  const sections = parseBlocks(md)
  if (sections.length === 0) continue

  for (const s of sections) {
    const name = nameFor(slug, s.heading)
    const out = join(outDir, name)
    await sharp(Buffer.from(buildSvg(s, years))).jpeg({ quality: 88, mozjpeg: true }).toFile(out)
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

console.log(`セクション画像: ${images}枚を生成${WRITE ? ` / 参照 ${inserted}件を記事に反映` : ''}`)
