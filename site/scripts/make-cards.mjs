/**
 * 記事ごとのカード画像を、記事データだけから生成する。
 *
 * **ビルド時に自動で走る**（package.json の prebuild）。手で実行する必要はない。
 * 単体で試したいときは `cd site && node scripts/make-cards.mjs`。
 *
 * ■ なぜ画像を「生成」するのか
 * 作品の場面写真（作中キャプチャ）は著作権があり、広告のある当サイトでは使えない。
 * 配信APIが返すのもポスター・キーアートだけで、本編の画像は含まれない。
 * そこで**第三者の権利が一切絡まない画像を、記事のデータから作る**。
 * 権利の確認待ちが発生せず、URLの失効も帯域制限も無い。
 *
 * ■ 文字をパスに変換している理由（重要）
 * SVG の <text> で描くと、描画するマシンにインストールされたフォントが使われる。
 * Cloudflare のビルド環境（Linux）には日本語フォントが無いため、
 * そのままでは**日本語が豆腐（□□□）になる**。
 * SVG の @font-face も fontconfig も librvsg 側で効かないことを実測で確認済み。
 *
 * そこで opentype.js で**文字をすべてパス（<path>）に変換**している。
 * 出来上がる SVG にフォントの概念が残らないので、Windows でも Linux でも
 * Cloudflare でも1ピクセル違わず同じ絵になる。同梱フォントは OFL。
 *
 * ■ 出力
 * public/cards/<スラッグ>.jpg（1200 × 630）。ビルドの生成物なので git 管理しない。
 * public/ に置くのは、OGPが絶対URLを要求するため。
 */
import sharp from 'sharp'
import opentype from 'opentype.js'
import { readFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const postsDir = join(root, 'src', 'content', 'posts')
const outDir = join(root, 'public', 'cards')

const W = 1200
const H = 630

/**
 * 同梱フォント（SIL Open Font License 1.1 / scripts/fonts/OFL.txt）。
 * 差し替えるときはライセンスを確認し、OFL.txt も一緒に入れ替えること。
 */
const FONTS = {
  bold: join(here, 'fonts', 'ZenKakuGothicNew-Bold.ttf'),
  regular: join(here, 'fonts', 'ZenKakuGothicNew-Regular.ttf'),
}

/**
 * カテゴリごとの配色。styles/global.css の --cat-*-bg / --cat-*-fg と同じ値。
 * 片方だけ変えると記事一覧とカード画像で色が食い違うので、必ず両方直すこと。
 */
const CATEGORY = {
  leaving: { label: '配信終了予定', bg: '#fbeedb', fg: '#8a4d08' },
  ended: { label: '配信終了済み', bg: '#e9ecf0', fg: '#55606d' },
  arrivals: { label: '新着配信', bg: '#e8f0fe', fg: '#1a5fd0' },
  ranking: { label: 'ランキング', bg: '#efe8fc', fg: '#6535bb' },
}

/**
 * カードに出すサービス名。tags にはジャンル名も混ざるため、白紙で拾わず突き合わせる。
 * 追加は theme-packs/streaming-jp/theme.yaml の catalogs に合わせること。
 */
const SERVICES = ['Netflix', 'Amazon Prime Video', 'Disney+', 'Apple TV+']

/** 行頭に置いてはいけない文字（最低限の禁則処理） */
const NO_LINE_START = '、。，．・：；！？」』）］｝〉》”’ー〜%％'

const font = {
  bold: opentype.parse(readFileSync(FONTS.bold).buffer),
  regular: opentype.parse(readFileSync(FONTS.regular).buffer),
}

/**
 * 文字列をパスデータに変換する。
 * opentype.js の getPath() はこのフォントの GSUB を解釈できずに落ちるため、
 * シェーピングを通さず1文字ずつ組む。日本語と英数字の混在ならこれで足りる。
 */
function textPath(weight, text, x, y, size) {
  const f = font[weight]
  const path = new opentype.Path()
  let cx = x
  for (const ch of [...text]) {
    const glyph = f.charToGlyph(ch)
    path.extend(glyph.getPath(cx, y, size))
    cx += (glyph.advanceWidth / f.unitsPerEm) * size
  }
  roundCommands(path)
  return { d: path.toPathData(2), width: cx - x }
}

/**
 * 座標を小数2桁に丸めてから toPathData() に渡す。**外すと文字が黒い塊になる。**
 *
 * opentype.js 2.0.0 の roundDecimal() は小数部をこう丸める:
 *   +(Math.round(decimalPart + 'e+2') + 'e-2')
 * 文字送り cx は加算の繰り返しなので浮動小数の誤差が必ず乗り、
 * 559 のつもりの座標が 559.0000000000001 になる。小数部は 1.1e-13 で、
 * 文字列にすると指数表記 '1.1e-13' → '1.1e-13e+2' となって Math.round が NaN を返す。
 * その NaN が d 属性にそのまま出力され、パスが閉じずに塗り潰される。
 *
 * さらに悪いことに結果は decimalRoundingCache（モジュール全体で共有）に載るため、
 * 一度でも踏むと同じ小数部を持つ別の文字列まで巻き添えになる。
 * ここで誤差を消しておけば、指数表記になる小数部が生まれない。
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

/** 幅に収まるところで折り返す。日本語は単語の区切りが無いので実寸で測る。 */
function wrap(weight, text, size, maxWidth, maxLines) {
  const lines = []
  let line = ''
  for (const ch of [...text]) {
    if (textWidth(weight, line + ch, size) > maxWidth && line !== '') {
      if (NO_LINE_START.includes(ch)) {
        line += ch
      } else {
        lines.push(line)
        line = ch
        if (lines.length === maxLines) return truncate(lines, weight, size, maxWidth)
        continue
      }
    } else {
      line += ch
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, maxLines)
}

function truncate(lines, weight, size, maxWidth) {
  const last = lines[lines.length - 1]
  let s = last
  while (s.length > 1 && textWidth(weight, s + '…', size) > maxWidth) s = s.slice(0, -1)
  lines[lines.length - 1] = s + '…'
  return lines
}

/** 機械生成の frontmatter だけを相手にする、必要最小限の読み取り */
function readFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const fm = m[1]
  const one = (key) => {
    const v = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
    return v ? v.replace(/^['"]|['"]$/g, '') : undefined
  }
  const tags = fm.match(/^tags:\s*\[(.*)\]$/m)?.[1]
  return {
    title: one('title'),
    category: one('category'),
    tags: tags ? tags.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')) : [],
  }
}

function buildSvg({ title, category, tags }) {
  const cat = CATEGORY[category] ?? { label: category, bg: '#e8f0fe', fg: '#1a5fd0' }
  const services = SERVICES.filter((s) => tags.includes(s))

  const cardX = 48
  const cardW = W - cardX * 2
  const padX = cardX + 56
  const innerW = cardW - 112

  const titleSize = 54
  const lines = wrap('bold', title, titleSize, innerW, 3)
  const titleTop = lines.length === 3 ? 250 : 285

  const badgeText = textPath('bold', cat.label, 0, 0, 26)
  const badgeW = badgeText.width + 44

  const parts = []
  parts.push(`<rect width="${W}" height="${H}" fill="#1b3a6e"/>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#dots)"/>`)
  parts.push(`<rect x="${cardX}" y="48" width="${cardW}" height="${H - 96}" rx="24" fill="#ffffff"/>`)

  parts.push(`<rect x="${padX}" y="96" width="${badgeW.toFixed(1)}" height="46" rx="23" fill="${cat.bg}"/>`)
  parts.push(
    `<path d="${textPath('bold', cat.label, padX + 22, 128, 26).d}" fill="${cat.fg}"/>`,
  )

  lines.forEach((l, i) => {
    parts.push(
      `<path d="${textPath('bold', l, padX, titleTop + i * 78, titleSize).d}" fill="#1a1d21"/>`,
    )
  })

  parts.push(
    `<line x1="${padX}" y1="${H - 158}" x2="${W - padX}" y2="${H - 158}" stroke="#e3e6ea" stroke-width="2"/>`,
  )
  if (services.length) {
    parts.push(
      `<path d="${textPath('regular', services.join('・'), padX, H - 112, 26).d}" fill="#5c646e"/>`,
    )
  }
  parts.push(
    `<path d="${textPath('bold', '見放題レーダー　mihoudairader.com', padX, H - 68, 28).d}" fill="#1f6feb"/>`,
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="#aed0ff" fill-opacity="0.13"/>
    </pattern>
  </defs>
  ${parts.join('\n  ')}
</svg>`
}

// --- 実行 -----------------------------------------------------------------

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const posts = readdirSync(postsDir).filter((f) => f.endsWith('.md'))
if (posts.length === 0) {
  console.log('カード画像: 記事がありません')
}

for (const file of posts) {
  const slug = file.replace(/\.md$/, '')
  const out = join(outDir, `${slug}.jpg`)
  const fm = readFrontmatter(readFileSync(join(postsDir, file), 'utf8'))

  if (!fm?.title || !fm.category) {
    // ビルドを止める。og:image が404のまま公開されるより、ここで気づくほうがよい。
    console.error(`カード画像: ${slug} の frontmatter を読めませんでした`)
    process.exit(1)
  }

  await sharp(Buffer.from(buildSvg(fm))).jpeg({ quality: 88, mozjpeg: true }).toFile(out)
  console.log(`カード画像: ${slug.padEnd(30)} ${(statSync(out).size / 1024).toFixed(0)}KB`)
}
