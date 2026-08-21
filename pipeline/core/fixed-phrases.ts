/**
 * 固定文言の読み込み。
 *
 * ■ なぜファイルから読むか
 * 「毎月そのまま使う文言」は、プロンプト（書くときの指示）と
 * 品質チェック（書いたあとの検査）の両方で必要になる。
 * 二箇所に同じ文字列を書くと、片方だけ直したときに静かに食い違う。
 * テーマパックの Markdown を唯一の出典にして、両方がそこを見る。
 *
 * ■ 書式
 *   ## キー
 *   本文（複数行可）
 *   <!-- 注釈。読み込み時に捨てられる -->
 *
 * 最初の `##` より前は説明文とみなして無視する。
 */
import { readFileSync } from 'node:fs'

export type FixedPhrases = ReadonlyMap<string, string>

/**
 * @param path  固定文言の Markdown
 * @param required  必ず存在すべきキー。欠けていれば例外にする。
 *   欠けたまま動くと「チェックしているつもりで何も見ていない」状態になるため、
 *   静かに無視せず落とす。
 */
export function loadFixedPhrases(path: string, required: readonly string[] = []): FixedPhrases {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')

  const phrases = new Map<string, string>()
  for (const section of raw.split(/^## +/m).slice(1)) {
    const nl = section.indexOf('\n')
    const key = (nl < 0 ? section : section.slice(0, nl)).trim()
    const body = (nl < 0 ? '' : section.slice(nl + 1))
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
    if (key && body) phrases.set(key, body)
  }

  const missing = required.filter((k) => !phrases.has(k))
  if (missing.length) {
    throw new Error(`${path}: 固定文言が見つかりません: ${missing.join(', ')}`)
  }
  return phrases
}

/** `{月}` のような差し込みを実際の値に置き換える。 */
export function render(phrase: string, vars: Record<string, string | number>): string {
  return phrase.replace(/\{([^\s{}]+)\}/gu, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : String(v)
  })
}
