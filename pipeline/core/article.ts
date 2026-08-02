/**
 * 記事タイプの抽象と、LLM出力の組み立て。
 *
 * ■ 設計の要点: frontmatter はLLMに書かせない
 * 日付・カテゴリ・出典・基準日は収集データから機械的に組み立てる。
 * LLMに任せると誤った日付や出典が混入し、それは記事の信頼性を直接壊す。
 * LLMが書くのは「タイトル・説明文・本文」の3つだけ。
 *
 * ■ 出力形式にJSONを使わない理由
 * 長いMarkdown本文をJSON文字列に入れるとエスケープ事故が起きやすい。
 * 区切り記号方式なら本文に何が入っても壊れない。
 */
import type { ChangeEvent } from '../sources/types.ts'
import type { Theme } from '../theme.ts'
import type { Ledger } from './events.ts'
import { formatIsoDate } from './datetime.ts'

export type Category = 'leaving' | 'arrivals' | 'ranking'

export interface ArticleContext {
  theme: Theme
  now: Date
}

export interface ArticleType {
  readonly id: string
  readonly category: Category
  /** 記事にする素材を選ぶ。空なら記事化しない。 */
  select(events: ChangeEvent[], ledger: Ledger, ctx: ArticleContext): ChangeEvent[]
  /** LLMへの指示を組み立てる */
  buildPrompt(items: ChangeEvent[], ctx: ArticleContext): { system: string; prompt: string }
  tags(items: ChangeEvent[], ctx: ArticleContext): string[]
  slug(ctx: ArticleContext): string
  /** タイプ固有の検証。問題があればメッセージを返す。 */
  verify(md: string, items: ChangeEvent[]): string[]
}

// --- LLM出力のパース -----------------------------------------------------

export const OUTPUT_FORMAT = `出力は必ず次の形式にしてください。余計な前置きや後書きは書かないこと。

TITLE: （記事タイトル。30〜60文字）
DESCRIPTION: （検索結果に出る説明文。60〜120文字。1行で書くこと）
---BODY---
（ここから本文。Markdown形式。見出しは ## から始めること）`

export interface ParsedArticle {
  title: string
  description: string
  body: string
}

/**
 * LLMの出力を分解する。形式が崩れていれば null を返し、
 * 呼び出し側が記事化を中止できるようにする。
 */
export function parseArticle(raw: string): ParsedArticle | null {
  const marker = raw.indexOf('---BODY---')
  if (marker < 0) return null

  const head = raw.slice(0, marker)
  const body = raw.slice(marker + '---BODY---'.length).trim()

  const title = head.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim()
  const description = head.match(/^DESCRIPTION:\s*(.+)$/m)?.[1]?.trim()

  if (!title || !description || !body) return null
  return { title, description, body }
}

// --- Markdown の組み立て -------------------------------------------------

export interface Source {
  label: string
  url: string
}

export interface BuildOptions {
  parsed: ParsedArticle
  category: Category
  tags: string[]
  sources: Source[]
  /** 配信情報の基準日 */
  dataAsOf: Date
  pubDate: Date
  offsetMinutes: number
}

/** YAML の文字列としてエスケープする。タイトルにコロンや引用符が入っても壊さない。 */
function yamlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

export function buildMarkdown(o: BuildOptions): string {
  const fm = [
    '---',
    `title: ${yamlString(o.parsed.title)}`,
    `description: ${yamlString(o.parsed.description)}`,
    `pubDate: ${formatIsoDate(o.pubDate.toISOString(), o.offsetMinutes)}`,
    `category: '${o.category}'`,
    `tags: [${o.tags.map(yamlString).join(', ')}]`,
    'sources:',
    ...o.sources.flatMap((s) => [`  - label: ${yamlString(s.label)}`, `    url: '${s.url}'`]),
    `dataAsOf: ${formatIsoDate(o.dataAsOf.toISOString(), o.offsetMinutes)}`,
    '---',
    '',
  ].join('\n')

  return fm + o.parsed.body.trim() + '\n'
}
