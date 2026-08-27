/**
 * 記事タイプ: 見放題配信開始（サービス別・月内更新）
 *
 * 1つのサービスについて「その月に見放題入りした作品」を**1本のURLで追い続ける**。
 * 月内に何度も同じスラッグを書き直し、そのたびに
 * 「前回の版以降に増えたぶん」を記事の先頭で見せる。
 *
 * ■ ジャンル別（arrivals.ts）と役割が重ならない理由
 * ジャンル別は `classify()` が原語を判定できた作品しか載せず、
 * さらに1記事60件の上限がある。実測では Prime Video の8月分167件のうち
 * **90件がどのジャンル別記事にも載っていなかった。**
 * サービス別ならジャンル判定が要らないので、その月の全件を1本で網羅できる。
 *
 * ■ 文章の型は2つのファイルに分かれている
 *   templates/arrivals-service.md   構成と文体のルール
 *   templates/fixed-phrases.md      毎月そのまま使う文言（arrivals-service- で始まるキー）
 *
 * ■ この記事タイプ固有の難所は「前回との差分」
 * `配信開始日`（実際に見放題になった日）と `把握した日`（収集した日）はずれる。
 * 取りこぼしを後から拾うと、**古い作品が今回の素材に現れる。**
 * それを「新たに追加」と書けば誤情報なので、
 * 素材の段階で1件ずつラベルを振り、LLM に日付の突き合わせをさせない。
 */
import { readFileSync } from 'node:fs'
import { OUTPUT_FORMAT, type ArticleContext, type ArticleType } from '../../../pipeline/core/article.ts'
import { buildSearchLinks } from '../../../pipeline/core/search-links.ts'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { VerifyIssue } from '../../../pipeline/core/verify.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'
import { castNames, directorNames, productionCompanies } from '../work-context.ts'
import {
  articleMonth,
  asOfLabel,
  clip,
  dateSections,
  fixedPhrases,
  freshnessNote,
  freshnessOf,
  halfWidthSymbols,
  isTargetMonth,
  itemTitles,
  namingRules,
  normalizeBody,
  peopleLine,
  phraseReader,
  publishable,
  previousAsOf,
  ratingMentionsInProse,
  serviceLabels,
  shortScriptSection,
  titleIssues,
  variantKey,
  type Freshness,
} from './shared.ts'

/**
 * 記事を作るサービス。
 *
 * ★ `leaving.ts` の SERVICE_VARIANTS と揃えること。**入口と出口で対象が違うと、
 *   読者は「終了記事はあるのに開始記事が無い」サービスに出くわす。**
 *
 * Disney+（8月14件）と Apple TV+（同5件）を入れていないのは、
 * 1本の記事にするには薄すぎるため。件数が増えたらここに足す。
 */
const SERVICE_VARIANTS = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'u-next', label: 'U-NEXT' },
] as const

/**
 * 記事として成立する最低件数。下回ったら `--list` が「素材不足」と出す。
 * **生成を機械的に止めはしない**（少ない月でも出す判断はありうる）。
 */
const MIN_ITEMS = 20

/**
 * 解説用に**詳しい素材**を渡す作品数の上限。
 *
 * 全作品リストには全件を載せるが（下の `COMPACT` 行で渡す）、
 * あらすじ・制作会社・出演者まで付けるのはこの数まで。
 * 167件ぶんの詳細をすべて渡すと、記事に使われない情報でプロンプトが膨らむ。
 * テンプレートが「解説するのは12〜15作品まで」と決めているので、
 * 候補としてはこの数で足りる。
 */
const MAX_DETAILED = 40

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'arrivals-service-lead-first-sentence',
  'arrivals-service-update-lead-first-sentence',
  'arrivals-lead-closer',
  'arrivals-upcoming-intro',
  'other-services-intro',
  'attribution',
  // ★ 配信開始記事なので `attribution-unext`（終了日の文言）ではない
  'attribution-unext-arrivals',
  'short-closer',
] as const

/** U-NEXT は自前収集なので、素材の性質も出典表記も API 由来と違う */
function isUnext(service: string | undefined): boolean {
  return service === 'u-next'
}

// --- 検査に使う言い回し ---------------------------------------------------

/** 配信終了記事の急かし文句。開始記事では不自然になる（arrivals.ts と同じ） */
const URGING = /(ぜひ観ましょう|見逃せません|お見逃しなく|お見逃しがないように|今のうちに観)/

/** 編集部が観る順番や選定を押し付けている表現（arrivals.ts と同じ） */
const RECOMMENDING =
  /(この日(?:から)?観るなら|まず1本選ぶなら|はじめて観るなら|から入って|順番が観やすい|のが分かりやすいです|向いています)/

/** です・ます調で終わっているか。体言止め・尻すぼみの検出用 */
const PROPER_ENDING = /(です|ます|ました|ません|でした|でしょう)[。！]?$/

// --- 固定文言 -------------------------------------------------------------

interface ResolvedPhrases {
  leadFirstSentence: string
  leadCloser: string
  upcomingIntro: string
  otherServicesIntro: string
  attribution: string
  shortCloser: string
  asOf: string
}

function resolvePhrases(
  items: ChangeEvent[],
  ctx: ArticleContext,
  addedCount: number,
  isUpdate: boolean,
): ResolvedPhrases {
  const phrases = fixedPhrases(ctx, REQUIRED_PHRASES)
  const label = ctx.variant?.label ?? (serviceLabels(ctx).get(ctx.variant?.key ?? '') ?? '')
  const asOf = asOfLabel(ctx)
  const read = phraseReader(phrases, {
    月: articleMonth(ctx),
    サービス: label,
    基準日: asOf,
    本数: items.length,
    追加本数: addedCount,
  })

  return {
    leadFirstSentence: read(
      isUpdate
        ? 'arrivals-service-update-lead-first-sentence'
        : 'arrivals-service-lead-first-sentence',
    ),
    leadCloser: read('arrivals-lead-closer'),
    upcomingIntro: read('arrivals-upcoming-intro'),
    otherServicesIntro: read('other-services-intro'),
    attribution: read(isUnext(ctx.variant?.key) ? 'attribution-unext-arrivals' : 'attribution'),
    shortCloser: read('short-closer'),
    asOf,
  }
}

// --- 素材の書き方 ---------------------------------------------------------

/** 解説用の1作品ぶん（詳しい版） */
function detailedRow(e: ChangeEvent, ctx: ArticleContext, freshness: Freshness): string {
  const w = e.work
  const unext = isUnext(ctx.variant?.key)
  // 「他のサービスで探す」に自分自身を並べても意味がない
  const otherLinks = (ctx.theme.search_links ?? []).filter((l) => l.key !== ctx.variant?.key)
  const links = buildSearchLinks(w, otherLinks)
  const title = w.localizedTitle ?? w.title
  const note = unext
    ? ''
    : w.localizedTitle
      ? `（原題: ${w.title}）`
      : '（★邦題が未確認。この原題のまま書くこと）'
  const offset = ctx.theme.utc_offset_minutes

  return [
    `- ${title}${note ? ` ${note}` : ''}`,
    `  配信開始日: ${e.at ? formatMonthDay(e.at, offset) : '★未定（日付を書かないこと）'}`,
    // ★ ここが誤情報を止める要。LLM に日付を突き合わせさせない。
    freshnessNote(freshness),
    w.year ? `  公開年: ${w.year}年` : '',
    w.rating ? `  評価: ${w.rating}/100（★表にだけ書き、地の文には書かないこと）` : '',
    w.genres.length ? `  ジャンル: ${w.genres.join(' / ')}` : '',
    productionCompanies(w)?.length ? `  制作: ${productionCompanies(w)!.join(' / ')}` : '',
    // ★ 日本語で取れたものだけ渡す。取れなければ行ごと出ない（shared.ts の peopleLine）
    peopleLine('監督', directorNames(w)),
    peopleLine('出演', castNames(w), true),
    unext
      ? '  あらすじ: ★未提供（内容を推測して書かないこと）'
      : w.overview && w.overview.length > 10
        ? `  あらすじ(英語原文): ${w.overview}`
        : '  あらすじ: ★未提供（内容を推測して書かないこと）',
    links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 全作品リスト用の1行（簡易版）。
 * 表に必要な4項目だけ。**解説には使わない**ので、あらすじも制作も渡さない。
 */
function compactRow(e: ChangeEvent, ctx: ArticleContext): string {
  const w = e.work
  const title = w.localizedTitle ?? w.title
  const date = e.at ? formatMonthDay(e.at, ctx.theme.utc_offset_minutes) : '日付未定'
  const rating = w.rating ? `${w.rating}/100` : '—'
  return `- ${date} ／ ${title} ／ ${rating}`
}

// --- 記事タイプ -----------------------------------------------------------

export const arrivalsServiceArticle: ArticleType = {
  id: 'arrivals-service',
  category: 'arrivals',
  axis: 'service',
  description: '今月見放題配信が始まった作品（サービス別・月内更新）',
  variants: SERVICE_VARIANTS,
  variantFlag: 'service',
  variantNoun: 'サービス',
  minItems: MIN_ITEMS,

  select(rawEvents, _ledger: Ledger, ctx) {
    const service = ctx.variant?.key
    if (!service) return []

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    const events = publishable(rawEvents)

    const started = events
      .filter((e) => e.kind === 'new')
      .filter((e) => e.service === service)
      // 配信開始日が不明なものは時系列に並べられないので記事にしない
      .filter((e) => e.at)
      .filter((e) => isTargetMonth(e.at!, ctx))

    // ★ 同じ作品が複数回収集されている。**最初に把握した回**を残す。
    //   最後の回を採ると、毎回すべての作品が「今回の追加分」になってしまう。
    const firstSeen = new Map<string, ChangeEvent>()
    for (const e of started) {
      const key = String(e.work.id)
      const cur = firstSeen.get(key)
      if (!cur || e.collectedAt < cur.collectedAt) firstSeen.set(key, e)
    }

    // ★ 上限で切らない。全作品リストに全件載せるのがこの記事タイプの役目。
    //   プロンプトが膨らむ問題は buildPrompt 側で「詳しい素材」を絞って解く。
    return [...firstSeen.values()].sort((a, b) => a.at!.localeCompare(b.at!))
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'arrivals-service.md'), 'utf8')
    const since = previousAsOf(this.slug(ctx))
    const isUpdate = since !== undefined

    const marked = items.map((e) => ({ e, freshness: freshnessOf(e, since) }))
    const added = marked.filter((m) => m.freshness !== 'known')
    const known = marked.filter((m) => m.freshness === 'known')

    /*
     * 解説用の詳しい素材。
     *   1. 今回の追加分は**全件**（記事の主役なので落とさない）
     *   2. 残りは評価の高い順に、上限まで
     * 評価順にするのは、知名度の代理として使える唯一の機械的な指標だから。
     * 最終的にどれを解説するかはテンプレートの基準（知名度）で選ばせる。
     */
    const filler = [...known]
      .sort((a, b) => (b.e.work.rating ?? 0) - (a.e.work.rating ?? 0))
      .slice(0, Math.max(0, MAX_DETAILED - added.length))
    const detailed = [...added, ...filler].sort((a, b) => a.e.at!.localeCompare(b.e.at!))

    const resolved = resolvePhrases(items, ctx, added.length, isUpdate)
    const label = ctx.variant?.label ?? ''
    const unext = isUnext(ctx.variant?.key)

    const system = `あなたは動画配信サービスの情報を扱う日本語ブログの編集者です。
与えられたデータだけを使って記事を書きます。データに無い事実を書いてはいけません。

${template}

---

${namingRules(ctx)}

---

# 今回の版

**この記事は「${isUpdate ? '更新回' : '初回'}」です。**

${
  isUpdate
    ? `前回の版は ${since!.toISOString().slice(0, 10)} 時点のものです。
今回新たに載る作品が **${added.length}件** あります。
テンプレートの「更新回」の指示に従い、**「今回追加された作品」の節を必ず作ってください。**
タイトルは **【${ctx.targetMonth.split('-')[0]}年${articleMonth(ctx)}月】で始め**、本数の直後に 【${resolved.asOf}更新】 を置いてください。
**先頭を 【${resolved.asOf}更新】 にしないこと。**`
    : `この記事は今月・${label} で**はじめて書く版**です。
**「今回追加された作品」の節は作らないでください。**
タイトルに「更新」と書いてはいけません。前の版が無いので嘘になります。
テンプレートの「初回」の指示に従ってください。`
}

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

    const tasks = [
      isUpdate
        ? `**「今回追加された作品」の節を最初に置くこと。** 対象は ★今回の追加分 と付いた${added.length}件。
   「★今回の追加分（配信開始は前回より前…）」と付いた作品を
   **「新たに配信が始まった」と書いてはいけません。** 素材のラベルに従ってください。`
        : `今月の主要な作品から、まとまり（新作起点 → 制作会社起点 → シリーズ起点 → 配信開始日）を探して節を作ること。`,
      `**各セクションは「見出し → 表 → 解説」の順に書くこと。**
   見出しの直後に導入文を挟まず、いきなり表を置きます。
   表の列は「配信開始日 / 作品 / 評価 / サービス」の4列で固定してください。
   1サービスの記事ですが、**サービス列を省かないでください**（サイトが行のサービス名を読んでリンクを付けます）。`,
      `**全作品リストの節には、下の「全作品リスト用のデータ」${items.length}件を1件残らず表に載せること。**
   解説で触れなかった作品も必ず表に出します。間引いてはいけません。`,
      `**評価スコアは表にだけ書き、地の文には一切書かないこと。**`,
      `解説するのは12〜15作品までにしてください。全作品に1文ずつ付けないこと。`,
      unext
        ? `**あらすじは素材にありません。作品の内容を創作しないでください。**
   与えられた事実（配信開始日・公開年・ジャンル）と、作品名から読者が判断できることだけで書きます。`
        : `あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
   「★未提供」と書かれた作品の内容を推測してはいけません。`,
      unext
        ? `作品名は与えられたものをそのまま使ってください。原題や英題を併記しないこと。`
        : `「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。`,
      `**人名は素材に出ているものだけを書いてください。**
   素材の人名は日本語表記です。人名の行が無い作品は、人名に触れずに書きます。
   あらすじの英文に人名が出てきても、**地の文に写さないでください**（ローマ字が記事に残ります）。`,
      `**急かさないこと。** 配信開始記事には締切がありません。
   「ぜひ観ましょう」「見逃せません」は書かない。編集部のおすすめも書かない。`,
      `サービス名は記事を通して「${label}」で統一してください。略称に言い換えないこと。`,
      `記号は全角に統一してください（！ ？ （） を半角で書かない）。
   ただし作品名に含まれる半角記号は正式表記なのでそのまま使ってください。`,
    ]

    const prompt = `${label} で${articleMonth(ctx)}月に見放題配信が始まった作品のデータです。全${items.length}件。

## 解説に使う素材（${detailed.length}件・詳しい情報つき）

${detailed.map((m) => detailedRow(m.e, ctx, m.freshness)).join('\n\n')}

---

## 全作品リスト用のデータ（${items.length}件・配信開始日順）

**この${items.length}件すべてを「全作品リスト」の表に載せてください。**
形式は「配信開始日 ／ 作品名 ／ 評価」です。表にするときはサービス列（${label}）を足してください。

${items.map((e) => compactRow(e, ctx)).join('\n')}

---

このデータから記事を書いてください。

特に重要な作業:
${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`

    return { system, prompt }
  },

  /**
   * ショート動画の台本。
   *
   * 更新回は「今回増えたぶん」が30秒の軸になるので、台本と相性がよい。
   * 初回は月の主要作を並べる形になる。
   */
  buildShortPrompt(items, ctx) {
    const since = previousAsOf(this.slug(ctx))
    const added = items.filter((e) => freshnessOf(e, since) !== 'known')
    const resolved = resolvePhrases(items, ctx, added.length, since !== undefined)
    const label = ctx.variant?.label ?? ''

    return shortScriptSection(ctx, {
      dateLabel: '配信開始日',
      titlesAreLocalized: isUnext(ctx.variant?.key),
      // 更新回は今回の追加分を優先。無ければ月の全件から選ぶ
      candidates: added.length >= 4 ? added : items,
      closer: resolved.shortCloser,
      extraRules: [
        `**${label} の1サービスの話に徹する。** 他サービスと比較しない。`,
        added.length >= 4
          ? `今回新しく加わった${added.length}本が軸。「${articleMonth(ctx)}月に入って追加された」と伝える。`
          : `${articleMonth(ctx)}月に見放題入りした作品を並べる。締切が無いので急かさない。`,
      ],
    })
  },

  tags(items, ctx) {
    const label = ctx.variant?.label ?? ''
    const [y, m] = ctx.targetMonth.split('-')
    return [label, '配信開始', `${y}年${Number(m)}月`].filter(Boolean)
  },

  slug(ctx) {
    return `${ctx.targetMonth}-arrivals-${variantKey(ctx, this.id)}`
  },

  verifyTitle(title, ctx) {
    return titleIssues(title, ctx, {
      axis: 'service',
      verbPhrase: '見放題配信が始まった',
      isUpdate: previousAsOf(this.slug(ctx)) !== undefined,
    })
  },

  verify(md, items, ctx) {
    const issues: VerifyIssue[] = []
    const body = normalizeBody(md)
    const since = previousAsOf(this.slug(ctx))
    const isUpdate = since !== undefined
    const added = items.filter((e) => freshnessOf(e, since) !== 'known')
    const resolved = resolvePhrases(items, ctx, added.length, isUpdate)

    // --- 固定文言 ---
    for (const [name, text] of [
      ['リードの1文目', resolved.leadFirstSentence],
      ['リードの締め', resolved.leadCloser],
      ['他のサービスで探すの冒頭', resolved.otherServicesIntro],
      ['末尾の出典表記', resolved.attribution],
    ] as const) {
      if (text && !body.includes(text)) {
        issues.push({ level: 'error', message: `固定文言（${name}）がそのまま入っていません。` })
      }
    }

    // --- 版の取り違え ---
    // ★ 初回に「更新」と書くと、前の版が無いのに更新したと読める。読者に対する嘘。
    if (!isUpdate && /【[^】]*更新[^】]*】/.test(body)) {
      issues.push({
        level: 'error',
        message: '初回の版なのにタイトルまたは本文が「更新」を名乗っています。前の版がありません。',
      })
    }
    if (isUpdate && !/今回|新た/.test(body.slice(0, 400))) {
      issues.push({
        level: 'warn',
        message: '更新回ですが、冒頭に今回の追加分の話が出てきません。',
      })
    }

    // --- 全作品リストの網羅（この記事タイプの中心的な約束） ---
    const missing = items
      .map((e) => e.work.localizedTitle ?? e.work.title)
      .filter((t) => t && !body.includes(t))
    if (missing.length > 0) {
      issues.push({
        level: 'error',
        message:
          `全作品リストに載っていない作品が${missing.length}件あります（表からは1本も落とさない）: ` +
          missing.slice(0, 8).map((t) => clip(t, 24)).join(' / ') +
          (missing.length > 8 ? ' ほか' : ''),
      })
    }

    // --- 今回の追加分が本文に出ているか ---
    if (isUpdate) {
      const notShown = added
        .map((e) => e.work.localizedTitle ?? e.work.title)
        .filter((t) => t && !body.includes(t))
      if (notShown.length > 0) {
        issues.push({
          level: 'error',
          message: `今回の追加分が本文にありません: ${notShown.map((t) => clip(t, 24)).join(' / ')}`,
        })
      }
    }

    // --- 文体（arrivals.ts と同じ方針） ---
    if (URGING.test(body)) {
      issues.push({
        level: 'warn',
        message: '配信開始記事に急かし文句があります（締切が無いので不自然です）。',
      })
    }
    if (RECOMMENDING.test(body)) {
      issues.push({ level: 'warn', message: '観る順番や選定を押し付ける表現があります。' })
    }
    for (const line of ratingMentionsInProse(body)) {
      issues.push({ level: 'warn', message: `地の文に評価スコアが出ています: ${clip(line)}` })
    }
    const symbols = halfWidthSymbols(body, itemTitles(items))
    if (symbols.length > 0) {
      issues.push({
        level: 'warn',
        message: `半角記号が地の文にあります（全角に統一）: ${symbols.join(' ')}`,
      })
    }
    for (const s of dateSections(body)) {
      if (!s.startsWithTable) {
        issues.push({
          level: 'warn',
          message: `見出しの直後が表になっていません: ${clip(s.heading)}`,
        })
      }
      if (s.lastParagraph && !PROPER_ENDING.test(s.lastParagraph)) {
        issues.push({
          level: 'warn',
          message: `節の締めが体言止め・尻すぼみです: ${clip(s.lastParagraph)}`,
        })
      }
    }

    return issues
  },
}
