/**
 * ショート動画のカット画像を、台本（`shorts/<スラッグ>.md`）から生成する。
 *
 *   cd site
 *   npm run shorts                     全部の台本ぶんを作る
 *   npm run shorts -- --slug 2026-08-leaving-netflix   1本だけ
 *   npm run shorts -- --guides         安全領域のガイドを重ねる（位置合わせ用）
 *
 * 出力は `shorts/frames/<スラッグ>/01.png`（1080 × 1920）。
 * これを動画編集ソフトに並べ、台本のナレーションを載せれば30秒になる。
 *
 * ■ なぜ作品ポスターを使わないのか（重要）
 * サイトの記事にはAPIが返す作品ポスターを載せているが、**動画には使えない。**
 * 提供元から得た許諾は「自分のドメインから再ホストしてよい」であって、
 * 第三者プラットフォームへの動画素材としての投稿は含まれない。
 * さらに YouTube へのアップロードは、YouTube に対する再許諾可能なライセンスの
 * 付与を意味する。**再ホストの許可しか持っていない画像について、それは出せない。**
 * 決定的なのは、このリポジトリが「契約を終えたら画像を全部消す」前提で
 * 組んであること（docs/APPEARANCE.md 11節）。公開した動画は同じようには消せない。
 *
 * → **ここで描くのは自前生成の文字だけ。第三者の権利が一切絡まない。**
 *   make-cards.mjs / make-sections.mjs と同じ考え方で、同じ手法を縦に使っている。
 *
 * ■ 文字はすべてパスに変換している
 * 理由と実測結果は make-cards.mjs の冒頭にある。フォントも同じものを使う。
 * （SVG の <text> だと描画するマシンのフォントに依存し、日本語が豆腐になる）
 *
 * ■ 安全領域
 * YouTube ショートの再生画面は、**下部にタイトル・チャンネル名、右下にボタン**が重なる。
 * 文字をそこに置くと本番で読めない。SAFE の値がその余白で、`--guides` で目視できる。
 */
import sharp from 'sharp'
import opentype from 'opentype.js'
import { readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')
/** 台本の置き場。**リポジトリ直下**（site/ の外）。ユーザーが手で開いて直すファイル。 */
const shortsDir = join(repo, 'shorts')
const framesDir = join(shortsDir, 'frames')

/** ショートの標準的な画面。9:16 */
const W = 1080
const H = 1920

/**
 * 再生画面のUIが重なる余白。**ここに文字を置くと本番で読めない。**
 * 下が厚いのは、タイトル・チャンネル名・説明の1行目がそこに出るため。
 * 右は「いいね／コメント／共有」の縦並びのボタン列。
 */
const SAFE = { top: 220, bottom: 420, left: 80, right: 200 }

/**
 * 配色。make-sections.mjs の背景（#1b3a6e）と同系で、**動画用に一段暗くしてある。**
 * スマホの小さい画面で白文字を読ませるため、記事の画像より背景と文字の差を大きく取る。
 */
const COLOR = {
  bg: '#12294e',
  bgDots: '#aed0ff',
  caption: '#ffffff',
  note: '#8fc0ff',
  noteBg: '#1b3a6e',
  accent: '#4d9dff',
  brand: '#7fa8dc',
}

/** 同梱フォント（SIL Open Font License 1.1 / scripts/fonts/OFL.txt） */
const font = {
  bold: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Bold.ttf')).buffer),
  regular: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Regular.ttf')).buffer),
}

const NO_LINE_START = '、。，．・：；！？」』）］｝〉》”’ー〜%％'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const GUIDES = process.argv.includes('--guides')
const ONLY = arg('slug')

// --- 文字の組版（make-cards.mjs と同じ手法） ------------------------------

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
 * 小数部を指数表記の文字列にしてしまい NaN を返す）。直すときは3ファイルとも直すこと。
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
 * テロップを組む。**入るまで縮める**（切り捨てない）。
 *
 * テロップの長さはユーザーが手で直す。上限を超えたら切り捨てると、
 * 作品名が途中で切れた画像が黙って出来上がる。
 *
 * ★ 少し縮めれば1行に収まるものは1行にする（`SOLO_FLOOR` まで）。
 *   最大サイズを優先すると「今月の終了は80本」が
 *   「今月の終了は80 / 本」と割れ、2行目に1文字だけ落ちる。
 *   1文字ぶんの大きさより、割れ方のほうが見た目に効く。
 *   ただし縮めすぎると本末転倒なので、1行にするための縮小は8割までにとどめる。
 */
const SOLO_FLOOR = 0.8

function fitLines(weight, text, maxSize, minSize, maxWidth, maxLines) {
  for (let size = maxSize; size >= maxSize * SOLO_FLOOR; size -= 4) {
    if (textWidth(weight, text, size) <= maxWidth) return { lines: [text], size }
  }
  for (let size = maxSize; size >= minSize; size -= 4) {
    const lines = wrap(weight, text, size, maxWidth, maxLines + 1)
    if (lines.length <= maxLines) return { lines, size }
  }
  return { lines: wrap(weight, text, minSize, maxWidth, maxLines), size: minSize }
}

// --- 台本の読み込み -------------------------------------------------------

function cells(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/**
 * `shorts/<スラッグ>.md` からカット表を読む。
 *
 * **frontmatter も見出しも当てにしない。** ユーザーが手で直すファイルなので、
 * 節を並べ替えたり文を足したりされる。表の見出し行から列を探す方式にしておけば、
 * 列の順番を入れ替えられても、余計な節を足されても壊れない。
 */
function parseScript(md) {
  const lines = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')

  let header = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l.startsWith('|') && l.includes('ナレーション') && l.includes('テロップ')) {
      header = i
      break
    }
  }
  if (header < 0) return null

  const cols = cells(lines[header].trim())
  const col = (name) => cols.findIndex((c) => c.includes(name))
  const iNarration = col('ナレーション')
  const iCaption = col('テロップ')
  const iNote = col('補足')

  const cuts = []
  // 見出しの次の行は区切り（| --- |）
  for (let i = header + 2; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l.startsWith('|')) break
    const c = cells(l)
    const narration = (c[iNarration] ?? '').trim()
    const caption = (c[iCaption] ?? '').trim()
    if (!narration && !caption) continue
    cuts.push({ narration, caption, note: iNote >= 0 ? (c[iNote] ?? '').trim() : '' })
  }

  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? ''
  return cuts.length > 0 ? { title, cuts } : null
}

/** 空白を除いた実質の字数。pipeline/core/short.ts の speechChars と同じ数え方。 */
const speechChars = (s) => [...s.replace(/\s/g, '')].length
/** 読み上げ速度と間。pipeline/core/short.ts と同じ値にすること。 */
const CHARS_PER_SECOND = 6
const CUT_PAUSE = 0.35
const MAX_SECONDS = 30

// --- 画像 -----------------------------------------------------------------

/**
 * カット1枚のSVGを組む。
 *
 * ■ 画面に描くのは3つだけ
 *   ブランド（上）／ 補足バッジ（日付・サービス）／ テロップ（主役）
 * ナレーションは**描かない**。同じ文が耳と目に二重に来ると、どちらも入らない。
 *
 * ■ 最後のカットだけ矢印を出す
 * 締めは必ず「詳細は概要欄にて」なので、視線を下（概要欄）へ送る。
 */
function buildSvg(cut, index, total) {
  const innerW = W - SAFE.left - SAFE.right
  const isLast = index === total - 1
  const parts = []

  parts.push(`<rect width="${W}" height="${H}" fill="${COLOR.bg}"/>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#dots)"/>`)

  // 上端のアクセント。連番の進み具合をここで見せる（カット間のつながり）
  const progress = ((index + 1) / total) * W
  parts.push(`<rect x="0" y="0" width="${progress.toFixed(1)}" height="10" fill="${COLOR.accent}"/>`)

  // ブランド。小さく、安全領域の内側の上寄せ（38 はベースラインぶんの下げ幅）
  parts.push(
    `<path d="${textPath('bold', '見放題レーダー', SAFE.left, SAFE.top + 38, 38).d}" fill="${COLOR.brand}"/>`,
  )

  /*
   * ★ 先に高さを測ってから、安全領域の中で縦に配置する。
   *   上から順に置いていくと、カットによって重心がばらつき、
   *   動画として並べたときに文字が上下に飛ぶ。
   *   中央よりわずかに上（VERTICAL_BIAS）に寄せるのは、
   *   スマホでは画面の下寄りにUIと親指が来るため。
   */
  const NOTE_SIZE = 44
  const NOTE_H = NOTE_SIZE + 34
  const NOTE_GAP = 56
  const CLOSER_SIZE = 52
  const CLOSER_GAP = 64
  const VERTICAL_BIAS = 0.42

  const caption = cut.caption
    ? fitLines('bold', cut.caption, 108, 56, innerW, 4)
    : { lines: [], size: 0 }
  const captionStep = caption.size * 1.35
  const captionH = caption.lines.length
    ? caption.size + (caption.lines.length - 1) * captionStep
    : 0

  const blockH =
    (cut.note ? NOTE_H + NOTE_GAP : 0) + captionH + (isLast ? CLOSER_GAP + CLOSER_SIZE : 0)
  const usableH = H - SAFE.top - SAFE.bottom
  let y = SAFE.top + Math.max(0, (usableH - blockH) * VERTICAL_BIAS)

  // 補足バッジ（日付・サービス）
  if (cut.note) {
    const t = textPath('bold', cut.note, 0, 0, NOTE_SIZE)
    const padX = 32
    parts.push(
      `<rect x="${SAFE.left}" y="${y.toFixed(1)}" width="${(t.width + padX * 2).toFixed(1)}" height="${NOTE_H}" rx="${NOTE_H / 2}" fill="${COLOR.noteBg}"/>`,
    )
    parts.push(
      `<path d="${textPath('bold', cut.note, SAFE.left + padX, y + NOTE_SIZE + 10, NOTE_SIZE).d}" fill="${COLOR.note}"/>`,
    )
    y += NOTE_H + NOTE_GAP
  }

  // テロップ。画面の主役なので、入る限りいちばん大きく
  caption.lines.forEach((line, i) => {
    parts.push(
      `<path d="${textPath('bold', line, SAFE.left, y + caption.size + i * captionStep, caption.size).d}" fill="${COLOR.caption}"/>`,
    )
  })
  y += captionH

  // 締めのカットだけ、視線を下（概要欄）へ送る
  if (isLast) {
    y += CLOSER_GAP + CLOSER_SIZE
    parts.push(
      `<path d="${textPath('bold', '▼ 詳細は概要欄へ', SAFE.left, y, CLOSER_SIZE).d}" fill="${COLOR.accent}"/>`,
    )
  }

  if (GUIDES) {
    parts.push(
      `<rect x="${SAFE.left}" y="${SAFE.top}" width="${innerW}" height="${H - SAFE.top - SAFE.bottom}" ` +
        'fill="none" stroke="#ff4d6d" stroke-width="3" stroke-dasharray="16 12"/>',
    )
    parts.push(
      `<rect x="0" y="${H - SAFE.bottom}" width="${W}" height="${SAFE.bottom}" fill="#ff4d6d" fill-opacity="0.18"/>`,
    )
    parts.push(
      `<rect x="${W - SAFE.right}" y="0" width="${SAFE.right}" height="${H}" fill="#ff4d6d" fill-opacity="0.12"/>`,
    )
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1.5" fill="${COLOR.bgDots}" fill-opacity="0.10"/>
    </pattern>
  </defs>
  ${parts.join('\n  ')}
</svg>`
}

// --- 実行 -----------------------------------------------------------------

if (!existsSync(shortsDir)) {
  console.log('shorts/ がありません。先に /article で台本を作ってください。')
  process.exit(0)
}

const scripts = readdirSync(shortsDir)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .filter((f) => !ONLY || f === `${ONLY}.md`)

if (scripts.length === 0) {
  console.log(ONLY ? `台本が見つかりません: shorts/${ONLY}.md` : 'shorts/ に台本がありません。')
  process.exit(0)
}

let files = 0
let overLength = 0

for (const file of scripts) {
  const slug = file.replace(/\.md$/, '')
  const script = parseScript(readFileSync(join(shortsDir, file), 'utf8'))
  if (!script) {
    console.log(`! ${slug}: カット表を読み取れませんでした（| # | ナレーション | テロップ | 補足 |）`)
    continue
  }

  const outDir = join(framesDir, slug)
  // 古い連番が残ると、カットを減らしたときに末尾が残って混乱する
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  for (const [i, cut] of script.cuts.entries()) {
    const name = `${String(i + 1).padStart(2, '0')}.png`
    await sharp(Buffer.from(buildSvg(cut, i, script.cuts.length)))
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, name))
    files++
  }

  // 尺の数え直し。**台本の数字ではなく、いま書いてある文から数える。**
  // ユーザーがナレーションを直したあと、古い見積りを信じないようにするため。
  const chars = script.cuts.reduce((n, c) => n + speechChars(c.narration), 0)
  const seconds = chars / CHARS_PER_SECOND + script.cuts.length * CUT_PAUSE
  const over = seconds > MAX_SECONDS
  if (over) overLength++

  console.log(
    `${over ? '!' : ' '} ${slug}  ${script.cuts.length}カット / ` +
      `読み上げ ${chars}字 / 推定 ${seconds.toFixed(1)}秒` +
      (over ? `  ← ${MAX_SECONDS}秒を超えています。ナレーションを削ってください` : ''),
  )
}

console.log(`\nカット画像: ${files}枚 → shorts/frames/`)
if (overLength > 0) {
  console.log(`${overLength}本が30秒を超えています。台本のナレーションを短くして、もう一度実行してください。`)
}
console.log('※ 秒数は 6字/秒 での目安です。実際に読み上げて確かめてください。')
