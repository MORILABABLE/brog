/**
 * 品質ゲート。ここを通らない記事はPRを作らない。
 *
 * 機械的にチェックできることだけを見る。文章の良し悪しは人間のレビューに任せ、
 * ここでは「事故を防ぐ」ことに徹する。
 */
import type { ChangeEvent } from '../sources/types.ts'
import type { ParsedArticle } from './article.ts'

export interface VerifyIssue {
  /** error は公開を止める。warn は記録するが止めない。 */
  level: 'error' | 'warn'
  message: string
}

/** AdSense対策の下限。これを下回る記事は薄いと判断される。 */
const MIN_BODY_CHARS = 2000

/** 帰属表示（API利用規約上の義務）に含まれるべき文字列 */
const ATTRIBUTION_MARKER = 'Movie of the Night'

export interface VerifyInput {
  parsed: ParsedArticle
  items: ChangeEvent[]
  /** 既存記事のタイトル一覧（重複検知用） */
  existingTitles: string[]
  stopReason?: string
}

export function verifyArticle(input: VerifyInput): VerifyIssue[] {
  const issues: VerifyIssue[] = []
  const { parsed, items } = input
  const err = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warn', message })

  // --- 生成が途中で切れていないか ---
  if (input.stopReason === 'max_tokens') {
    err('出力が max_tokens で打ち切られています。本文が途中で切れているため公開できません。')
  }

  // --- 分量 ---
  // 空白と記号を除いた実質的な文字数で測る
  const bodyChars = parsed.body.replace(/\s/g, '').length
  if (bodyChars < MIN_BODY_CHARS) {
    err(`本文が ${bodyChars} 字です。${MIN_BODY_CHARS} 字以上必要です。`)
  }

  // --- タイトル・説明文 ---
  if (parsed.title.length < 10) err(`タイトルが短すぎます: ${parsed.title.length}字`)
  if (parsed.title.length > 70) warn(`タイトルが長めです（${parsed.title.length}字）。検索結果で省略される可能性があります。`)
  if (parsed.description.length < 30 || parsed.description.length > 160) {
    err(`説明文は30〜160字にしてください（現在 ${parsed.description.length}字）。サイトのスキーマ検証で落ちます。`)
  }
  if (parsed.description.includes('\n')) {
    err('説明文が複数行になっています。1行で書く必要があります。')
  }

  // --- 帰属表示（規約上の義務） ---
  if (!parsed.body.includes(ATTRIBUTION_MARKER)) {
    err(`本文に配信情報の提供元表記（${ATTRIBUTION_MARKER}）がありません。API利用規約上の義務です。`)
  }

  // --- 重複 ---
  if (input.existingTitles.includes(parsed.title)) {
    err(`同じタイトルの記事が既に存在します: ${parsed.title}`)
  }

  // --- 邦題の捏造チェック ---
  // 邦題が解決できなかった作品は原題のまま書かれているはず。
  // 原題が本文に無いなら、LLMが邦題を勝手に作った疑いがある。
  for (const e of items) {
    if (e.work.localizedTitle) continue
    if (!parsed.body.includes(e.work.title)) {
      err(
        `「${e.work.title}」は邦題が未確認の作品ですが、原題が本文にありません。` +
          '邦題を推測で書いていないか確認してください。',
      )
    }
  }

  // --- 取りこぼしチェック ---
  // 選んだ作品が本文に出てこないなら、素材が落ちている
  const missing = items.filter((e) => {
    const title = e.work.localizedTitle ?? e.work.title
    return !parsed.body.includes(title)
  })
  if (missing.length > 0) {
    warn(
      `${missing.length}件の作品が本文に含まれていません: ` +
        missing
          .slice(0, 3)
          .map((e) => e.work.localizedTitle ?? e.work.title)
          .join(' / '),
    )
  }

  return issues
}

export function hasError(issues: VerifyIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}
