/**
 * 品質ゲート。ここを通らない記事はPRを作らない。
 *
 * 機械的にチェックできることだけを見る。文章の良し悪しは人間のレビューに任せ、
 * ここでは「事故を防ぐ」ことに徹する。
 */
import type { ChangeEvent } from '../sources/types.ts'
import type { ParsedArticle } from './article.ts'
import { adPolicyHits } from './ad-policy.ts'
import { mentionsByTitle } from './coverage.ts'

export interface VerifyIssue {
  /** error は公開を止める。warn は記録するが止めない。 */
  level: 'error' | 'warn'
  message: string
}

/**
 * 本文全体の下限。**安全網であって、独自性の物差しではない。**
 *
 * ■ なぜ2,000から下げたか（2026-09-19・テンプレ改修）
 * 解説を中心2〜3作に絞り、「他のサービスで探す」の節を廃止したので、
 * 記事1本の総量が下がる。ただし**この数字が止めた記事は一度も無い**
 * （公開済み37本の最小は5,980字。地の文だけでも2,810字あった）。
 *
 * ★ **総文字数は表の行数で決まる。** 63行の表がある記事は、解説が1文も無くても
 *   2,000字を超える。だから「記事が薄いか」はこの数字では分からない。
 *   それを見るのは下の `MIN_PROSE_CHARS`。**片方だけ動かさないこと。**
 */
const MIN_BODY_CHARS = 1200

/**
 * **地の文の下限**（2026-09-19 新設）。表・リンク・画像・見出しを除いた、
 * **自分の言葉で書いた分量**。
 *
 * ■ なぜ総文字数と別に要るか
 * AdSense が見るのは字数ではなく独自の価値で、当サイトでそこに当たるのは
 * リード・解説・まとめだけ。表の行は提供元のデータで、並べるほど
 * 総文字数は増えるが独自性は増えない。**実測で「他のサービスで探す」の節は
 * `kamen-rider` の本文の68%（26,028字）を占めていた**が、
 * 中身は検索リンクの羅列だった。総量で測っているかぎり、
 * この種の水増しと解説の厚みを区別できない。
 *
 * ★ 上限は `templates/writing.md`（解説は小段落あたり1,000字・シリーズ1,500字）。
 *   **下限と上限で挟んである**ので、どちらかを動かすときは両方を見ること。
 */
const MIN_PROSE_CHARS = 1000

/**
 * 地の文だけを取り出す。**除くのは「自分で書いていない行」。**
 *
 *   `|` 始まり   … 表の行（提供元のデータ）
 *   `[![` 始まり … ポスターの画像リンク（`scripts/posters.mjs` が入れる）
 *   `- ` 始まり  … 箇条書き（検索リンクなど、機械が組む行）
 *   `#` 始まり   … 見出し
 *   `>` 始まり   … 引用（出典表記）
 */
export function proseOf(body: string): string {
  return body
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return t !== '' && !/^[|>#]/.test(t) && !t.startsWith('[![') && !t.startsWith('- ')
    })
    .join('\n')
}

/**
 * データの出どころごとの出典表記。本文に必ず含まれていなければならない。
 *
 * ★ 一律に Movie of the Night を要求してはいけない。
 *   U-NEXT はそのAPIから取っていないので、機械的に付けると
 *   **取得していないAPIを出典として偽る**ことになる。
 *   義務の性質も違う（前者は利用規約上の義務、後者は読者への説明責任）。
 *
 * 上から順に最初に当たったものを使う。1記事に複数の出どころが混ざるなら、
 * その全部が本文に必要になる。
 */
const ATTRIBUTIONS: {
  match: (e: ChangeEvent) => boolean
  marker: string
  reason: string
}[] = [
  {
    match: (e) => e.work.meta.source === 'u-next',
    marker: 'U-NEXT の作品ページ',
    reason: '出どころと基準日を読者に示す必要があります',
  },
  {
    // 各社が前月末に出す翌月ラインナップの告知（pipeline/sources/announcement.ts）。
    // ★ これを Movie of the Night 側に落とすと、**取得していないAPIを出典として偽る**。
    //   加えて、告知は「予定」であって配信中の事実ではない。
    //   予定が動きうることまで含めて読者に示す義務がこちら側にある。
    match: (e) => e.work.meta.source === 'announcement',
    marker: '公式発表',
    reason: '予定は変更されうるので、出どころと基準日を読者に示す必要があります',
  },
  {
    match: () => true,
    marker: 'Movie of the Night',
    reason: 'API利用規約上の義務です',
  },
]

export interface VerifyInput {
  parsed: ParsedArticle
  items: ChangeEvent[]
  /** 既存記事のタイトル一覧（重複検知用） */
  existingTitles: string[]
  stopReason?: string
  /**
   * 作品が本文に出ているかの判定。**渡されなければ題名の完全一致で見る。**
   * 差し替えられるようにしてあるのは `ArticleType.mentions` のため。
   */
  mentions?: (item: ChangeEvent, body: string) => boolean
  /**
   * 本文全体・地の文の下限の上書き（`ArticleType.minBodyChars` / `minProseChars`）。
   * **シリーズ記事だけが長い**（解説の上限が1,500字なので、下限もそれに見合う）。
   */
  minBodyChars?: number
  minProseChars?: number
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
  const minBody = input.minBodyChars ?? MIN_BODY_CHARS
  const bodyChars = parsed.body.replace(/\s/g, '').length
  if (bodyChars < minBody) {
    err(`本文が ${bodyChars} 字です。${minBody} 字以上必要です。`)
  }

  /*
   * ★ **こちらが本命。** 総文字数は表の行数で増えるので、
   *   記事が薄いかどうかは地の文でしか分からない（上の MIN_PROSE_CHARS）。
   */
  const minProse = input.minProseChars ?? MIN_PROSE_CHARS
  const proseChars = proseOf(parsed.body).replace(/\s/g, '').length
  if (proseChars < minProse) {
    err(
      `地の文が ${proseChars} 字です。${minProse} 字以上必要です` +
        '（表・検索リンク・ポスターの行を除いた、自分の言葉で書いた分量）。\n' +
        '      表の行を増やしても、ここは増えません。リード・解説・まとめを厚くしてください。',
    )
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

  // --- 広告主のガイドライン ---
  // **記事は広告の載る面そのもの**なので、本文の言い回しがそのまま
  // アフィリエイトの違反になる。違反は提携解除と過去分を含む成果の全件却下に
  // つながるので、公開を止める（一覧と条番号は core/ad-policy.ts）。
  //
  // ★ タイトルと説明文も見る。検索結果に出るのはそちらで、
  //   「今なら無料」の類はまずタイトルに書かれる。
  for (const hit of adPolicyHits(`${parsed.title}\n${parsed.description}\n${parsed.body}`)) {
    err(`広告主のガイドラインで禁止されている表現があります: 「${hit.found}」（${hit.why}）`)
  }

  // --- 出典表記 ---
  // 素材の出どころから必要な表記を割り出す。記事タイプごとに書き分けるのではなく、
  // データ側から決めるのは、書き分けを忘れても落ちるようにするため。
  const required = new Map<string, string>()
  for (const e of items) {
    const a = ATTRIBUTIONS.find((x) => x.match(e))!
    required.set(a.marker, a.reason)
  }
  for (const [marker, reason] of required) {
    if (!parsed.body.includes(marker)) {
      err(`本文に配信情報の提供元表記（${marker}）がありません。${reason}。`)
    }
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
  // ★ 既定は `coverage.ts` と共有する。公開を止める検査（ここ）と
  //   公開後の取りこぼし検査（`coverageGap`）が別々の答えを出さないようにする。
  const mentions = input.mentions ?? mentionsByTitle
  const missing = items.filter((e) => !mentions(e, parsed.body))
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
