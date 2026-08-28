/**
 * 同梱フォントに無い文字を、描ける文字に置き換える。
 *
 * ■ なぜ要るか
 * opentype.js は無い文字を **.notdef（中身の無い、字送りだけのグリフ）** で返す。
 * 例外も警告も出ないので、**画像の中で文字が静かに消える**。
 * 空白が1つ空くだけなので、出来上がりを見ても壊れていると気づきにくい。
 *
 * 実測（2026-08-28 / 記事の表に出る作品名 771件を走査）:
 *
 *   U+FF5E ～   84回   「ボトムス ～最底で最強？な私たち～」
 *   U+200B      6回    ゼロ幅スペース（データに紛れ込んだもの）
 *   U+2015 ―    4回    「まぶしくて　―私たちの輝く時間―」
 *   U+726F 牯    2回    「牯嶺街少年殺人事件」
 *
 * **`～` は U-NEXT の作品名に多い**（ライブ・コンサート映像の副題がほぼこの形）。
 * 放置すると生成ポスターの題名に穴が空く。
 *
 * ■ 置き換えの方針
 * **同じ意味の別コードポイントがあるものは、それに寄せる。**
 * 全角チルダ(U+FF5E)と波ダッシュ(U+301C)は日本語では同じ記号で、
 * 入力環境によってどちらにもなる。フォントにあるのは後者だけ。
 *
 * 寄せ先が無い文字（漢字など）は **〓（ゲタ）** にする。
 * 組版で古くから使う「ここに文字はあるが出せない」という印で、
 * **黙って消えるより正直**。出たら気づけるよう、呼び出し側が件数を報告する。
 *
 * ★ フォントを差し替えたら、この表の前提が変わる。
 *   `npm run sections -- --audit-font` で走査し直すこと。
 */

/** 寄せ先のある文字。空文字は「消す」。 */
const FOLD = new Map([
  ['～', '〜'], // U+FF5E 全角チルダ → U+301C 波ダッシュ
  ['―', '—'], // U+2015 ホリゾンタルバー → U+2014 emダッシュ
  ['​', ''], // ゼロ幅スペース
  ['﻿', ''], // BOM が本文に紛れたもの
])

/** 出せない文字の代わりに置く印（ゲタ） */
export const GETA = '〓'

/**
 * フォント一式に対して「安全に描ける文字列」を返す関数を作る。
 *
 * 返す関数は `.missing`（元の文字 → 出せなかった回数の Map）を持つ。
 * ビルドの最後にこれを見れば、フォントに足りないものが分かる。
 *
 * @param {Record<string, import('opentype.js').Font>} fonts 太さごとのフォント
 */
export function createSafeText(fonts) {
  const faces = Object.values(fonts)
  const cache = new Map()
  const missing = new Map()

  /** その文字を**すべての太さで**描けるか。片方だけ描けても組版が崩れる。 */
  const drawable = (ch) => faces.every((f) => f.charToGlyph(ch).index !== 0)

  function convert(ch) {
    const folded = FOLD.get(ch) ?? ch
    if (folded === '' || drawable(folded)) return folded
    missing.set(ch, (missing.get(ch) ?? 0) + 1)
    return GETA
  }

  /**
   * ★ **描くときと測るときの両方で通すこと。**
   *   片方だけに掛けると、幅の計算と実際の描画がずれて字が枠からはみ出す。
   */
  function safeText(text) {
    const hit = cache.get(text)
    if (hit !== undefined) return hit
    let out = ''
    for (const ch of text) out += convert(ch)
    cache.set(text, out)
    return out
  }

  safeText.missing = missing
  return safeText
}

/** `missing` を1行にまとめる。何も無ければ空文字。 */
export function missingReport(missing) {
  if (missing.size === 0) return ''
  const items = [...missing]
    .sort((a, b) => b[1] - a[1])
    .map(([ch, n]) => `${JSON.stringify(ch)} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${n}回`)
  return `フォントに無い文字を〓で描きました: ${items.join(' / ')}`
}
