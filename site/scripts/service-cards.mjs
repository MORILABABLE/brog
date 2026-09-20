/**
 * 配信カレンダーのカードに出す、**サービス1社1枚の絵**を描く。
 *
 *   cd site && node scripts/service-cards.mjs
 *
 * ビルドには含まれない**手動スクリプト**。出力は `src/assets/services/<キー>.png` で、
 * 「人が置く指定画像」の置き場（`src/assets/services/README.md`）にそのまま入る。
 * 生成物だが**git に入れる**（src/assets は astro:assets が読む入力で、
 * public/ に出す `cards/` や `thumbs/` とは性格が違う）。
 *
 * ■ なぜ描くのか（2026-09-20）
 * それまで置いていたのは、赤い再生記号などの**抽象画**だった。3社とも絵柄の系統が
 * 揃っておらず、カレンダーへの入口だと分かる手掛かりも無かった。
 * 代わりに**カレンダーの升目そのもの**を描き、升目に並べた文字でサービス名を名乗る。
 *
 * ★ **第三者の画像を1枚も使っていない。** 描くのは升目（図形）と、同梱フォントで
 *   組んだ英字だけ。許諾も出典表記も期限も無い（`work-cover.mjs`・`genre-art.mjs` と同じ性格）。
 *   配信カレンダーの画面をスクリーンショットして使う案は**取らなかった**：
 *   升目に並ぶのは作品のポスターで、これは Third-Party Content として
 *   **提供元も許諾を出せない**（docs/PARTNERSHIPS.md 3-1）。しかもカードの絵は
 *   `og:image` として X・LINE・Slack 側にコピーが残るため、あとから消せない。
 *   詳細は README.md の「ライセンスに注意」。
 *
 * ■ 正方形で描く理由（**16:9 で作らないこと**）
 * README の推奨は長らく「1600×900 前後の横長」だったが、これは見出し直上の
 * 帯（`LeadImage.astro`・16:7）に出していたころの条件で、**その用途は 2026-09-07 に外した。**
 * いま絵が出るのは3か所とも `Thumb.astro` の**正方形の切り抜き**（`object-fit: cover`）:
 *
 *     トップの横スクロール棚（TopCalendar.astro）   132px
 *     記事一覧の常設カード（EvergreenCard.astro）    72px
 *     左の枠のカード（CalendarCards.astro）          60px
 *
 * 横長で描くと中央だけが残るので、**7列の升目は左右の列が落ちる。**
 * 「NETFLIX」の N と X が切れて読めなくなる。だから正方形で描く。
 *
 * ■ 色を出すのは字だけ（2026-09-20・運用者の指定）
 * **升目はサービスによらず同じ地色**（`EMPTY_FILL`）で、色が付くのは文字だけ。
 * 最初は名前の行の升目もサービス色で塗っていたが、色の面が勝って
 * 「カレンダーの升目」に見えなくなっていた。
 * ★ **升目を塗り分けないこと。** 3社の違いは字の色だけで足りる（60px でも読める）。
 */
import sharp from 'sharp'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { textPath, textWidth } from './type.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'src', 'assets', 'services')

/** 正方形。切り抜きが起きないので、描いたものがそのまま出る */
const W = 1200

const COLS = 7
const ROWS = 5
const MARGIN = 96
const GAP = 14
/** 升目の幅。7列が MARGIN の内側に収まるように決まる */
const CELL_W = (W - MARGIN * 2 - GAP * (COLS - 1)) / COLS
/**
 * 升目の高さ。**わずかに縦長にしてある**（132 × 176 ＝ 3:4）。
 * 実際のカレンダーの升目はポスターが入るので縦長（2:3）だが、
 * そこまで伸ばすと5行が 1200px に収まらない。縦長の気配だけ残す。
 *
 * ★ この値は**上下の余白が左右（MARGIN）と揃うように決めてある。**
 *   触ると余白が偏るので、変えたら TOP の実値を確かめること。
 */
const CELL_H = 176

/** 曜日の見出し。これが無いと、ただの格子に見えて「カレンダー」と読めない */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const HEAD_SIZE = 46
/** 曜日の行と升目のあいだ */
const HEAD_GAP = 26

const gridH = ROWS * CELL_H + (ROWS - 1) * GAP
const blockH = HEAD_SIZE + HEAD_GAP + gridH
/** 縦は中央に置く。左右は MARGIN なので、上下もそれに近い値に落ち着く */
const TOP = Math.round((W - blockH) / 2)
const GRID_TOP = TOP + HEAD_SIZE + HEAD_GAP

/** 空の升目。styles/global.css の --bg-subtle / --border と同じ値 */
const EMPTY_FILL = '#f6f7f9'
const BORDER = '#e3e6ea'
/** 曜日の文字。--text-muted と同じ値 */
const MUTED = '#5c646e'

/**
 * 1社ぶんの指定。
 *
 * `words` は**升目の行に入れる英字**。1行7文字まで。
 * `color` は**字の色だけ**に使う（升目は塗らない。上の「色を出すのは字だけ」）。
 *
 * ★ キーは `src/lib/events-data.ts` のサービスキーと同じにすること。
 *   ファイル名がそのまま対応先になる（README.md）。
 */
const SERVICES = [
  { key: 'netflix', words: ['NETFLIX'], color: '#c8102e' },
  {
    /*
     * 「AMAZONPRIMEVIDEO」を7列で折ると行ごとに切れ目がずれて読めない。
     * **語ごとに3行**へ割る（2026-09-20・運用者の指定）。
     */
    key: 'prime-video',
    words: ['AMAZON', 'PRIME', 'VIDEO'],
    color: '#1a5fd0',
  },
  /*
   * 深緑。**Disney+ の公式の青を当てない**のは、ブランド色に寄りすぎるため
   * （src/assets/services/README.md の「ライセンスに注意」）。
   */
  { key: 'disney-plus', words: ['DISNEY+'], color: '#14573c' },
]

/**
 * 文字の大きさ。**升目の幅から決める。**
 * この書体の大文字は幅が 0.6em 前後なので、升目の 6 割を占める見当になる。
 */
const LETTER_SIZE = 104

/** 升目の左上の座標 */
function cellX(col) {
  return MARGIN + col * (CELL_W + GAP)
}
function cellY(row) {
  return GRID_TOP + row * (CELL_H + GAP)
}

/**
 * その行に入る語を、どの列から置くか。**行が1つ下がるごとに1マス右へずらす。**
 *
 *     1行目（日曜から） AMAZON
 *     2行目（月曜から）  PRIME
 *     3行目（火曜から）   VIDEO
 *
 * ★ **中央へ寄せないこと**（2026-09-20・運用者の指定）。中央寄せだと
 *   7文字ちょうどの NETFLIX・DISNEY+ は列0から始まるのに Amazon だけ列1から始まり、
 *   **3社で始まりの曜日が食い違った。** かといって3行とも列0にそろえると、
 *   長さの違う語（6・5・5文字）が左に詰まって右側が不揃いに空く。
 *   1マスずつ下げると**斜めの段**になり、図形として締まる。
 * ★ 1語のサービス（NETFLIX・DISNEY+）は `i` が 0 だけなので日曜始まりのまま。
 */
function startCol(i) {
  return i
}

/**
 * 名前の行が、5行のうちどこに来るか。
 * 1行なら中央（上2行・下2行）、3行なら上下に1行ずつ残る。**どちらも上下対称になる。**
 */
function firstRow(words) {
  return Math.floor((ROWS - words.length) / 2)
}

function buildSvg({ words, color }) {
  const top = firstRow(words)

  /** 字が入る升目。`${row},${col}` で引く */
  const letters = new Map()
  words.forEach((word, i) => {
    const from = startCol(i)
    /*
     * ★ はみ出したら**黙って切らずに止める。** 升目の外に字は置けないので、
     *   語を足すときはここで気づけるようにしておく（`VIDEO` は列2から列6でちょうど収まる）。
     */
    if (from + [...word].length > COLS) {
      console.error(`「${word}」が ${COLS} 列に収まりません（列${from}から${[...word].length}文字）`)
      process.exit(1)
    }
    ;[...word].forEach((ch, j) => letters.set(`${top + i},${from + j}`, ch))
  })

  const parts = [`<rect width="${W}" height="${W}" fill="#ffffff"/>`]

  // 曜日の見出し。升目の中央に合わせる
  WEEKDAYS.forEach((d, col) => {
    const w = textWidth('regular', d, HEAD_SIZE)
    const x = cellX(col) + (CELL_W - w) / 2
    parts.push(
      `<path d="${textPath('regular', d, x, TOP + HEAD_SIZE, HEAD_SIZE).d}" fill="${MUTED}"/>`,
    )
  })

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const ch = letters.get(`${row},${col}`)
      const x = cellX(col)
      const y = cellY(row)
      /* ★ 升目は**全部同じ**。字の有無で塗りも枠線も変えない（上の「色を出すのは字だけ」） */
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y}" width="${CELL_W.toFixed(1)}" height="${CELL_H}" rx="16"` +
          ` fill="${EMPTY_FILL}" stroke="${BORDER}" stroke-width="2"/>`,
      )
      if (!ch) continue
      const w = textWidth('bold', ch, LETTER_SIZE)
      /*
       * 縦の中央に置く。`textPath` の y は**ベースライン**なので、
       * 大文字の高さのぶん（この書体でおよそ 0.72em）を半分だけ下へ足す。
       */
      const bx = x + (CELL_W - w) / 2
      const by = y + CELL_H / 2 + LETTER_SIZE * 0.36
      parts.push(`<path d="${textPath('bold', ch, bx, by, LETTER_SIZE).d}" fill="${color}"/>`)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  ${parts.join('\n  ')}
</svg>`
}

// --- 実行 -----------------------------------------------------------------

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

for (const s of SERVICES) {
  const out = join(outDir, `${s.key}.png`)
  await sharp(Buffer.from(buildSvg(s))).png({ compressionLevel: 9 }).toFile(out)
  console.log(`サービスの絵: ${s.key.padEnd(14)} ${(statSync(out).size / 1024).toFixed(0)}KB`)
}
