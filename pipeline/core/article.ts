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
import type { VerifyIssue } from './verify.ts'
import { formatIsoDate } from './datetime.ts'

/**
 * 記事カテゴリ。site/src/config.ts の CATEGORIES と
 * site/src/content.config.ts の enum と**必ず3つ揃える**こと。
 * 揃っていないとサイト側のビルドが落ちる（それが検知の仕組み）。
 *
 * leaving と ended を分けている理由:
 *   leaving = これから終了する（まだ観られる／急ぐ意味がある）
 *   ended   = すでに終了した（もう観られない／他サービスを探す）
 * 読者に渡すものが正反対なので、同じカテゴリに混ぜてはいけない。
 */
export type Category = 'leaving' | 'arrivals' | 'ranking' | 'ended'

/**
 * 記事タイプの下位区分。ジャンル別記事のために使う。
 *
 * 「アニメだけの配信開始記事」のように、同じ構成で切り口だけが違う記事を
 * 記事タイプごと増やさずに作れるようにするための仕組み。
 * 中身（どの作品がどのバリアントに属するか）はテーマパック側が決める。
 */
export interface ArticleVariant {
  /** CLI の `--genre` とスラッグに使うキー。例: `anime` */
  key: string
  /** 記事本文での呼び方。例: `アニメ` */
  label: string
}

export interface ArticleContext {
  theme: Theme
  now: Date
  /**
   * 記事が対象とする月（`YYYY-MM`）。既定は実行時点の当月。
   *
   * 実行日と分けている理由: 「9月に終了する作品」の記事は、
   * 9月に入ってから書いても遅い。8月のうちに書けるようにする。
   * 記事タイプはこの値で素材を絞り、スラッグとタグもこれに合わせる。
   */
  targetMonth: string
  /** 選択中のバリアント。バリアントを持たない記事タイプでは undefined。 */
  variant?: ArticleVariant
}

export interface ArticleType {
  readonly id: string
  readonly category: Category
  /** 記事タイプの説明。`npm run write -- --list` に出る。 */
  readonly description: string
  /**
   * この記事タイプが作るバリアント。
   *
   * 空（未定義）なら「分割しない1本」だけを作る。
   * 1件以上あるなら、バリアントごとに1本ずつ作る（`--genre` が必須になる）。
   *
   * 「総合1本 ＋ ジャンル別3本」の両方を出したい場合は、
   * 1つのタイプに2つのモードを持たせず、**別々の記事タイプとして登録する**。
   * 総合とジャンル別では読者に渡すものが違い、テンプレートも分かれるため。
   */
  readonly variants?: readonly ArticleVariant[]
  /** 記事にする素材を選ぶ。空なら記事化しない。 */
  select(events: ChangeEvent[], ledger: Ledger, ctx: ArticleContext): ChangeEvent[]
  /** LLMへの指示を組み立てる */
  buildPrompt(items: ChangeEvent[], ctx: ArticleContext): { system: string; prompt: string }
  tags(items: ChangeEvent[], ctx: ArticleContext): string[]
  slug(ctx: ArticleContext): string
  /**
   * タイプ固有の検証。
   *
   * error は公開を止める（誤情報・規約違反など、出してはいけないもの）。
   * warn は止めない。文体や言い回しの指摘は、判定が外れることがある以上
   * 公開を止める根拠にはならないため必ず warn にする。
   */
  verify(md: string, items: ChangeEvent[], ctx: ArticleContext): VerifyIssue[]
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
 *
 * 入力の正規化を先に行う理由:
 * - **BOM**: Windowsのエディタや PowerShell の Out-File は既定でBOMを付ける。
 *   付いていると `^TITLE:` が一致せず、正しい内容なのにパースに失敗する。
 * - **CRLF**: `\r` を残すとタイトルや説明文の末尾に混入し、
 *   そのまま frontmatter に書き込まれて壊れる。
 */
export function parseArticle(raw: string): ParsedArticle | null {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

  const marker = text.indexOf('---BODY---')
  if (marker < 0) return null

  const head = text.slice(0, marker)
  const body = text.slice(marker + '---BODY---'.length).trim()

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
