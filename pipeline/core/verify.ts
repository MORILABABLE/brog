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

/**
 * 強調記法（`**`）が Markdown として成立しているかを調べる。
 *
 * ■ なぜ必要か
 * CommonMark は `**` を「開ける/閉じられる」かを前後の文字種で判定する
 * （left-flanking / right-flanking 規則）。日本語の全角約物と隣接すると
 * この判定が成立せず、`**` がそのまま本文に表示される。実際に起きた例:
 *
 *   ×  **……終了します。**麺屋の息子ポーが……
 *      閉じ側の直前が「。」（約物）で直後が「麺」（文字）→ 閉じられない
 *      → 「**」が画面に出る
 *   ○  **……終了します**。麺屋の息子ポーが……
 *
 *   ×  この中では**『オーメン』が……終了する**のが
 *      開き側の直前が「は」（文字）で直後が「『」（約物）→ 開けない
 *   ○  この中では、**『オーメン』が……終了する**のが
 *
 * ■ 判定の範囲
 * 2個以上の `*` の連なりだけを見る。1個の `*` は箇条書きの記号と
 * 区別がつかず、誤検知の方が害になるため対象外。
 */
const UNICODE_PUNCT = /[\p{P}\p{S}]/u

interface DelimiterRun {
  index: number
  canOpen: boolean
  canClose: boolean
}

function classifyRuns(block: string): DelimiterRun[] {
  const runs: DelimiterRun[] = []
  const re = /\*{2,}/g
  let m: RegExpExecArray | null

  while ((m = re.exec(block)) !== null) {
    const before = m.index > 0 ? block[m.index - 1]! : ''
    const afterAt = m.index + m[0].length
    const after = afterAt < block.length ? block[afterAt]! : ''

    // 行頭・行末は空白として扱う（CommonMark の定義どおり）
    const beforeSpace = before === '' || /\s/u.test(before)
    const afterSpace = after === '' || /\s/u.test(after)
    const beforePunct = before !== '' && UNICODE_PUNCT.test(before)
    const afterPunct = after !== '' && UNICODE_PUNCT.test(after)

    runs.push({
      index: m.index,
      canOpen: !afterSpace && (!afterPunct || beforeSpace || beforePunct),
      canClose: !beforeSpace && (!beforePunct || afterSpace || afterPunct),
    })
  }
  return runs
}

/**
 * 対になれない `**` の位置を返す。空なら全て正しく描画される。
 * 公開済み記事の一括点検にも使えるよう export している。
 */
export function unpairedEmphasis(body: string): { index: number; block: string }[] {
  // コードフェンス内は Markdown として解釈されないので除外する
  const scrubbed = body.replace(/```[\s\S]*?```/g, '')
  const bad: { index: number; block: string }[] = []

  // 強調は空行をまたげない。段落ごとに突き合わせる。
  for (const block of scrubbed.split(/\n\s*\n/)) {
    const stack: DelimiterRun[] = []
    const orphans: DelimiterRun[] = []

    for (const run of classifyRuns(block)) {
      if (run.canClose && stack.length > 0) {
        stack.pop()
      } else if (run.canOpen) {
        stack.push(run)
      } else {
        orphans.push(run)
      }
    }
    for (const run of [...orphans, ...stack]) bad.push({ index: run.index, block })
  }
  return bad
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

  // --- Markdown が壊れていないか ---
  // 対になれない `**` は画面にそのまま出る。読者に見える明確な欠陥なので止める。
  for (const { index, block } of unpairedEmphasis(parsed.body)) {
    const around = block.slice(Math.max(0, index - 28), index + 30).replace(/\n/g, ' ')
    err(
      `強調記法が Markdown として成立していません: 「…${around}…」\n` +
        '      日本語では「〜します。**次の文」のように閉じ記号の直前が約物だと閉じられません。\n' +
        '      「〜します**。次の文」のように、句点や括弧を強調の外に出してください。',
    )
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
