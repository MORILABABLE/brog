/**
 * 生成画像に**文字を描く**ための共通層。同梱フォント（Zen Kaku Gothic New）を
 * opentype.js で読み、文字列を **SVG のパス**に変える。
 *
 * ■ なぜパスに変えるのか
 * 生成した SVG は sharp（librsvg）でラスタライズする。`<text>` のまま渡すと
 * **ビルド機に入っているフォントで描かれる**ので、手元（Windows）と本番
 * （Cloudflare の Linux コンテナ）で字形も字送りも変わる。
 * 文字を図形にしてしまえば、どこで焼いても同じ絵になる。
 *
 * ■ なぜ1か所に集めたのか（2026-09-20）
 * ここにある関数は make-sections.mjs と make-cards.mjs が**それぞれ写して持っていた。**
 * 実際に `roundCommands` には「直すときは両方直すこと」という注意書きが付いていて、
 * **写しであることが分かったうえで運用されていた。**
 * 作品サムネイルの生成（work-cover.mjs）で3か所目が要る状況になったので、
 * ここへ寄せた。**新しく写しを作らないこと。**
 *
 * ★ make-cards.mjs はまだ自前の写しを持っている（触っていない）。
 *   あちらを直すときは、ここへ寄せてから直す。
 */
import opentype from 'opentype.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createSafeText } from './font-safe.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 同梱フォント（SIL OFL 1.1 / scripts/fonts/OFL.txt） */
export const font = {
  bold: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Bold.ttf')).buffer),
  regular: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Regular.ttf')).buffer),
}

/**
 * 同梱フォントに無い文字を、描ける文字に置き換える。
 * **測るときと描くときの両方に掛けている**（片方だけだと幅がずれて枠からはみ出す）。
 * 理由と実測は scripts/font-safe.mjs の冒頭。
 */
export const safeText = createSafeText(font)

/**
 * 座標を小数2桁に丸めてから toPathData() に渡す。**外すと文字が黒い塊になる。**
 * opentype.js 2.0.0 の roundDecimal が小数部を指数表記の文字列にしてしまい NaN を返す。
 */
function roundCommands(path) {
  for (const c of path.commands) {
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (k in c) c[k] = Math.round(c[k] * 100) / 100
    }
  }
}

/** 文字列を SVG のパスにする。`y` は**ベースライン**（字の下端ではない） */
export function textPath(weight, text, x, y, size) {
  const f = font[weight]
  const path = new opentype.Path()
  let cx = x
  for (const ch of [...safeText(text)]) {
    const g = f.charToGlyph(ch)
    path.extend(g.getPath(cx, y, size))
    cx += (g.advanceWidth / f.unitsPerEm) * size
  }
  roundCommands(path)
  return { d: path.toPathData(2), width: cx - x }
}

/** 描かずに幅だけ測る */
export function textWidth(weight, text, size) {
  const f = font[weight]
  let w = 0
  for (const ch of [...safeText(text)]) w += (f.charToGlyph(ch).advanceWidth / f.unitsPerEm) * size
  return w
}

/** 行頭に置いてはいけない文字（禁則） */
const NO_LINE_START = '、。，．・：；！？」』）］｝〉》”’ー〜%％'

/**
 * 英数字。**この連なりの途中では改行しない。**
 *
 * 1文字ずつ折ると「モーニング娘｡ コンサートツアー200 / 6春」のように
 * 数字が割れる（実測）。日本語は1文字で折ってよいが、英数字は語として読むので、
 * 割れると読み手が一度つまずく。
 */
const WORD_CHAR = /[0-9A-Za-z]/

/**
 * 折り返す。**入りきらないぶんは黙って捨てる**ので、
 * 呼び出し側で「…」を付けるかどうかを決めること。
 */
export function wrap(weight, text, size, maxWidth, maxLines) {
  /*
   * ★ **ここで一度だけ置き換える。** 折り返しの判定に NO_LINE_START を使うので、
   *   行頭に来てはいけない記号（`〜` など）を**置き換えた後の姿で**見る必要がある。
   *   置き換え前の `～`(U+FF5E) のまま判定すると、行頭に来てしまう。
   */
  text = safeText(text)
  const lines = []
  let line = ''
  for (const ch of [...text]) {
    if (line !== '' && textWidth(weight, line + ch, size) > maxWidth && !NO_LINE_START.includes(ch)) {
      let head = line
      let carry = ch
      /*
       * 行末が英数字の連なりで、次の文字も英数字なら、**連なりごと次の行へ送る。**
       * ただし送り先でも収まらない長さ（長い英字列）なら送っても解決しないので
       * そのまま折る。行の全部が連なりのときも折る
       * （送ると行が空になり、先へ進めなくなる）。
       */
      if (WORD_CHAR.test(ch)) {
        const run = /[0-9A-Za-z]+$/.exec(head)?.[0]
        if (run && run.length < head.length && textWidth(weight, run + ch, size) <= maxWidth) {
          head = head.slice(0, -run.length)
          carry = run + ch
        }
      }
      lines.push(head)
      line = carry
      if (lines.length === maxLines) return lines
    } else {
      line += ch
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines
}

/** 1行に収まるまで削って「…」を付ける */
export function ellipsize(weight, text, size, maxWidth) {
  if (textWidth(weight, text, size) <= maxWidth) return text
  let s = text
  while (s.length > 1 && textWidth(weight, s + '…', size) > maxWidth) s = s.slice(0, -1)
  return s + '…'
}
