/**
 * 記事タイプ: 配信終了（expiring）
 *
 * 収集済みの expiring イベントから「今月終了する作品」の記事を作る。
 * 終了日はAPIが返す確定情報なので、推測記事ではなく事実記事になる。
 *
 * ■ 文章の型は3つのファイルに分かれている
 *   templates/leaving.md              構成と文体のルール
 *   templates/fixed-phrases.md        毎月そのまま使う文言
 *   templates/examples/leaving-excerpt.md  狙いどおりに書けた実例の抜粋
 * このファイルはそれらを組み立ててプロンプトにし、書かれた記事を検査する。
 */
import { readFileSync } from 'node:fs'
import { OUTPUT_FORMAT, type ArticleContext, type ArticleType } from '../../../pipeline/core/article.ts'
import { buildSearchLinks } from '../../../pipeline/core/search-links.ts'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { loadFixedPhrases, render, type FixedPhrases } from '../../../pipeline/core/fixed-phrases.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { VerifyIssue } from '../../../pipeline/core/verify.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'

/**
 * 1記事に載せる上限。
 *
 * 構成4「全終了作品リストは漏れなく全件」が原則なので、
 * 通常の月がまるごと収まる数にしておく。青天井にしないのは、
 * 極端に多い月に本文が薄くなり max_tokens も圧迫するため。
 */
const MAX_ITEMS = 80

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'lead-first-sentence',
  'lead-closer',
  'other-services-intro',
  'attribution',
] as const

/**
 * 段落を「視聴を促す形」で締めているとみなす語尾。
 * テンプレート構成2の締めルール（`templates/leaving.md`）に対応する。
 */
const CALL_TO_ACTION = /(ましょう|ください|見逃せません|お見逃しなく|お見逃しがないように|おすすめです)[。！]?$/

export const leavingArticle: ArticleType = {
  id: 'leaving',
  category: 'leaving',

  select(events, _ledger: Ledger, ctx) {
    const target = events
      .filter((e) => e.kind === 'expiring')
      // 終了日が不明なものは記事にできない
      .filter((e) => e.at)
      // 対象月に終了するものだけ。判定はサイトの基準タイムゾーンで行う。
      .filter((e) => isTargetMonth(e.at!, ctx))
      // ★ 既に終了済みのものを除く。
      //   これが無いと、月の途中で生成したときに終了済み作品を
      //   「これから終了します」と書いてしまう。読者にとっては明確な誤情報。
      .filter((e) => Date.parse(e.at!) >= ctx.now.getTime())

    // 上限を超えるときは「終了日が早い順」ではなく「評価の高い順」で残す。
    // 日付順で切ると月の後半がまるごと落ち、
    // 「月後半は何も終わらない」と読める記事になってしまう。
    const kept =
      target.length <= MAX_ITEMS
        ? target
        : [...target].sort((a, b) => (b.work.rating ?? 0) - (a.work.rating ?? 0)).slice(0, MAX_ITEMS)

    // 記事は終了日順に書くので、最後に日付で並べ直す
    return kept.sort((a, b) => a.at!.localeCompare(b.at!))
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'leaving.md'), 'utf8')
    const example = readFileSync(
      themeFile(ctx.theme, 'templates', 'examples', 'leaving-excerpt.md'),
      'utf8',
    )
    const phrases = fixedPhrases(ctx)
    const labelOf = new Map(ctx.theme.catalogs.map((c) => [c.key, c.label]))
    const offset = ctx.theme.utc_offset_minutes

    const rows = items.map((e) => {
      const links = buildSearchLinks(e.work, ctx.theme.search_links ?? [])
      const title = e.work.localizedTitle ?? e.work.title
      const note = e.work.localizedTitle
        ? `（原題: ${e.work.title}）`
        : '（★邦題が未確認。この原題のまま書くこと）'

      return [
        `- ${title} ${note}`,
        `  サービス: ${labelOf.get(e.service) ?? e.service}`,
        `  終了日: ${formatMonthDay(e.at!, offset)}`,
        e.work.year ? `  公開年: ${e.work.year}年` : '',
        e.work.rating ? `  評価: ${e.work.rating}/100` : '',
        e.work.genres.length ? `  ジャンル: ${e.work.genres.join(' / ')}` : '',
        e.work.overview ? `  あらすじ(英語原文): ${e.work.overview}` : '',
        links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    // 差し込み済みの固定文言。プロンプトにも検査にも同じ値を使う。
    const resolved = resolvePhrases(phrases, items, ctx)

    const system = `あなたは動画配信サービスの情報を扱う日本語ブログの編集者です。
与えられたデータだけを使って記事を書きます。データに無い事実を書いてはいけません。

${template}

---

# 今月そのまま使う固定文言

以下は**一字一句そのまま**本文に入れてください。言い換え・要約・記号の変更をしてはいけません。

## リードの1文目（本文の冒頭）

${resolved.leadFirstSentence}

## リードの締め（リード段落の最後の1文）

${resolved.leadCloser}

## 「他のサービスで探す」の冒頭

${resolved.otherServicesIntro}

## 記事の末尾

${resolved.attribution}

---

${example}

---

${OUTPUT_FORMAT}`

    const prompt = `以下は今月配信終了が確定している作品のデータです。全${items.length}件。

${rows.join('\n\n')}

---

このデータから記事を書いてください。

特に重要な作業:
1. 終了日を見比べて「同じ日に終了するまとまり」を探すこと。
   同一監督・同一シリーズ・同一ジャンルの集中があれば、それを記事の軸にする。
2. リードの2段落目では、見つけたまとまりのうち**知名度の高いものを終了日順に**、
   作品名・シリーズ名を「」で囲んで挙げること。記事の構造の説明は書かない。
   目立つシリーズが無ければ、有名作・人気作、近年に続編が出た作品を優先する。
3. まとまりを解説する \`##\` セクションは、**見出しに具体的な作品名を入れ**、
   **最終段落を「〜しましょう」など視聴を促す形で締める**こと。
4. あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
5. 「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。
6. 記号は全角に統一してください（！ ？ （） を半角で書かない）。`

    return { system, prompt }
  },

  tags(items, ctx) {
    const labelOf = new Map(ctx.theme.catalogs.map((c) => [c.key, c.label]))
    const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
    const [y, m] = ctx.targetMonth.split('-')
    return [...services, '配信終了', `${y}年${Number(m)}月`]
  },

  slug(ctx) {
    return `${ctx.targetMonth}-leaving`
  },

  verify(raw, items, ctx): VerifyIssue[] {
    // 改行コードを正規化してから見る。CRLF のままだと行単位の検査が
    // 一致せず、「検査したが何も見つからなかった」ように見えてしまう。
    const md = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()

    const issues: VerifyIssue[] = []
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const resolved = resolvePhrases(fixedPhrases(ctx), items, ctx)

    // --- 事故を防ぐ検査（公開を止める） ---

    // 全終了作品リスト（表）があるか
    if (!md.includes('|')) {
      err('全終了作品の一覧表がありません。テンプレートの構成4が守られていません。')
    }
    // 他サービス検索リンクがあるか（収益導線かつ読者の実用性）
    if (!/U-NEXT|Hulu|DMM/.test(md)) {
      err('他サービスでの検索リンクがありません。テンプレートの構成5が守られていません。')
    }
    // 「配信中」と断定していないか（把握していないサービスについての誤情報）
    if (/U-NEXTで配信中|Huluで配信中|DMM TVで配信中/.test(md)) {
      err('対象外サービスについて「配信中」と断定しています。配信状況のデータを持っていないため書けません。')
    }
    // 基準日。ここがずれていると、読者は古い本数を今の本数だと思って読む。
    const asOf = md.match(/[（(](\d{1,2}月\d{1,2}日)時点[）)]/)
    if (!asOf) {
      err(`リードに「（${resolved.asOf}時点）」がありません。いつ時点の情報かを必ず示します。`)
    } else if (asOf[1] !== resolved.asOf) {
      err(`基準日が記事作成日と違います。本文「${asOf[1]}時点」／記事作成日「${resolved.asOf}」。`)
    }

    // --- 固定文言の検査（公開を止める） ---

    if (!md.startsWith(resolved.leadPrefix)) {
      err(`本文の冒頭が「${resolved.leadPrefix}」で始まっていません。リードの1文目は固定の型です。`)
    }
    if (!md.includes(resolved.leadCloser)) {
      err(`リードの締めの固定文言がありません。次の1文をそのまま入れてください:\n      ${resolved.leadCloser}`)
    }
    if (!md.includes(resolved.otherServicesIntro)) {
      err('「他のサービスで探す」の冒頭が固定文言と一致しません。fixed-phrases.md の文言をそのまま使ってください。')
    }

    // --- 文体の検査（止めない。判定が外れることがあるため） ---

    const firstLine = md.split('\n', 1)[0] ?? ''
    if (firstLine !== resolved.leadFirstSentence && md.startsWith(resolved.leadPrefix)) {
      warn(`リードの1文目が想定の型と違います。想定:\n      ${resolved.leadFirstSentence}`)
    }

    for (const section of dateSections(md)) {
      const last = section.lastParagraph
      if (last && !CALL_TO_ACTION.test(last)) {
        warn(
          `「${section.heading}」の最後が視聴を促す形で終わっていません: 「${clip(last)}」` +
            '（「〜しましょう」「見逃せません」など）',
        )
      }
    }

    const halfWidth = [...new Set(stripLinks(md).match(/[!?()]/g) ?? [])]
    if (halfWidth.length) {
      warn(`半角記号が混ざっています: ${halfWidth.join(' ')} → 全角（！ ？ （ ））に統一してください。`)
    }

    return issues
  },
}

// --- 固定文言 -------------------------------------------------------------

let cache: { key: string; phrases: FixedPhrases } | undefined

/** テーマごとに1度だけ読む。buildPrompt と verify の両方から呼ばれる。 */
function fixedPhrases(ctx: ArticleContext): FixedPhrases {
  if (cache?.key !== ctx.theme.key) {
    cache = {
      key: ctx.theme.key,
      phrases: loadFixedPhrases(themeFile(ctx.theme, 'templates', 'fixed-phrases.md'), REQUIRED_PHRASES),
    }
  }
  return cache.phrases
}

interface ResolvedPhrases {
  /** 【8月終了】 */
  leadPrefix: string
  leadFirstSentence: string
  leadCloser: string
  otherServicesIntro: string
  attribution: string
  /** 記事作成日。「8月9日」形式 */
  asOf: string
}

/** 固定文言に今月の値を差し込む。プロンプトと検査で同じ結果になることが要件。 */
function resolvePhrases(
  phrases: FixedPhrases,
  items: ChangeEvent[],
  ctx: ArticleContext,
): ResolvedPhrases {
  const offset = ctx.theme.utc_offset_minutes
  const vars = {
    月: articleMonth(ctx),
    サービス: serviceNames(items, ctx),
    基準日: formatMonthDay(ctx.now.toISOString(), offset),
    本数: items.length,
  }
  const get = (key: string) => render(phrases.get(key) ?? '', vars)

  return {
    leadPrefix: `【${vars.月}月終了】`,
    leadFirstSentence: get('lead-first-sentence'),
    leadCloser: get('lead-closer'),
    otherServicesIntro: get('other-services-intro'),
    attribution: get('attribution'),
    asOf: vars.基準日,
  }
}

/**
 * 記事が対象とする月。
 * 実行日ではなく対象月から取る。8月のうちに9月分を書く場合でもずれない。
 */
function articleMonth(ctx: ArticleContext): number {
  return Number(ctx.targetMonth.split('-')[1])
}

/** 「NetflixとAmazon Prime Video」。3つ以上なら中黒でつなぐ。 */
function serviceNames(items: ChangeEvent[], ctx: ArticleContext): string {
  const present = new Set(items.map((e) => e.service))
  // 並び順はテーマの定義順に固定する。月によって順番が入れ替わらないようにするため。
  const labels = ctx.theme.catalogs.filter((c) => present.has(c.key)).map((c) => c.label)
  if (labels.length === 0) return ctx.theme.catalogs.map((c) => c.label).join('・')
  if (labels.length === 2) return labels.join('と')
  return labels.join('・')
}

// --- 本文の走査 -----------------------------------------------------------

interface DateSection {
  heading: string
  /** 表・箇条書き・見出しを除いた、最後の本文段落 */
  lastParagraph: string | undefined
}

/**
 * `## 8月14日：…` 形式のセクションを取り出す。
 * 締めルールの対象は日付ごとのまとまりだけで、
 * 「その他の注目作」「全終了作品リスト」などは対象外（テンプレート構成3参照）。
 */
function dateSections(md: string): DateSection[] {
  const sections: DateSection[] = []
  let current: { heading: string; lines: string[] } | undefined

  const flush = () => {
    if (!current) return
    const prose = current.lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('|') && !l.startsWith('-') && !l.startsWith('#') && !l.startsWith('>'))
    sections.push({
      heading: current.heading,
      lastParagraph: prose.at(-1)?.replace(/\*+/g, '').trim(),
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
function stripLinks(md: string): string {
  return md.replace(/\[[^\]]*\]\([^)]*\)/g, '')
}

function clip(s: string, max = 40): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

/** サイトのタイムゾーンで見て、記事の対象月に入るか */
function isTargetMonth(iso: string, ctx: ArticleContext): boolean {
  const shifted = new Date(Date.parse(iso) + ctx.theme.utc_offset_minutes * 60_000)
  return shifted.toISOString().slice(0, 7) === ctx.targetMonth
}
