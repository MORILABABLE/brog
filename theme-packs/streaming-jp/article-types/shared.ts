/**
 * 記事タイプ共通の部品。
 *
 * 配信終了・配信開始・（今後増える）ジャンル別記事は、
 * 固定文言の読み方・サービス名の並べ方・本文の走査の仕方が同じ。
 * 記事タイプを1つ増やすたびに同じ関数を書き写さずに済むよう、ここに集める。
 *
 * **記事タイプごとに違うもの（構成・文体・検査の中身）はここに置かない。**
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { loadFixedPhrases, render, type FixedPhrases } from '../../../pipeline/core/fixed-phrases.ts'
import {
  SHORT_MAX_CUT_CHARS,
  SHORT_MAX_SECONDS,
  SHORT_OUTPUT_FORMAT,
  narrationBudget,
} from '../../../pipeline/core/short.ts'
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

// --- 出さない作品 -----------------------------------------------------------

/**
 * 記事に出さない作品のID。`data/excluded-works.json` を人が手で管理する。
 *
 * ■ なぜ自動判定にしないか
 * 題名のキーワードで機械的に外すと、同じ語を含む一般作品を巻き込む。
 * 実測で「ラブレース セックスの女神」（2013年の伝記映画）と
 * 「セックス・アンド・マネー」（2006年）が誤って当たった。
 * **1件ずつ人が決める**ほうが、件数（月に数件）から見ても現実的で安全。
 *
 * ■ 収集データは消さない
 * ここで外れるのは記事とページへの掲載だけ。判断を変えれば台帳から1行消すだけで戻る。
 *
 * ★ サイト側にも同じ除外がある（site/src/lib/excluded.ts）。
 *   **片方だけ直すと、記事には出ないのに常設ページには出る**という状態になる。
 */
let excludedIds: Set<string> | undefined

function loadExcluded(): Set<string> {
  if (excludedIds) return excludedIds
  try {
    const raw = readFileSync(join('data', 'excluded-works.json'), 'utf8')
    const parsed = JSON.parse(raw) as { works?: { id?: unknown }[] }
    excludedIds = new Set(
      (parsed.works ?? []).map((w) => String(w.id ?? '')).filter((id) => id.length > 0),
    )
  } catch {
    // 台帳が無い・壊れている＝除外なし。記事の生成は止めない。
    excludedIds = new Set()
  }
  return excludedIds
}

/**
 * 記事に出してよい素材だけを残す。**各記事タイプの select() の先頭で必ず通すこと。**
 * 通し忘れると、その記事タイプだけ除外が効かない。
 */
export function publishable(events: ChangeEvent[]): ChangeEvent[] {
  const excluded = loadExcluded()
  if (excluded.size === 0) return events
  return events.filter((e) => !excluded.has(String(e.work.id)))
}

/** テスト・再読込用 */
export function resetExcluded(): void {
  excludedIds = undefined
}

// --- 前回の版との差分 -------------------------------------------------------
//
// 月内に何度も同じスラッグを書き直す記事タイプ（arrivals / arrivals-service）が
// 「前回の版から何が増えたか」を出すための共通部品。
// **記事タイプごとに書き写さないこと。** 判定がずれると、
// 同じ作品が片方では「新着」、もう片方では「既出」になる。

/**
 * 既に公開されている同じスラッグの記事から、前回の基準日を読む。
 *
 * 読めなければ undefined ＝「初回」として扱う。**ここで例外を投げない。**
 * 記事ファイルが壊れていても、初回の形で書き直せば復旧できる。
 */
export function previousAsOf(slug: string): Date | undefined {
  const path = join('site', 'src', 'content', 'posts', `${slug}.md`)
  if (!existsSync(path)) return undefined
  try {
    const md = readFileSync(path, 'utf8')
    const m = /^dataAsOf:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(md)
    if (!m) return undefined
    const at = Date.parse(`${m[1]}T00:00:00Z`)
    return Number.isFinite(at) ? new Date(at) : undefined
  } catch {
    return undefined
  }
}

/**
 * 作品1件が、前回の版に対してどういう位置づけか。
 *
 * ★ `配信開始日`（実際に見放題になった日）と `把握した日`（収集した日）はずれる。
 *   取りこぼしを後から拾うと、**古い作品が今回の素材に現れる。**
 *   それを「新たに追加」と書けば誤情報なので、ここで1件ずつ区別する。
 */
export type Freshness =
  /** 前回の版以降に**実際に配信が始まった**。「新たに配信開始」と書いてよい */
  | 'started'
  /** 配信開始は前回より前だが、**今回はじめて把握した**。「新たに確認」と書く */
  | 'found'
  /** 前回の版にも載っていた */
  | 'known'

export function freshnessOf(e: ChangeEvent, since: Date | undefined): Freshness {
  if (!since) return 'known' // 初回。全件が同じ扱いなので区別しない
  const collected = Date.parse(e.collectedAt)
  if (!Number.isFinite(collected) || collected < since.getTime()) return 'known'
  const started = e.at ? Date.parse(e.at) : NaN
  return Number.isFinite(started) && started >= since.getTime() ? 'started' : 'found'
}

/**
 * 素材に添える、書き方を指示する1行。**LLM に日付を突き合わせさせない。**
 * 「今回の追加分」でなければ空文字（行ごと落とす前提）。
 */
export function freshnessNote(f: Freshness): string {
  if (f === 'started') {
    return '  ★今回の追加分（前回の更新以降に配信開始）。「新たに見放題配信が始まりました」と書いてよい'
  }
  if (f === 'found') {
    return '  ★今回の追加分（配信開始は前回より前。今回はじめて確認した）。「新たに配信が始まった」とは書かないこと。「今回新たに確認されました」と書く'
  }
  return ''
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

// --- ショート動画の台本 ---------------------------------------------------

/**
 * 台本の候補に出す作品数の上限。**記事の素材と同じだけ渡す。**
 *
 * 30秒に載るのは4〜5本だが、候補を絞ってはいけない。
 * 1行40字ほどなので記事本体のプロンプトに比べれば無視できる量で、
 * 一方で切り詰めると**記事のフックになった作品が候補から落ちる**事故が起きる
 * （終了日順に上から24件だと、月の後半がまるごと消える）。
 */
const SHORT_CANDIDATES = 80

export interface ShortScriptOptions {
  /** 日付の呼び方。「終了日」「配信開始日」 */
  dateLabel: string
  /**
   * 素材が最初から邦題か（U-NEXT がこれ）。
   * false のときは `localizedTitle` が引けた作品だけを候補にする。
   */
  titlesAreLocalized: boolean
  /** 候補にする素材。記事と同じ並び順で渡す */
  candidates: ChangeEvent[]
  /** 締めの固定文言（差し込み済み） */
  closer: string
  /** 記事タイプ固有の追加ルール */
  extraRules?: readonly string[]
}

/**
 * ショート動画の台本の指示を組み立てる。
 *
 * ■ 記事タイプごとに違うのは3つだけ
 * 日付の呼び方・素材が邦題かどうか・固有の注意。それ以外は共通なので、
 * 構成も禁止事項も `templates/short-script.md` の1枚に集めてある。
 * 記事タイプを増やしても、このファイルと記事タイプ側の数行しか触らない。
 *
 * ■ 候補を「邦題が確定している作品」に絞る理由（音声固有）
 * 記事なら原題をそのまま書けば済む。**音声では英語の原題を読み上げても
 * 視聴者に伝わらず、読み方を推測した時点で誤情報になる。**
 * 記事の★注記に頼らず、候補の段階で機械的に外しておく。
 */
export function shortScriptSection(ctx: ArticleContext, opts: ShortScriptOptions): string {
  const template = readFileSync(themeFile(ctx.theme, 'templates', 'short-script.md'), 'utf8')
  const labelOf = serviceLabels(ctx)
  const offset = ctx.theme.utc_offset_minutes

  const speakable = opts.candidates
    .filter((e) => opts.titlesAreLocalized || e.work.localizedTitle)
    .slice(0, SHORT_CANDIDATES)

  const rows = speakable.map((e) => {
    const title = e.work.localizedTitle ?? e.work.title
    const date = e.at ? formatMonthDay(e.at, offset) : '日付未定'
    const service = labelOf.get(e.service) ?? e.service
    const year = e.work.year ? ` ／ ${e.work.year}年` : ''
    return `- ${title} ／ ${opts.dateLabel} ${date} ／ ${service}${year}`
  })

  const dropped = opts.candidates.length - speakable.length

  // カット6本を標準として字数の目安を出す。実際の上限はカット数で変わる。
  const budget = narrationBudget(6)

  const rules = [
    `**読み上げの合計は ${budget}字が目安**（カット6本のとき）。${SHORT_MAX_SECONDS}秒を超えたら作品を減らす。`,
    `1カットの読み上げは${SHORT_MAX_CUT_CHARS}字まで。`,
    '**記事で見つけた「まとまり」をそのままフックにする。** 別の切り口を新たに探さない。',
    '**「台本に出してよい作品」に無い作品を台本に出さない。** 邦題が確定しておらず、読み上げられないため。',
    '評価スコアを音声にも画面にも出さない。',
    ...(opts.extraRules ?? []),
  ]

  return `# ショート動画の台本（記事と同時に作る）

記事を書き終えたら、**続けてショート動画の台本のたたき台を1本**作ってください。
ユーザーが手で詰めて完成させる前提のたたき台です。完成品を目指さなくてよい。

${template}

---

## 締めの固定文言（一字一句そのまま）

${opts.closer}

---

## 台本に出してよい作品（${speakable.length}件）

${rows.join('\n')}
${dropped > 0 ? `\n※ 邦題が確定していない${dropped}件は候補から外してあります。台本に出さないでください。\n` : ''}
---

## 出力

${SHORT_OUTPUT_FORMAT}

特に重要な作業:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
}

/**
 * LLM の出力を行単位の検査にかけられる形に整える。
 * CRLF のままだと一致せず、「検査したが何も見つからなかった」ように見えてしまう。
 */
export function normalizeBody(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
}
