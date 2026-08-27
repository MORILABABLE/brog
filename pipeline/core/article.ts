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

/**
 * 記事が名乗る軸。**1本の記事が名乗る軸は必ず1つだけ。**
 *
 *   `service` … サービス1社の記事。**他社を混ぜない**
 *   `genre`   … ジャンル1つの記事。**サービスを横断してよい**
 *   `topic`   … 主題1つの記事（特報）。**サービスを横断してよい**
 *
 * 読者はサービスごとの最新情報を求めて来るので、複数サービスを1本にまとめた記事は作らない。
 * 横断してよいのは「その作品／そのジャンルがどこで観られるか」を知りたい読者に向けた記事だけ。
 * 判断の根拠と実測は [docs/ARTICLE-RULES.md](../../docs/ARTICLE-RULES.md)。
 *
 * ★ **必須にしてある。** 軸を名乗らない記事タイプは、
 *   対象サービスが1社増えた瞬間に横断まとめ記事に変わる。
 *   実際 `ended` は対象1社のあいだだけ1社記事に見えていた（2026-08-27 に是正）。
 */
export type Axis = 'service' | 'genre' | 'topic'

/**
 * 記事タイプが必要とする、バリアント以外のCLIフラグ。
 *
 * ■ 何のためにあるか
 * 特報（`special`）のように、**何を書くかを毎回ユーザーが決める**記事タイプがある。
 * 主題も対象も月ごとに違うので、`variants` のように列挙できない。
 *
 * ■ CLI は中身を知らない
 * `variants` と同じで、**必要なフラグは記事タイプが宣言し、CLI は渡すだけ**。
 * 記事タイプを増やしても `write.ts` は変わらない。
 * 値は `ArticleContext.flags` に入り、`--apply` のために下書きにも保存される。
 */
export interface ArticleFlag {
  /** CLI のフラグ名。`--topic` なら `topic` */
  name: string
  /** エラー文と `--list` のヘルプに出る説明 */
  description: string
  /** 無いと記事を作れないか */
  required?: boolean
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
  /**
   * 記事タイプが `flags` で宣言したフラグの値（`--topic "…"` → `{ topic: '…' }`）。
   * 宣言していない記事タイプでは空。
   */
  flags?: Readonly<Record<string, string>>
}

export interface ArticleType {
  readonly id: string
  readonly category: Category
  /**
   * この記事が名乗る軸。サービス1社か、ジャンル1つか、主題1つか。
   * 何を混ぜてよいかがここで決まる（`Axis` のコメント）。
   */
  readonly axis: Axis
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
  /**
   * バリアントを指すCLIフラグ名と、人間向けの呼び方。
   *
   * 既定は `genre` / `ジャンル`（`arrivals` がジャンル別なので、それが元の形）。
   * `leaving` のようにサービス別で分ける記事タイプは `service` / `サービス` を指定する。
   * ここを分けないと `--genre netflix` という指定になり、
   * 運用者が毎月見る画面に嘘が出る。
   */
  readonly variantFlag?: string
  readonly variantNoun?: string
  /**
   * バリアント以外に必要なCLIフラグ（`ArticleFlag`）。
   * 宣言すると `--list` に「要指示」と出て、`--emit` 時に必須のものが揃っているか確かめられる。
   */
  readonly flags?: readonly ArticleFlag[]
  /**
   * カテゴリが実行時に決まる記事タイプのための上書き。
   *
   * 特報は同じ記事タイプで「配信開始の特報」も「終了予定の特報」も書くので、
   * `category` を1つに固定できない。実装しなければ `category` がそのまま使われる。
   * ★ 返す値は `Category` のいずれかで、サイト側の CATEGORIES と揃っていること。
   */
  categoryOf?(ctx: ArticleContext): Category
  /**
   * 記事として成立する最低の素材数。`--list` の状態表示にだけ使う。
   *
   * **生成を機械的に止めはしない。** 少ない月でも出す判断はありうるので、
   * 「素材不足」と表示して運用者に見せるところまでにとどめる。
   */
  readonly minItems?: number
  /** 記事にする素材を選ぶ。空なら記事化しない。 */
  select(events: ChangeEvent[], ledger: Ledger, ctx: ArticleContext): ChangeEvent[]
  /** LLMへの指示を組み立てる */
  buildPrompt(items: ChangeEvent[], ctx: ArticleContext): { system: string; prompt: string }
  /**
   * ショート動画の台本の指示を組み立てる。**実装した記事タイプだけが台本を持つ。**
   *
   * 未実装なら台本を作らない。`ended`（見放題終了済み）が意図的に未実装なのは、
   * 「もう観られない」を30秒で言うと誤解を生みやすく、
   * 記事側でも MISLEADING_AFTER_END 検査で公開を止めている性質の記事だから。
   * 短い尺で誤解なく伝える型が見つかっていない以上、たたき台も作らない。
   *
   * 台本は記事の品質ゲートを通らない（`data/draft/short.md` に別ファイルで書く）。
   * 検査はすべて warn で、台本の不備が記事の公開を止めることは無い。
   */
  buildShortPrompt?(items: ChangeEvent[], ctx: ArticleContext): string
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
  /**
   * タイトルの検証。**本文の `verify` はタイトルを受け取らない**ので別に分けてある。
   *
   * ■ なぜ分けるか
   * `verify` に渡しているのは `parsed.body` だけ。タイトルまで渡す形に変えると
   * 4つの記事タイプの引数がすべて変わるうえ、本文の検査とタイトルの検査は
   * 見ているものが違う（片方は事実誤り、片方は記事の名乗り方）。
   *
   * ■ 中身はテーマパック側にある
   * 「【2026年9月】Netflixで…」という型は日本語の配信ブログの都合であって、
   * パイプラインが知るべきことではない。共通処理は `article-types/shared.ts` の
   * `titleIssues()` にあり、記事タイプはそこへ軸と動詞句を渡すだけでよい。
   */
  verifyTitle?(title: string, ctx: ArticleContext): VerifyIssue[]
}

// --- LLM出力のパース -----------------------------------------------------

export const OUTPUT_FORMAT = `出力は必ず次の形式にしてください。余計な前置きや後書きは書かないこと。

TITLE: （記事タイトル。30〜60文字）
DESCRIPTION: （検索結果に出る説明文。60〜120文字。1行で書くこと）
---BODY---
（ここから本文。Markdown形式。見出しは ## から始めること）

## 強調（**太字**）の書き方に注意

日本語では、閉じる \`**\` の直前が句点や閉じ括弧だと**太字にならず、\`**\` がそのまま画面に出ます。**
句点・読点・括弧は強調の外に出してください。

    ×  **シリーズ3作が同じ日に終わります。**麺屋の息子ポーが……
    ○  **シリーズ3作が同じ日に終わります**。麺屋の息子ポーが……

開く \`**\` の直後が \`『\` や \`「\` の場合も、直前が日本語の文字だと太字になりません。
読点を打つか、括弧を強調の外に出してください。

    ×  この中では**『オーメン』が終了する**のが目を引きます
    ○  この中では、**『オーメン』が終了する**のが目を引きます`

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
