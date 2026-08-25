/**
 * 記事タイプ共通の部品。
 *
 * 配信終了・配信開始・（今後増える）ジャンル別記事は、
 * 固定文言の読み方・サービス名の並べ方・本文の走査の仕方が同じ。
 * 記事タイプを1つ増やすたびに同じ関数を書き写さずに済むよう、ここに集める。
 *
 * **記事タイプごとに違うもの（構成・文体・検査の中身）はここに置かない。**
 */
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { loadFixedPhrases, render, type FixedPhrases } from '../../../pipeline/core/fixed-phrases.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { ArticleContext } from '../../../pipeline/core/article.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'

// --- 固定文言 -------------------------------------------------------------

let cache: { key: string; phrases: FixedPhrases } | undefined

/**
 * テーマの固定文言を読む。テーマごとに1度だけ読み込む。
 * プロンプト組み立てと検査の両方から呼ばれ、**同じ値が返ることが要件**。
 */
export function fixedPhrases(ctx: ArticleContext, required: readonly string[]): FixedPhrases {
  if (cache?.key !== ctx.theme.key) {
    cache = {
      key: ctx.theme.key,
      phrases: loadFixedPhrases(themeFile(ctx.theme, 'templates', 'fixed-phrases.md'), required),
    }
  }
  return cache.phrases
}

/** 固定文言に値を差し込む小さなヘルパ */
export function phraseReader(
  phrases: FixedPhrases,
  vars: Record<string, string | number>,
): (key: string) => string {
  return (key: string) => render(phrases.get(key) ?? '', vars)
}

// --- 記事の基本情報 -------------------------------------------------------

/**
 * 記事が対象とする月。
 * 実行日ではなく対象月から取る。8月のうちに9月分を書く場合でもずれない。
 */
export function articleMonth(ctx: ArticleContext): number {
  return Number(ctx.targetMonth.split('-')[1])
}

/** 記事作成日。「8月9日」形式 */
export function asOfLabel(ctx: ArticleContext): string {
  return formatMonthDay(ctx.now.toISOString(), ctx.theme.utc_offset_minutes)
}

/**
 * 記事に出しうるサービスの一覧（キーと表示名）。
 *
 * ★ `theme.catalogs` だけを見てはいけない。
 *   U-NEXT は Streaming Availability API のカタログに存在せず、
 *   `theme.unext` に別枠で定義されている（取得手段がまったく違うため）。
 *   ここで足しておかないと、U-NEXT の記事だけサービス名が
 *   キー（`u-next`）のまま本文に出る。
 */
export function allServices(ctx: ArticleContext): { key: string; label: string }[] {
  const list = ctx.theme.catalogs.map((c) => ({ key: c.key, label: c.label }))
  if (ctx.theme.unext) {
    list.push({ key: ctx.theme.unext.service_key, label: ctx.theme.unext.label })
  }
  return list
}

/** 「NetflixとAmazon Prime Video」。3つ以上なら中黒でつなぐ。 */
export function serviceNames(items: ChangeEvent[], ctx: ArticleContext): string {
  const present = new Set(items.map((e) => e.service))
  const all = allServices(ctx)
  // 並び順はテーマの定義順に固定する。月によって順番が入れ替わらないようにするため。
  const labels = all.filter((c) => present.has(c.key)).map((c) => c.label)
  if (labels.length === 0) return all.map((c) => c.label).join('・')
  if (labels.length === 2) return labels.join('と')
  return labels.join('・')
}

/** サービス名の対応表。プロンプトに出す表示名を引くため。 */
export function serviceLabels(ctx: ArticleContext): Map<string, string> {
  return new Map(allServices(ctx).map((c) => [c.key, c.label]))
}

/** サイトのタイムゾーンで見て、記事の対象月に入るか */
export function isTargetMonth(iso: string, ctx: ArticleContext): boolean {
  const shifted = new Date(Date.parse(iso) + ctx.theme.utc_offset_minutes * 60_000)
  return shifted.toISOString().slice(0, 7) === ctx.targetMonth
}

// --- 本文の走査 -----------------------------------------------------------

export interface DateSection {
  heading: string
  /** 表・箇条書き・見出しを除いた、最後の本文段落 */
  lastParagraph: string | undefined
  /**
   * 見出しの直後（最初の非空行）が表かどうか。
   * テンプレートは「見出し → 表 → 解説」の順を必須にしている。
   * 導入文を挟むと、読者が一覧を掴む前に文章を読まされる。
   */
  startsWithTable: boolean
}

/**
 * `## 8月14日：…` 形式のセクションを取り出す。
 * 締めの検査は日付ごとのまとまりだけが対象で、
 * 「その他の注目作」「全作品リスト」などは対象外。
 */
export function dateSections(md: string): DateSection[] {
  const sections: DateSection[] = []
  let current: { heading: string; lines: string[] } | undefined

  const flush = () => {
    if (!current) return
    const trimmed = current.lines.map((l) => l.trim())
    const prose = trimmed.filter(
      (l) => l && !l.startsWith('|') && !l.startsWith('-') && !l.startsWith('#') && !l.startsWith('>'),
    )
    sections.push({
      heading: current.heading,
      lastParagraph: prose.at(-1)?.replace(/\*+/g, '').trim(),
      startsWithTable: (trimmed.find((l) => l) ?? '').startsWith('|'),
    })
    current = undefined
  }

  for (const line of md.split('\n')) {
    const h2 = line.match(/^## +(.*)$/)
    if (h2) {
      flush()
      const heading = h2[1]!.trim()
      if (/^\d{1,2}月\d{1,2}日/.test(heading)) current = { heading, lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  flush()
  return sections
}

/** Markdown のリンク記法を取り除く。URL の半角括弧を誤検出しないため。 */
export function stripLinks(md: string): string {
  return md.replace(/\[[^\]]*\]\([^)]*\)/g, '')
}

/**
 * 地の文に混ざった半角記号。全角に統一する規約の検査用。
 *
 * ★ 作品名に含まれる半角記号は**正式表記なので直せない**
 *   （「Free!」「アッパレ!戦国大合戦」「日本爆裂!!」など）。
 *   除外しないと毎月必ず警告が出て、本当の違反がその中に埋もれる。
 *
 * @param titles 検査から外す文字列（その月の作品名）。長いものから順に取り除く。
 */
export function halfWidthSymbols(md: string, titles: readonly string[] = []): string[] {
  let text = stripLinks(md)
  for (const title of [...titles].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(title).join('')
  }
  return [...new Set(text.match(/[!?()]/g) ?? [])]
}

/** その月の作品名（邦題と原題の両方）。検査の除外リストに使う。 */
export function itemTitles(items: ChangeEvent[]): string[] {
  return items.flatMap((e) => [e.work.localizedTitle, e.work.title].filter((t): t is string => Boolean(t)))
}

/**
 * 地の文で評価スコアに言及している箇所。
 *
 * 評価は表にだけ載せる規約なので、表の行（`|` で始まる）は対象から外す。
 * 「読者が探しているのはその月に増えた作品であって、その日の最高得点ではない」
 * という判断がテンプレート側にあり、これはその機械的な担保。
 */
const RATING_IN_PROSE =
  /(評価(?:は|が|で)?\s*\d+|\d+\s*\/\s*100|評価(?:の高い|上位|が最も高|は今月|に次ぐ)|最高評価|評価だけで選ぶ)/

export function ratingMentionsInProse(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|'))
    .filter((l) => RATING_IN_PROSE.test(l))
}

export function clip(s: string, max = 40): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

/**
 * LLM の出力を行単位の検査にかけられる形に整える。
 * CRLF のままだと一致せず、「検査したが何も見つからなかった」ように見えてしまう。
 */
export function normalizeBody(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
}
