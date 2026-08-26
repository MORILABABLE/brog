/**
 * ショート動画の台本。
 *
 * ■ 何のためのものか
 * 記事へ連れて行くための30秒。記事の代わりではない。
 * 30秒で読み上げられるのは約170字で、記事が扱う数十本のうち載るのは4〜5本だけ。
 * **1つのまとまりを見せて、残りを概要欄に送る**のが台本の仕事。
 *
 * ■ 記事と同時に作る理由
 * ショートのフックは「その月に見つけたまとまり」そのもので、
 * それは記事を書いたときに既に見つけている。
 * 後日あらためて記事から抽出するより、書いた直後のほうが精度が高く追加コストがない。
 *
 * ■ 記事の品質ゲートには混ぜない
 * 台本は `data/draft/short.md` に別ファイルで書く。`response.md` に混ぜると
 * `parseArticle()` が壊れ、**台本の不備で記事が公開できなくなる**。
 * 検査もすべて warn で、台本が記事を止めることは無い。
 *
 * ■ 出力先は `shorts/`（docs でも data でもない）
 * ユーザーが手で開いて詰める前提のファイルなので、
 * 生成物置き場（data/）にも読み物（docs/）にも置かない。git で管理する。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatMonthDay } from './datetime.ts'
import type { VerifyIssue } from './verify.ts'
import type { ChangeEvent } from '../sources/types.ts'

// --- 尺の物理的な制約 -----------------------------------------------------

/** YouTube ショートの上限。これを超える台本は作らない。 */
export const SHORT_MAX_SECONDS = 30

/**
 * 日本語ナレーションの読み上げ速度（字/秒）。
 *
 * 落ち着いた読みで5字/秒、ショートの速めの読みで6〜7字/秒。
 * 6を採るのは、**合成音声でも人の声でも破綻しない側**に倒すため。
 *
 * ★ ラテン文字は字数と読みの長さが一致しない。
 *   「Netflix」は7字だが読みは8音、「Amazon Prime Video」は17字で11音。
 *   ここは目安であって実測ではない。最終的な尺は必ず読み上げて確かめること。
 */
export const SHORT_CHARS_PER_SECOND = 6

/** カット切り替えと息継ぎに要る時間（秒／カット）。字数だけで測ると必ず尺を超える。 */
export const SHORT_CUT_PAUSE = 0.35

export const SHORT_MIN_CUTS = 4
export const SHORT_MAX_CUTS = 8
/** 1カットの読み上げ上限。長い1文はテロップにも収まらない。 */
export const SHORT_MAX_CUT_CHARS = 35
/** 画面に描ける長さ。make-shorts.mjs の組版が前提にしている値。 */
export const SHORT_CAPTION_MAX = 20
export const SHORT_NOTE_MAX = 16

/** 読み上げに使える字数の上限。カット数で変わる（間のぶんだけ減る）。 */
export function narrationBudget(cutCount: number): number {
  return Math.floor((SHORT_MAX_SECONDS - cutCount * SHORT_CUT_PAUSE) * SHORT_CHARS_PER_SECOND)
}

/** 空白を除いた実質の字数。記事の文字数の数え方と揃える。 */
export function speechChars(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

export function estimateSeconds(cuts: readonly ShortCut[]): number {
  const chars = cuts.reduce((n, c) => n + speechChars(c.narration), 0)
  return chars / SHORT_CHARS_PER_SECOND + cuts.length * SHORT_CUT_PAUSE
}

// --- 台本の形 -------------------------------------------------------------

export interface ShortCut {
  /** 読み上げる文 */
  narration: string
  /** 画面の主役。作品名かまとまりの正体 */
  caption: string
  /** 日付とサービス名。無いカットは空 */
  note: string
}

export interface ParsedShort {
  /** この台本の狙いを1行。何を軸にしたか */
  intent: string
  cuts: ShortCut[]
}

export const SHORT_OUTPUT_FORMAT = `台本は **\`data/draft/short.md\` に別ファイルで**保存してください。
記事（response.md）に混ぜてはいけません。形式は次の通りです。

NOTE: （この台本の軸を1行。記事のどの「まとまり」をフックにしたか）
---CUTS---
| # | ナレーション | テロップ | 補足 |
| --- | --- | --- | --- |
| 1 | Netflixに、京都アニメーション作品がまとめて見放題で入りました。 | 京都アニメーション作品 | 8月3日 Netflix |
| 2 | … | … | … |

- **概要欄は書かないこと。** 記事URL・出典表記はパイプラインが組み立てます
- 表の \`|\` を本文に含めないこと（含めるなら全角の｜にする）
- 最後のカットは残り本数を伝えてから締めの固定文言で終えること`

/**
 * 台本の下書きを分解する。形式が崩れていれば null。
 *
 * 記事と同じ区切り記号方式にしている理由は article.ts の冒頭にある
 * （長い日本語をJSON文字列に入れるとエスケープ事故が起きる）。
 */
export function parseShort(raw: string): ParsedShort | null {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

  const marker = text.indexOf('---CUTS---')
  if (marker < 0) return null

  const intent = text.slice(0, marker).match(/^NOTE:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const rows = text
    .slice(marker + '---CUTS---'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))

  if (rows.length < 3) return null

  const header = cells(rows[0]!)
  const col = (name: string) => header.findIndex((c) => c.includes(name))
  const iNarration = col('ナレーション')
  const iCaption = col('テロップ')
  const iNote = col('補足')
  if (iNarration < 0 || iCaption < 0) return null

  const cuts: ShortCut[] = []
  // 1行目は見出し、2行目は区切り
  for (const row of rows.slice(2)) {
    const c = cells(row)
    const narration = (c[iNarration] ?? '').trim()
    if (!narration) continue
    cuts.push({
      narration,
      caption: (c[iCaption] ?? '').trim(),
      note: iNote >= 0 ? (c[iNote] ?? '').trim() : '',
    })
  }

  return cuts.length > 0 ? { intent, cuts } : null
}

function cells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

// --- 検査（すべて warn。記事の公開を止めない） ----------------------------

export interface VerifyShortInput {
  short: ParsedShort
  items: ChangeEvent[]
  /** 締めの固定文言（差し込み済み） */
  closer: string
  /** サイトの基準タイムゾーン。日付の突き合わせに使う */
  offsetMinutes: number
}

/**
 * 台本の検査。**level は必ず warn にする。**
 *
 * 台本は人が詰めて完成させる前提のたたき台で、記事とは違って
 * この時点で公開されるものではない。ここを error にすると、
 * 台本の粗が記事の公開を止めることになり、優先順位が逆転する。
 */
export function verifyShort(input: VerifyShortInput): VerifyIssue[] {
  const { short, items, closer } = input
  const issues: VerifyIssue[] = []
  const warn = (message: string) => issues.push({ level: 'warn', message })

  const cuts = short.cuts
  const seconds = estimateSeconds(cuts)
  const budget = narrationBudget(cuts.length)
  const chars = cuts.reduce((n, c) => n + speechChars(c.narration), 0)

  // --- 尺 ---
  if (seconds > SHORT_MAX_SECONDS) {
    warn(
      `推定 ${seconds.toFixed(1)}秒でショートの上限（${SHORT_MAX_SECONDS}秒）を超えています。` +
        `読み上げ ${chars}字 → ${budget}字まで減らすか、カットを1つ落としてください。`,
    )
  }
  if (cuts.length < SHORT_MIN_CUTS || cuts.length > SHORT_MAX_CUTS) {
    warn(`カット数が ${cuts.length} です（${SHORT_MIN_CUTS}〜${SHORT_MAX_CUTS} が想定）。`)
  }
  for (const [i, c] of cuts.entries()) {
    if (speechChars(c.narration) > SHORT_MAX_CUT_CHARS) {
      warn(`カット${i + 1}の読み上げが ${speechChars(c.narration)}字あります（${SHORT_MAX_CUT_CHARS}字まで）。`)
    }
    if ([...c.caption].length > SHORT_CAPTION_MAX) {
      warn(`カット${i + 1}のテロップが長すぎます（${SHORT_CAPTION_MAX}字まで）: 「${c.caption}」`)
    }
    if ([...c.note].length > SHORT_NOTE_MAX) {
      warn(`カット${i + 1}の補足が長すぎます（${SHORT_NOTE_MAX}字まで）: 「${c.note}」`)
    }
  }

  // --- 締めの固定文言 ---
  const last = cuts.at(-1)
  if (closer && last && !last.narration.includes(closer)) {
    warn(`最後のカットが締めの固定文言で終わっていません。次をそのまま入れてください:\n      ${closer}`)
  }

  // --- 誤情報の芽 ---
  //
  // 記事と同じ重さの問題（視聴者に直接届く誤情報）なので、粗くても必ず見る。
  // ただし**確実に判定できるものだけ**を対象にする。テロップは作品名とは限らず
  // 「京都アニメーション作品」のようなまとまりの名前も入るため、
  // 素のテロップと素材を突き合わせると正しい台本まで警告してしまう。

  const known = new Set<string>()
  for (const e of items) {
    if (e.work.localizedTitle) known.add(e.work.localizedTitle)
    if (e.work.title) known.add(e.work.title)
  }
  const titles = [...known].filter(Boolean).sort((a, b) => b.length - a.length)

  // 1. 「」『』で囲まれた作品名。囲んである以上、作品名として書かれている。
  const text = cuts.map((c) => `${c.narration} ${c.caption} ${c.note}`).join('\n')
  for (const m of text.matchAll(/[「『]([^「」『』]+)[」』]/g)) {
    const quoted = m[1]!.trim()
    if (titles.some((t) => t.includes(quoted) || quoted.includes(t))) continue
    warn(`「${quoted}」に対応する作品が素材にありません。作品名を確かめてください。`)
  }

  // 2. 日付。素材が持っていない日付を画面と音声に出してはいけない。
  //    同じ日付はナレーションとテロップと補足に3回出るので、一度だけ言う。
  const knownDates = new Set(
    items.filter((e) => e.at).map((e) => formatMonthDay(e.at!, input.offsetMinutes)),
  )
  const badDates = new Set(
    [...text.matchAll(/\d{1,2}月\d{1,2}日/g)].map((m) => m[0]).filter((d) => !knownDates.has(d)),
  )
  for (const d of badDates) {
    warn(`${d} は素材にない日付です。与えられた日付以外を書いてはいけません。`)
  }

  // 評価スコアは30秒では出典を示せない。数字だけが独り歩きする。
  // 判定は記事側（shared.ts の RATING_IN_PROSE）と同じ形にしてある。
  for (const [i, c] of cuts.entries()) {
    if (/評価(?:は|が|で|の)?\s*\d+|\d+\s*\/\s*100|最高評価/.test(`${c.narration} ${c.caption} ${c.note}`)) {
      warn(`カット${i + 1}で評価スコアに言及しています（ショートには出しません）。`)
    }
  }

  // 台本の全文に混ざった半角記号。作品名の正式表記（「Free!」など）は除外する。
  let plain = text
  for (const t of titles) plain = plain.split(t).join('')
  const halfWidth = [...new Set(plain.match(/[!?()]/g) ?? [])]
  if (halfWidth.length) {
    warn(`半角記号が混ざっています: ${halfWidth.join(' ')} → 全角（！ ？ （ ））に統一してください。`)
  }

  return issues
}

// --- 台本ファイルの組み立て -----------------------------------------------

export interface BuildShortOptions {
  slug: string
  /** 記事タイプID。make-shorts.mjs は使わないが、あとから台本を選別するのに要る */
  typeId: string
  variantKey?: string
  /** 記事タイトル（response.md から） */
  articleTitle: string
  /** 記事の公開URL（絶対） */
  articleUrl: string
  short: ParsedShort
  /** 差し込み済みの概要欄 */
  description: string
  generatedAt: Date
  offsetMinutes: number
}

/**
 * `shorts/<スラッグ>.md` の中身を作る。
 *
 * ■ frontmatter と概要欄はここで組み立てる（人にもLLMにも書かせない）
 * 記事URL・出典表記は機械的に決まる事実で、**出典表記は動画にも義務がある**。
 * 人が毎回書く形にすると、忘れた回がそのまま規約違反になる。
 *
 * ■ 秒数をファイルに焼き込まない
 * ユーザーがナレーションを直せば秒数は変わる。書いた瞬間に古くなる数字を
 * ファイルに残すと、直したあとも古い数字を信じることになる。
 * 生成時点の見積りだけを1行添え、**数え直しは `npm run shorts` が行う**。
 */
export function buildShortMarkdown(o: BuildShortOptions): string {
  const { short } = o
  const seconds = estimateSeconds(short.cuts)
  const chars = short.cuts.reduce((n, c) => n + speechChars(c.narration), 0)
  const date = new Date(o.generatedAt.getTime() + o.offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10)

  const fm = [
    '---',
    `slug: '${o.slug}'`,
    `type: '${o.typeId}'`,
    ...(o.variantKey ? [`variant: '${o.variantKey}'`] : []),
    `article: '${o.articleUrl}'`,
    `generatedAt: ${date}`,
    '---',
  ].join('\n')

  const table = [
    '| # | ナレーション | テロップ | 補足 |',
    '| --- | --- | --- | --- |',
    ...short.cuts.map(
      (c, i) => `| ${i + 1} | ${c.narration} | ${c.caption} | ${c.note} |`,
    ),
  ].join('\n')

  return `${fm}

# ${o.articleTitle}

> **これはたたき台です。** そのまま撮らず、手で詰めてから使ってください。
> 直し方は [shorts/README.md](./README.md)。

${short.intent ? `**この台本の軸**: ${short.intent}\n` : ''}
## カット

生成時点の見積り: 読み上げ **${chars}字** ／ 推定 **${seconds.toFixed(1)}秒**
（直したら \`cd site && npm run shorts\` が数え直します）

${table}

## 概要欄

<!--
  ここから下をそのまま YouTube の概要欄に貼れます。

  ★ アフィリエイトリンクを足す場合は、いちばん先頭に「PR」の1行を置くこと。
    景品表示法（ステマ規制）が分かりやすい位置での明記を求めています。
    記事側の扱いは docs/AFFILIATE.md 5-5 と同じです。

  ★ 出典の行は消さないこと。配信情報の帰属表示は利用規約上の義務で、
    YouTube は記事とは別の配布先なので、概要欄に無いと義務を果たしたことになりません。
-->

\`\`\`
${o.description}
\`\`\`

## 詰めるところ

- [ ] ナレーションを実際に読み上げて、30秒に収まるか確かめる
- [ ] 声を決める（合成音声を使う場合は、そのキャラクターの利用規約とクレジット表記を確認する）
- [ ] BGM を選ぶ（YouTube オーディオライブラリが最も安全。外部素材は商用可否を確認する）
- [ ] カット画像を作る（\`cd site && npm run shorts\` → \`shorts/frames/${o.slug}/\`）
- [ ] サムネイルを作る
- [ ] 概要欄にアフィリエイトリンクを貼るなら、先頭に「PR」を置く

> **作品ポスターは動画に使えません。** 使えるのは自前で生成した画像だけです。
> 理由は docs/APPEARANCE.md 11節「動画には使わない」。
`
}

// --- 概要欄の材料 ---------------------------------------------------------

/**
 * 記事のタグからハッシュタグを作る。
 *
 * 空白と中黒はハッシュタグとして成立しないので落とす。
 * 「洋画・海外ドラマ」は2つに割る（#洋画海外ドラマ という語は存在しない）。
 */
export function hashtags(tags: readonly string[]): string {
  const out: string[] = []
  for (const tag of tags) {
    for (const part of tag.split(/[・/]/)) {
      const t = part.replace(/\s+/g, '')
      if (t && !out.includes(t)) out.push(t)
    }
  }
  return out.map((t) => `#${t}`).join(' ')
}

/**
 * サイトの公開URL。
 *
 * ★ **`site/src/config.ts` から読む。theme.yaml に書き写さない。**
 *   ドメインは site 側の SITE.url が唯一の出典で（config.ts の冒頭にそう書いてある）、
 *   ここに2つ目の写しを作ると、ドメインを変えたときに
 *   **記事は新ドメイン・動画の概要欄だけ旧ドメイン**という壊れ方をする。
 *   読み取れなければ黙って空にせず落とす。
 */
export function siteOrigin(repoRoot = '.'): string {
  const path = join(repoRoot, 'site', 'src', 'config.ts')
  const src = readFileSync(path, 'utf8')
  const url = /url:\s*'([^']+)'/.exec(src)?.[1]
  if (!url) throw new Error(`${path}: SITE.url を読み取れませんでした`)
  return url.replace(/\/$/, '')
}

export function articleUrl(slug: string, repoRoot = '.'): string {
  return `${siteOrigin(repoRoot)}/posts/${slug}/`
}
