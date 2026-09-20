/**
 * ポスターが取れない作品のための、**その作品だけの表紙**を描く。
 *
 * ■ なぜ要るか（2026-09-20）
 * それまで、ポスターの無い作品は**ジャンルごとに1枚の同じ絵**に落ちていた
 * （`genre-<key>.webp`）。**サイトが実際に絵を出す2,395作品のうち627件**が該当した
 * （2026-09-20 実測）。内訳は U-NEXT 由来（収集がメニュー経由で画像URLが付いてこない）と、
 * 告知由来で作品を特定できなかったもの。
 * つまり表の行の4分の1が、**隣の行と見分けの付かない同じ絵**で並んでいた。
 * 絵が行ごとの手掛かりになるという `make-thumbs.mjs` の前提が、そこだけ成り立っていない。
 *
 * ここで描くのは**題名の冒頭**（全角で3文字ぶんの幅）。作品ごとに必ず違う絵になる。
 *
 * ■ なぜ題名の全部ではないのか（**実物を見て決めた**）
 * 表示は **48×72**（ファイルはその2倍の96×144）。この大きさで試作して確かめた:
 *
 *   題名を全部入れる … 11px 相当で4行。かな主体はかろうじて読めるが、
 *                      **漢字が潰れて模様になる**（「極限境界線 救出までの18日間」）。
 *   冒頭だけ大きく … 28px 相当で全角3文字。**「チェン」「バイオ」「極限境」がはっきり読める。**
 *
 * 題名の全文は**必ず絵の隣に文字で出ている**（表の行）。ここに要るのは
 * 「どの行か」を目で掴める手掛かりであって、題名の複製ではない。
 * ★ **年・ジャンルの絵柄は入れない。** 同じ試作で、どちらもこの大きさでは
 *   潰れて読めず、題名の字と場所を奪うだけだった。
 *
 * ■ 記事の節タイル（480×720）とは別物
 * あちらは `make-sections.mjs` の `buildTileSvg` で、**題名を全文組む。**
 * 大きさが10倍違えば入る情報も違うので、**同じ版を使い回さない。**
 * 文字を描く土台（フォント・パス化・折り返し）だけが共通で、`type.mjs` にある。
 *
 * ■ 第三者の権利が一切絡まない
 * 使うのは作品名という事実と、その場で描く図形だけ。ポスターも場面写真も使わない。
 * 許諾も出典表記も要らず、URLの失効も無い（`genre-art.mjs` と同じ性格）。
 * **U-NEXT の作品にも付けてよいのはこのため**（API由来のポスターは付けられない・
 * `src/lib/work-links.ts` の `NO_POSTER_SERVICES`）。
 */
import { GENRE_BY_KEY, FALLBACK_GENRE, genreKeyOf, workCoverName } from './genre-art.mjs'
import { safeText, textPath, textWidth } from './type.mjs'

/**
 * 表紙に出す文字数の上限。
 *
 * ★ **実際の数は幅で決まる**（`headOf`）。字幅が全角の半分以下の欧文は、
 *   3文字だと "The" "Par" にしかならず手掛かりにならない（実測）。
 *   同じ字の大きさで**入るだけ**入れて、そこで切る。
 */
const MAX_HEAD_CHARS = 10

/** 字の大きさ（viewBox 100×150 のなかでの値）。入らなければここから下げる */
const MAX_SIZE = 30
const MIN_SIZE = 14
/**
 * **何文字入れるかを測るときだけ**に使う大きさ。`MAX_SIZE` より少し小さい。
 *
 * ★ `MAX_SIZE` で測ると全角は2文字しか入らない（30×3 = 90 > 84）。
 *   実物を見て決めた版は**全角3文字**なので、3文字が入る大きさで測り、
 *   描くときに入る範囲でいちばん大きい字にする（下の while）。
 */
const FIT_SIZE = 26
/** 字を収める幅。左右に 8 ずつ余白を残す */
const INNER_W = 84

/**
 * 表紙に出す「冒頭の文字」を取り出す。
 *
 * ★ 括弧と約物は落とす。「劇場版「緊急取調室 THE FINAL」」の頭が
 *   「劇場版」になるか「劇場「」になるかで、読めるかどうかが変わる。
 * ★ 落としきって空になったら、元の文字列の頭から素直に採る
 *   （記号だけの題名でも必ず何か描く）。
 */
export function headOf(title) {
  const chars = [...safeText(String(title ?? ''))]
  /*
   * ★ 括弧と約物は落とすが、**空白は残す。** 落とすと欧文が "TheBoys" になって読めない。
   *   日本語は先頭3文字に空白が来ることがまず無いので、残しても困らない。
   */
  const kept = chars.filter((c) => !/[　「」『』（）()［］\[\]【】〈〉《》・:：]/.test(c))
  const use = (kept.length > 0 ? kept : chars)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HEAD_CHARS)
  /*
   * ★ **同じ字の大きさで入るだけ入れる。** 文字数で切ると、
   *   全角（日本語）と半角（欧文）で見た目の情報量が倍以上ちがう。
   *   全角なら3文字、欧文なら7〜8文字あたりで止まる。
   */
  let head = ''
  for (const ch of [...use]) {
    if (head && textWidth('bold', head + ch, FIT_SIZE) > INNER_W) break
    head += ch
  }
  head = head.trim()
  // 1文字目から入らない（極端に幅の広い字）ときは、その1文字だけ返して下で縮める
  return head || [...use][0] || ''
}

/*
 * ファイル名の規則は `genre-art.mjs` にある（**ポスター `<ID>.webp` と混ざらない名前**）。
 * Astro 側もこの名前を要るが、このファイルはフォントを読むので向こうから読み込めない。
 */
export { workCoverName }

/**
 * 表紙1枚の SVG。
 *
 * ★ 色は `genre-art.mjs` の色相をそのまま使う。彩度と明度も向こうと同じ値にしてあるので、
 *   ジャンル汎用画像と並んでも1組のデザインに見える。**片方だけ変えないこと。**
 */
export function workCoverSvg(title, genres, w, h) {
  const g = GENRE_BY_KEY.get(genreKeyOf(genres)) ?? GENRE_BY_KEY.get(FALLBACK_GENRE)
  const hue = g.hue
  const head = headOf(title)

  // 入る大きさまで1ずつ下げる。欧文など幅の狭い字は MAX_SIZE のまま収まる
  let size = MAX_SIZE
  while (size > MIN_SIZE && textWidth('bold', head, size) > INNER_W) size -= 1
  const width = textWidth('bold', head, size)
  const d = textPath('bold', head, (100 - width) / 2, 88, size).d

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 100 150">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 34% 30%)"/><stop offset="1" stop-color="hsl(${hue} 40% 19%)"/>
  </linearGradient></defs>
  <rect width="100" height="150" fill="url(#g)"/>
  <path d="${d}" fill="hsl(${hue} 62% 97%)"/>
  <rect x="30" y="108" width="40" height="4" rx="2" fill="hsl(${hue} 52% 74%)" opacity="0.8"/>
</svg>`
}
