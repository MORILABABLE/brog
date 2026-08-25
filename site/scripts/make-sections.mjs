/**
 * 記事のセクション（`## ○月○日：…`）ごとに、本文へ挟む画像を生成する。
 *
 *   npm run sections            画像だけ作る（prebuild が自動で呼ぶ）
 *   npm run sections -- --write 記事の Markdown に画像の参照も挿し込む
 *   npm run sections -- --refresh    ポスターのキャッシュを無視して取り直す
 *   npm run sections -- --no-posters ポスターを使わず文字だけの版を作る
 *
 * ■ 出力は2種類ある
 *
 *   ポスターが揃った節 … `public/sections/posters/<節>-1.webp` … **絵だけ**。
 *                        枠も日付も見出しも描かない。導線リンクで包んで挿す
 *   揃わなかった節     … `public/sections/<節>.jpg` … 従来の枠つきカード
 *
 * **絵に文字を描かないのは、すぐ上の小見出しと重複するから**（2026-08-25 の変更）。
 * 日付も主題も作品名も見出しに書いてある。画像にも入れると同じ文字が2回出る。
 * 文字情報は代替テキストと、すぐ下の表に残してある。
 *
 * ■ 配置は「小見出しの直後」
 * 見出し → 画像 → 表 → 地の文 の順。読者が節に入った瞬間に絵が目に入る。
 * 旧位置（表の直後）に残っている画像は `--write` が消してから入れ直す。
 *
 * ■ 作品ポスターについて
 * 配信API(Movie of the Night)の返すポスターを**ビルド時に取得**し、
 * 自分のドメインから配信している。再ホストは提供元に照会して許諾済み。
 * 経緯・取り直しの手順は posters.mjs の冒頭と docs/APPEARANCE.md の10〜11節。
 *
 * **作中キャプチャ（本編の場面写真）は使えない。** 著作権があり、
 * 広告のある当サイトでは引用の要件を満たさない。APIが返すのもポスターと
 * キーアートだけで、本編の画像は含まれない。
 *
 * ■ 画像が取れなくても記事は崩れない
 * 署名付きURLの失効・CDN障害・オフラインで取得は必ず失敗しうる。
 * その節は**文字だけのカード**になる。作品の選定ロジックは共通なので、
 * 絵の有無で読者が受け取る情報は変わらない。
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
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  PosterCache,
  isPlaceholder,
  loadManifest,
  loadWorkImages,
  posterLink,
  saveManifest,
} from './posters.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')
const postsDir = join(root, 'src', 'content', 'posts')
/** 文字だけの版（枠つきのカード画像） */
const outDir = join(root, 'public', 'sections')
/**
 * ポスターの版。**別ディレクトリなのは CSS で区別するため。**
 * 枠つきのカードは幅いっぱい＋輪郭線、ポスターは絵だけで枠なし、と扱いが逆になる。
 * styles/global.css の `img[src^='/sections/posters/']` を参照。
 */
const posterDir = join(outDir, 'posters')
/**
 * 記事ごとのヘッダー画像。frontmatter の `heroImage` から参照される。
 * 記事一覧のカードの左サムネイルと、記事ページの見出し上に出る。
 */
const heroDir = join(root, 'public', 'heroes')

const W = 1200
/**
 * 文字だけの版の高さ。
 * **見出しを描かなくなったぶん低い**（2026-08-25 に 460 → 350）。
 * すぐ上に小見出しがあるので、画像にまで主題を書くと同じ文字が2回出る。
 * 描くのは「日付」と「取り上げた作品」だけにしてある。
 */
const H = 350
const WRITE = process.argv.includes('--write')
const REFRESH = process.argv.includes('--refresh')
const NO_POSTERS = process.argv.includes('--no-posters')

/**
 * 作品行の組版（**ポスターが無いときの版**）。カードの内側に必ず収まる値にすること。
 *   1行目 ROW_TOP、以降 ROW_STEP ずつ下がり、最後に「ほかN作」が1行入る。
 *   カード下端は H - 32 なので、ROW_TOP + MAX_HIGHLIGHT * ROW_STEP < H - 44 を守る。
 */
const ROW_TOP = 196
const ROW_STEP = 54

/** 日付バッジと作品行を分ける罫線の位置 */
const DIVIDER_Y = 140

/** 白いカードの位置。両方の版で共通 */
const CARD = { x: 40, y: 32, w: W - 80, h: H - 64 }
const PAD_X = CARD.x + 48

/**
 * 書き出すポスター1枚の大きさ。
 *
 * APIから来る元画像が 480×720（2:3）なので、同じ値にして拡大も切り取りも起こさない。
 * 表示側は CSS で高さを抑える（`max-height`）。画面上は約280px高になるので、
 * 高解像度ディスプレイでも粗くならない。
 */
const POSTER = { w: 480, h: 720 }

/** make-cards.mjs と同じ同梱フォント（SIL OFL 1.1 / scripts/fonts/OFL.txt） */
const font = {
  bold: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Bold.ttf')).buffer),
  regular: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Regular.ttf')).buffer),
}

/**
 * 記事のヘッダー画像（frontmatter の `heroImage`）に使う作品を選ぶときの、
 * 記事タイトルとの一致とみなす最短の文字数。
 *
 * 短くしすぎると事故る。「日常」（2文字）のような作品名は、
 * 記事タイトルの地の文にたまたま出てくる。4文字あれば実データでは誤爆しない。
 * 逆に**短い題名の作品は選ばれない**。その場合は次点の規則（記事の最初の画像）に落ちる。
 */
const HERO_MATCH_MIN = 4

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

/**
 * 画像の行か。`![…](…)` と、リンクで包んだ `[![…](…)](…)` の両方を拾う。
 * ポスターにはアフィリエイトの導線を付けているので後者の形になる。
 */
function isImageLine(line) {
  return typeof line === 'string' && (line.startsWith('![') || line.startsWith('[!['))
}

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
 *
 * ■ 行番号を3つ返している理由
 * 画像の挿し込み位置を「表の直後」から「**見出しの直後**」に移した（2026-08-25）。
 * 過去に書いた記事には旧位置の画像が残っているので、
 *   headingLine  … いま入れる場所
 *   imageLine    … 新位置に既にある画像（差し替える）
 *   staleImageLine … 旧位置に残っている画像（消す）
 * の3つを持って、再実行しても同じ結果になるようにしている。
 */
function parseBlocks(md) {
  const lines = md.split('\n')
  const out = []
  let dateHeading = null // 直近の `## ○月○日…`
  let dateHeadingLine = -1
  let subHeading = null // その下の `### …`
  let subHeadingLine = -1

  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^## +(.*)$/)
    if (h2) {
      const t = h2[1].trim()
      dateHeading = /^\d{1,2}月\d{1,2}日/.test(t) ? t : null
      dateHeadingLine = i
      subHeading = null
      subHeadingLine = -1
      continue
    }
    const h3 = lines[i].match(/^### +(.*)$/)
    if (h3) {
      subHeading = h3[1].trim()
      subHeadingLine = i
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

    const headingLine = subHeadingLine >= 0 ? subHeadingLine : dateHeadingLine

    // 旧位置（表の直後）に残っている画像。見つけたら消す。
    let k = tableEnd + 1
    while (k < lines.length && lines[k].trim() === '') k++
    const staleImageLine = isImageLine(lines[k]) ? k : -1

    // 新位置（見出しの直後）に既にある画像。あれば差し替える。
    let h = headingLine + 1
    while (h < lines.length && lines[h].trim() === '') h++
    const imageLine = isImageLine(lines[h]) ? h : -1

    // 表のあとから次の見出し／次の表までが、その小段落の地の文
    let p = staleImageLine >= 0 ? staleImageLine + 1 : tableEnd + 1
    const prose = []
    while (p < lines.length && !/^#{2,3} /.test(lines[p]) && !lines[p].startsWith('|')) {
      if (lines[p].trim()) prose.push(lines[p])
      p++
    }

    out.push({
      dateLabel: DATE_PREFIX.exec(dateHeading)[0],
      heading: subHeading ?? dateHeading,
      headingLine,
      imageLine,
      staleImageLine,
      tableEnd,
      rows,
      prose: prose.join('\n'),
    })
    subHeading = null
    subHeadingLine = -1
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
 * 文字だけの版の SVG を組む。**ポスターが取れなかった節だけがこれになる。**
 *
 * ポスターがある節は絵をそのまま置くので、この関数を通らない。
 * 契約を終えたときはサイト全体がこの版に戻るので、**消さないこと。**
 */
function buildSvg(section, years) {
  const dateLabel = section.dateLabel

  // 地の文が取り上げた作品を大きく見せる。残りは件数だけ添える。
  const shown = pickHighlights(section).map((r) => ({ ...r, year: years.get(r.title) }))
  const rest = section.rows.length - shown.length

  const padX = PAD_X
  const innerW = CARD.w - 96

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

  /*
   * ★ 節の主題（見出し）は**描かない**。
   *   この画像は小見出しの直後に入るので、同じ文字がすぐ上に出ている。
   *   ここに描くのは、見出しに必ずしも書かれていない
   *   「取り上げた作品と公開年」だけにする（2026-08-25 の変更）。
   *   見出しを含む説明は代替テキスト（altFor）に入っている。
   */
  parts.push(
    `<line x1="${padX}" y1="${DIVIDER_Y}" x2="${W - padX}" y2="${DIVIDER_Y}" stroke="#e3e6ea" stroke-width="2"/>`,
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

/** 節を一意に指す8桁。見出しから作るので、節を並べ替えても参照が壊れない。 */
function hashFor(slug, heading) {
  return createHash('sha1').update(`${slug}\n${heading}`).digest('hex').slice(0, 8)
}

/** 文字だけの版のファイル名 */
function nameFor(slug, heading) {
  return `${slug}-${hashFor(slug, heading)}.jpg`
}

/** ポスター1枚のファイル名。節の中の並び順で連番にする。 */
function posterNameFor(slug, heading, index) {
  return `${slug}-${hashFor(slug, heading)}-${index + 1}.webp`
}

/**
 * 文字だけの版の代替テキスト。**画像に描いてある内容をそのまま書く。**
 */
function altFor(section, years) {
  const shown = pickHighlights(section).map((r) => labelFor(r.title, years))
  const rest = section.rows.length - shown.length
  return `${section.heading}。${shown.join('、')}${rest > 0 ? `ほか${rest}作` : ''}`
}

/** 「作品名（公開年）」。ポスターの代替テキストに使う。 */
function labelFor(title, years) {
  const y = years.get(title)
  return y ? `${title}（${y}年）` : title
}

// --- 記事のヘッダー画像（heroImage） --------------------------------------

/** frontmatter を雑に読む。**書き換えはしない**ので、YAMLパーサは持ち込まない。 */
function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return null
  const body = m[1]
  const read = (key) => {
    const hit = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(body)
    if (!hit) return undefined
    return hit[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return {
    title: read('title') ?? '',
    heroImage: read('heroImage'),
    /** 閉じの `---` の行番号。ここの直前に足せば必ず frontmatter の中に入る */
    endLine: md.slice(0, m.index + m[0].length).split('\n').length - 1,
  }
}

/**
 * 記事タイトルと作品名の一致の強さ。一致しなければ 0。
 *
 * 記事タイトルに作品名がそのまま入っているとは限らない。
 * 「クレヨンしんちゃん劇場版」に対して作品名は
 * 「クレヨンしんちゃん ブリブリ王国の秘宝」のように**後ろが長い**。
 * そこで作品名を後ろから削りながら、記事タイトルに含まれる
 * いちばん長い前方一致を探す。長く一致したものほど強い。
 */
function titleMatchScore(articleTitle, workTitle) {
  const chars = [...workTitle]
  for (let n = chars.length; n >= HERO_MATCH_MIN; n--) {
    if (articleTitle.includes(chars.slice(0, n).join(''))) return n
  }
  return 0
}

/**
 * ヘッダー画像の候補を、**使いたい順**に返す。
 *
 *   1. 記事タイトルと一致する作品（一致が長い順）
 *   2. 記事に最初に出てくる作品（＝いちばん上の節で取り上げた作品）
 *
 * 実際にどれを使うかは、ポスターが取れるかどうかで決まる。
 * 呼び出し側が先頭から試して、最初に取れたものを採用する。
 */
function heroCandidates(sections, articleTitle) {
  const seen = new Set()
  const all = []
  for (const [order, s] of sections.entries()) {
    for (const r of s.rows) {
      if (seen.has(r.title)) continue
      seen.add(r.title)
      all.push({ title: r.title, order })
    }
  }

  const matched = all
    .map((c) => ({ ...c, score: titleMatchScore(articleTitle, c.title) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)

  // 次点。記事の先頭の節が取り上げた作品を、地の文の順で。
  const firstShown = sections.length > 0 ? pickHighlights(sections[0]).map((r) => r.title) : []

  const out = []
  for (const t of [...matched.map((m) => m.title), ...firstShown, ...all.map((a) => a.title)]) {
    if (!out.includes(t)) out.push(t)
  }
  return out
}

// --- 実行 -----------------------------------------------------------------

mkdirSync(posterDir, { recursive: true }) // outDir も一緒にできる
mkdirSync(heroDir, { recursive: true })
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
let withText = 0
let heroes = 0
let heroesWritten = 0

for (const file of readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
  const slug = file.replace(/\.md$/, '')
  const path = join(postsDir, file)
  let md = readFileSync(path, 'utf8')
  const sections = parseBlocks(md)
  if (sections.length === 0) continue

  /** 節ごとの挿し込む1行。生成の結果（ポスターが揃ったか）で形が変わる。 */
  const refs = new Map()

  for (const s of sections) {
    const shown = pickHighlights(s)

    /*
     * ポスターは**その節の全員ぶん揃ったときだけ**使う。
     * 1枚だけ欠けた状態で並べると、片方だけ絵という中途半端な見た目になる。
     * 揃わない節は文字だけの版に戻す（情報量は変わらない）。
     */
    let arts = []
    if (posters) {
      arts = await Promise.all(
        shown.map((w) => {
          const src = imageFor(w.title)
          return src ? posters.poster(src.url, POSTER.w, POSTER.h, { label: w.title }) : null
        }),
      )
      if (!(arts.length > 0 && arts.every(Boolean))) arts = []
    }

    if (arts.length > 0) {
      /*
       * ポスターがある節は**絵だけ**を置く。枠も日付も見出しも描かない。
       * すぐ上の小見出しに同じ日付と主題が書いてあるので、
       * 画像にも入れると同じ文字が2回出て冗長になる（2026-08-25 の変更）。
       * 文字情報は代替テキストと、すぐ下の表に残っている。
       */
      const links = []
      for (const [i, buf] of arts.entries()) {
        const name = posterNameFor(slug, s.heading, i)
        writeFileSync(join(posterDir, name), buf)
        const label = labelFor(shown[i].title, years)
        // 導線リンク。トラッキングIDはビルド時に rehype-affiliate が付ける。
        links.push(`[![${label}](/sections/posters/${name})](${posterLink(shown[i].title)})`)
        images++
      }
      refs.set(s.heading, links.join(' '))
      withPosters++
    } else {
      const name = nameFor(slug, s.heading)
      await sharp(Buffer.from(buildSvg(s, years, 0)))
        .jpeg({ quality: 88, mozjpeg: true })
        .toFile(join(outDir, name))
      refs.set(s.heading, `![${altFor(s, years)}](/sections/${name})`)
      images++
      withText++
    }
  }

  /*
   * 記事のヘッダー画像。
   *
   *   1. 記事タイトルと一致する作品のポスター
   *   2. 取れなければ、記事に最初に出てくる作品のポスター
   *
   * **人が指定した heroImage は絶対に触らない。**
   * 自分で入れた `/heroes/<スラッグ>.webp` だけを作り直す。
   * 気に入らない絵は frontmatter を書き換えれば固定できる（好きな画像を
   * `site/public/` に置いて、そのパスを書けばよい）。
   */
  const fm = frontmatter(md)
  const heroPath = `/heroes/${slug}.webp`
  let heroRef = null

  if (posters && fm && (!fm.heroImage || fm.heroImage === heroPath)) {
    for (const title of heroCandidates(sections, fm.title)) {
      const src = imageFor(title)
      if (!src) continue
      const buf = await posters.poster(src.url, POSTER.w, POSTER.h, { label: title })
      if (!buf) continue
      writeFileSync(join(heroDir, `${slug}.webp`), buf)
      heroRef = heroPath
      heroes++
      break
    }
  }

  if (!WRITE) continue

  // 後ろの節から処理する。前から触ると行番号がずれるため。
  const lines = md.split('\n')
  for (const s of [...sections].reverse()) {
    const ref = refs.get(s.heading)
    if (!ref) continue

    /*
     * 旧位置（表の直後）に残っている画像を先に消す。
     * **消す→入れる の順でなければならない。** 消す行は入れる行より下にあるので、
     * 先に入れると行番号がずれて別の行を消してしまう。
     */
    if (s.staleImageLine >= 0) {
      const blankAfter = lines[s.staleImageLine + 1]?.trim() === ''
      lines.splice(s.staleImageLine, blankAfter ? 2 : 1)
    }

    if (s.imageLine >= 0) {
      if (lines[s.imageLine] === ref && s.staleImageLine < 0) continue
      lines[s.imageLine] = ref
    } else {
      lines.splice(s.headingLine + 1, 0, '', ref)
    }
    inserted++
  }

  /*
   * frontmatter は**最後に触る**。ここは記事の先頭なので、
   * 先に1行足すと上で数えた節の行番号がすべて1つずれる。
   */
  if (heroRef && fm) {
    const at = lines.findIndex((l, i) => i < fm.endLine && /^heroImage:/.test(l))
    const line = `heroImage: '${heroRef}'`
    if (at >= 0) {
      if (lines[at] !== line) {
        lines[at] = line
        heroesWritten++
      }
    } else {
      lines.splice(fm.endLine, 0, line)
      heroesWritten++
    }
  }

  const next = lines.join('\n')
  if (next !== md) {
    writeFileSync(path, next)
    md = next
  }
}

console.log(
  `セクション画像: ${images}枚を生成` +
    `（ポスターの節 ${withPosters} / 文字だけの節 ${withText}）` +
    (WRITE ? ` / 参照 ${inserted}件を記事に反映` : ''),
)
console.log(
  `ヘッダー画像: ${heroes}本の記事に用意` +
    (WRITE ? ` / frontmatter ${heroesWritten}件を更新` : ''),
)

if (posters) {
  posters.report()
  // 台帳は「サイトが使った作品」だけに絞って書き直す。
  // 使わなくなった作品を残すと、取り直し(refresh:images)が無駄にAPIを叩く。
  saveManifest(repo, usedWorks)
}
