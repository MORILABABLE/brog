/**
 * 記事タイプ: 配信終了済み（removed）
 *
 * ■ なぜ「終了後」の記事を出すのか
 * API が expiring（配信終了予定）を返すのは、実測で Netflix と Amazon Prime Video
 * の2社だけ。Disney+ はこの2社と同じ catalogs に含めて要求しても expiring が
 * 0件しか返らない（2026-08 の6回の収集・1,089件で確認。取得上限による打ち切り
 * ではなく、上限に一度も達していない）。
 *
 * つまり Disney+ の終了情報は、`leaving`（配信終了予定）の記事には構造的に載らない。
 * 黙って落とすとそのサービスの終了情報が読者に一切届かないので、
 * **終了後に removed から拾って届ける**のがこの記事タイプ。
 *
 * ■ leaving と決定的に違う点
 * 読者はすでに観る機会を逃している。急かしても、おすすめしても観られない。
 * 渡せる価値は「他のサービスで探せる」という次の一手だけ。
 * したがって:
 *   - 締めは「観ておきましょう」ではなく「探せます」
 *   - 「お見逃しなく」「今のうちに」の類は verify が公開を止める
 *   - 他サービス検索リンクの節が、補足ではなく記事の中心になる
 *
 * ■ 文章の型は2つのファイルに分かれている
 *   templates/ended.md            構成と文体のルール
 *   templates/fixed-phrases.md    毎月そのまま使う文言（ended- で始まるキー）
 */
import { readFileSync } from 'node:fs'
import { OUTPUT_FORMAT, type ArticleContext, type ArticleType } from '../../../pipeline/core/article.ts'
import { buildSearchLinks } from '../../../pipeline/core/search-links.ts'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { VerifyIssue } from '../../../pipeline/core/verify.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'
import { productionCompanies } from '../work-context.ts'
import {
  articleMonth,
  asOfLabel,
  clip,
  dateSections,
  fixedPhrases,
  halfWidthSymbols,
  isTargetMonth,
  itemTitles,
  normalizeBody,
  phraseReader,
  ratingMentionsInProse,
  serviceLabels,
  serviceNames,
} from './shared.ts'

/**
 * この記事で扱うサービス（theme.yaml の catalogs の key）。
 *
 * **expiring が取れないサービスだけを入れること。**
 * Netflix と Amazon Prime Video は `leaving` が終了前に知らせているので、
 * ここに入れると同じ作品を二度扱うことになり、しかも後から出す分だけ価値が低い。
 *
 * Apple TV+ を入れていないのは、removed が月2〜3件しかなく記事にならないため。
 * 件数が増えたらここに 'apple-tv' を足せばよい（他の変更は不要）。
 */
const TARGET_SERVICES = ['disney-plus'] as const

/**
 * 1記事に載せる上限。
 * 構成3「全終了作品リストは漏れなく全件」が原則なので、
 * 通常の月がまるごと収まる数にしておく（Disney+ は月70〜80件）。
 */
const MAX_ITEMS = 80

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'ended-lead-first-sentence',
  'ended-lead-closer',
  'other-services-intro',
  'attribution',
] as const

/**
 * 段落を「次の一手を示す形」で締めているとみなす語尾。
 * templates/ended.md の締めルールに対応する。
 */
const NEXT_STEP = /(探せます|探してみましょう|探すことができます|確認できます|確認してみましょう|ご確認ください|見つかる場合があります)[。]?$/

/**
 * **この記事タイプの生命線。**
 *
 * もう観られない作品を「まだ観られる」と読ませる表現。
 * 1つでもあれば公開を止める。読者を直接裏切る誤情報であり、
 * 文体の好みの問題ではないため warn ではなく error にしている。
 */
const MISLEADING = [
  'お見逃しなく',
  'お見逃しがないように',
  '見逃せません',
  '今のうちに',
  'まだ間に合',
  '観ておきましょう',
  '見ておきましょう',
  'チェックしておきましょう',
  '配信中です',
  '視聴できます',
  '観られます',
] as const

export const endedArticle: ArticleType = {
  id: 'ended',
  category: 'ended',
  description: '今月見放題が終了した作品（配信終了予定を取得できないサービス）',

  select(events, _ledger: Ledger, ctx) {
    const target = events
      .filter((e) => e.kind === 'removed')
      .filter((e) => (TARGET_SERVICES as readonly string[]).includes(e.service))
      // 終了日が不明なものは記事にできない
      .filter((e) => e.at)
      // 対象月に終了したものだけ。判定はサイトの基準タイムゾーンで行う。
      .filter((e) => isTargetMonth(e.at!, ctx))
      // ★ まだ終了日が来ていないものを除く。
      //   removed は終了済みのはずだが、データが先行することがある。
      //   混ざると「終了しました」と過去形で書いた作品がまだ観られる状態になり、
      //   leaving（終了予定）で扱うべきものを取りこぼす。
      .filter((e) => Date.parse(e.at!) <= ctx.now.getTime())

    // 上限を超えるときは評価の高い順で残す。
    // 日付順で切ると月の後半がまるごと落ち、
    // 「月後半は何も終わらなかった」と読める記事になってしまう。
    const kept =
      target.length <= MAX_ITEMS
        ? target
        : [...target].sort((a, b) => (b.work.rating ?? 0) - (a.work.rating ?? 0)).slice(0, MAX_ITEMS)

    // 記事は終了日順に書くので、最後に日付で並べ直す
    return kept.sort((a, b) => a.at!.localeCompare(b.at!))
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'ended.md'), 'utf8')
    const labelOf = serviceLabels(ctx)
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
        e.work.rating ? `  評価: ${e.work.rating}/100（★表にだけ書き、地の文には書かないこと）` : '',
        e.work.genres.length ? `  ジャンル: ${e.work.genres.join(' / ')}` : '',
        productionCompanies(e.work)?.length
          ? `  制作: ${productionCompanies(e.work)!.join(' / ')}`
          : '',
        e.work.overview ? `  あらすじ(英語原文): ${e.work.overview}` : '',
        links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    const resolved = resolvePhrases(items, ctx)

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

${OUTPUT_FORMAT}`

    const prompt = `以下は今月見放題配信が終了した作品のデータです。全${items.length}件。
**これらはすでに配信が終了しており、対象サービスでは観られません。**

${rows.join('\n\n')}

---

このデータから記事を書いてください。

特に重要な作業:
1. **もう観られない作品であることを、絶対に取り違えないこと。**
   「お見逃しなく」「今のうちに」「観ておきましょう」「配信中です」は使用禁止です。
   終了は必ず過去形（「終了しました」）で書いてください。
2. 終了日を見比べて「同じ日に終了したまとまり」を探すこと。
   同一シリーズ・同一監督・同一ジャンルの集中があれば、それを記事の軸にする。
3. リードの2段落目では、知名度の高い作品を**終了日順に**、
   作品名・シリーズ名を「」で囲んで挙げること。記事の構造の説明は書かない。
4. **各セクションは「見出し → 表 → 解説」の順に書くこと。**
   見出しの直後に導入文を挟まず、いきなり表を置きます。
   表の列は「終了日 / 作品 / 評価 / サービス」の4列で固定してください。
5. まとまりを解説する \`##\` セクションは、**見出しに具体的な作品名を入れ**、
   **最終段落を「〜で探せます」「〜から確認できます」など次の一手を示す形で締める**こと。
6. **「他のサービスで探す」の節がこの記事の中心です。** 短縮せず、
   主要な作品について検索リンクを並べてください。
   ただし U-NEXT・Hulu・DMM TV について「配信中」と断定してはいけません。
   当サイトはこれらの配信状況データを持っていません。
7. **評価スコアは表にだけ書き、地の文には一切書かないこと。**
8. あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
9. 「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。
10. 記号は全角に統一してください（！ ？ （） を半角で書かない）。
    ただし作品名に含まれる半角記号は正式表記なのでそのまま使ってください。`

    return { system, prompt }
  },

  tags(items, ctx) {
    const labelOf = serviceLabels(ctx)
    const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
    const [y, m] = ctx.targetMonth.split('-')
    return [...services, '配信終了済み', `${y}年${Number(m)}月`]
  },

  slug(ctx) {
    return `${ctx.targetMonth}-ended`
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)

    const issues: VerifyIssue[] = []
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const resolved = resolvePhrases(items, ctx)

    // --- この記事タイプ固有の最重要検査（公開を止める） ---

    // 「まだ観られる」と誤解させる表現。読者を直接裏切るため error。
    for (const phrase of MISLEADING) {
      if (md.includes(phrase)) {
        err(
          `「${phrase}」が含まれています。この記事の作品は既に配信終了しており、` +
            '読者は観ることができません。「他のサービスで探せます」の形に書き換えてください。',
        )
      }
    }
    // 終了を未来形で書いていないか
    if (/終了します|終了予定です/.test(md)) {
      err('終了を未来形で書いています。この記事は終了済みの作品を扱うので「終了しました」と書きます。')
    }

    // --- 事故を防ぐ検査（公開を止める） ---

    if (!md.includes('|')) {
      err('全終了作品の一覧表がありません。テンプレートの構成3が守られていません。')
    }
    // この記事では検索リンクが唯一の実用情報なので、欠けたら記事の意味が無い
    if (!/U-NEXT|Hulu|DMM/.test(md)) {
      err('他サービスでの検索リンクがありません。この記事で読者に渡せる唯一の情報です（構成4）。')
    }
    if (/U-NEXTで配信中|Huluで配信中|DMM TVで配信中/.test(md)) {
      err('対象外サービスについて「配信中」と断定しています。配信状況のデータを持っていないため書けません。')
    }
    const asOf = md.match(/[（(](\d{1,2}月\d{1,2}日)時点[）)]/)
    if (!asOf) {
      err(`リードに「（${resolved.asOf}時点）」がありません。いつ時点の情報かを必ず示します。`)
    } else if (asOf[1] !== resolved.asOf) {
      err(`基準日が記事作成日と違います。本文「${asOf[1]}時点」／記事作成日「${resolved.asOf}」。`)
    }

    // --- 固定文言の検査（公開を止める） ---

    if (!md.startsWith(resolved.leadPrefix)) {
      err(
        `本文の冒頭が「${resolved.leadPrefix}」で始まっていません。` +
          '配信終了予定の記事と一覧上で見分けがつかなくなるため、この型は固定です。',
      )
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

    for (const line of ratingMentionsInProse(md)) {
      warn(`地の文で評価に言及しています: 「${clip(line, 50)}」（評価は表にだけ載せます）`)
    }

    for (const section of dateSections(md)) {
      if (!section.startsWithTable) {
        warn(`「${section.heading}」の見出し直後が表になっていません（見出し → 表 → 解説の順）。`)
      }
      const last = section.lastParagraph
      if (last && !NEXT_STEP.test(last)) {
        warn(
          `「${section.heading}」の最後が次の一手を示す形で終わっていません: 「${clip(last)}」` +
            '（「〜で探せます」「〜から確認できます」など）',
        )
      }
    }

    const halfWidth = halfWidthSymbols(md, itemTitles(items))
    if (halfWidth.length) {
      warn(`半角記号が混ざっています: ${halfWidth.join(' ')} → 全角（！ ？ （ ））に統一してください。`)
    }

    return issues
  },
}

// --- 固定文言 -------------------------------------------------------------

interface ResolvedPhrases {
  /** 【8月終了済み】 */
  leadPrefix: string
  leadFirstSentence: string
  leadCloser: string
  otherServicesIntro: string
  attribution: string
  /** 記事作成日。「8月9日」形式 */
  asOf: string
}

/** 固定文言に今月の値を差し込む。プロンプトと検査で同じ結果になることが要件。 */
function resolvePhrases(items: ChangeEvent[], ctx: ArticleContext): ResolvedPhrases {
  const vars = {
    月: articleMonth(ctx),
    サービス: serviceNames(items, ctx),
    基準日: asOfLabel(ctx),
    本数: items.length,
  }
  const get = phraseReader(fixedPhrases(ctx, REQUIRED_PHRASES), vars)

  return {
    leadPrefix: `【${vars.月}月終了済み】`,
    leadFirstSentence: get('ended-lead-first-sentence'),
    leadCloser: get('ended-lead-closer'),
    otherServicesIntro: get('other-services-intro'),
    attribution: get('attribution'),
    asOf: vars.基準日,
  }
}
