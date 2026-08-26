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
  publishable,
  ratingMentionsInProse,
  serviceLabels,
  serviceNames,
  shortScriptSection,
} from './shared.ts'

/**
 * 1記事に載せる上限。
 *
 * 構成4「全終了作品リストは漏れなく全件」が原則なので、
 * 通常の月がまるごと収まる数にしておく。青天井にしないのは、
 * 極端に多い月に本文が薄くなり max_tokens も圧迫するため。
 */
const MAX_ITEMS = 80

/**
 * サービス別に1本ずつ書く。
 *
 * ■ なぜサービス別なのか（2026-08-23 の実測で決めた）
 * 最初はジャンル別（アニメ / 洋画 / 邦画）を検討したが、**成立しなかった**。
 * 配信終了は洋画ライブラリの入れ替えが主因で、邦画が慢性的に枯れる。
 *
 *     leaving 9月  合計65件 → アニメ 6 / 洋画 47 / 邦画  3
 *     leaving 8月  合計147件 → アニメ41 / 洋画 78 / 邦画 11
 *
 * 邦画は3か月分すべてで記事にならない件数だった。
 * 一方サービス別なら 9月= Netflix 35 / Prime Video 30 で両方成立する。
 *
 * さらにサービス軸は**検索需要と一致する**。Googleサジェストの実測では
 * 「配信終了予定␣」の候補10件が10件ともサービス名だった
 * （netflix / アマプラ / プライムビデオ / u-next / …）。ジャンル名は出てこない。
 * ジャンル分類は原語不明で判定できない作品が月9〜17件出て捨てられるが、
 * サービスは100%確実に分かる、という副次的な利点もある。
 *
 * ■ ここに Disney+ / Apple TV+ が無い理由
 * 実測（2026-08・1,089件）で expiring を返したのは Netflix と Prime Video だけ。
 * 残り2社は0件だった（theme.yaml の catalogs 節に計測値がある）。
 * 返し始めたらここに足す。**ラベルは theme.yaml の catalogs と揃えること。**
 *
 * ■ U-NEXT（2026-08-25 追加）
 * このAPIのカタログには無いが、自前で収集している（docs/UNEXT.md）。
 * 素材の性質が Netflix / Prime Video と違うので、書き分けは SOURCE_TRAITS に寄せてある。
 */
const SERVICE_VARIANTS = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'u-next', label: 'U-NEXT' },
] as const

/**
 * サービスごとの素材の性質。**記事の書き分けはここだけを見る。**
 *
 * 記事タイプを増やさずに U-NEXT を足せたのは、違いが「構成」ではなく
 * 「素材に何が入っているか」だけだったため。差分を条件分岐として本文中に
 * 散らすと、サービスが増えるたびに読めなくなるので表にまとめている。
 */
interface SourceTraits {
  /** タイトルが最初から邦題か。false なら原題を併記し、推測を禁じる注記を出す */
  localizedTitles: boolean
  /** あらすじを素材として持っているか */
  hasOverview: boolean
  /**
   * 見放題とポイント（レンタル・購入）の区別を素材が持っているか。
   * true のサービスは「見放題が終わる」だけで「観られなくなる」とは限らない。
   */
  hasLineup: boolean
  /** 記事末尾の出典表記に使う固定文言のキー */
  attributionKey: string
}

/** Streaming Availability API から取っているサービス */
const API_TRAITS: SourceTraits = {
  localizedTitles: false,
  hasOverview: true,
  hasLineup: false,
  attributionKey: 'attribution',
}

/** 自前で収集しているサービス（docs/UNEXT.md） */
const UNEXT_TRAITS: SourceTraits = {
  // U-NEXT は最初から邦題を返すので Wikidata による解決が要らない
  localizedTitles: true,
  // あらすじは著作物なので収集していない（docs/UNEXT.md 4節）
  hasOverview: false,
  hasLineup: true,
  attributionKey: 'attribution-unext',
}

const TRAITS: Record<string, SourceTraits> = {
  netflix: API_TRAITS,
  'prime-video': API_TRAITS,
  'u-next': UNEXT_TRAITS,
}

function traitsOf(service: string | undefined): SourceTraits {
  return (service && TRAITS[service]) || API_TRAITS
}

/**
 * 記事として成立する最低件数。
 *
 * 月によって入れ替え数は大きく振れる（Prime Video は 8月20件 / 9月30件）。
 * 少なすぎる月に無理に1本立てると、表がスカスカの記事が公開される。
 * 下回ったときは `--list` が「素材不足」と出すので、その月はそのサービスを飛ばす。
 * **自動で総合記事に統合したりはしない**。どちらを出すかは運用者が決める。
 */
const MIN_ITEMS = 15

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'leaving-lead-first-sentence',
  'leaving-lead-closer',
  'other-services-intro',
  'attribution',
  // U-NEXT の記事に API の帰属表示を付けると出典を偽ることになるため別文言
  'attribution-unext',
  // ショート動画の締め（記事と同時に作る台本で使う）
  'short-closer',
] as const

/**
 * ポイント（レンタル）で残る可能性がある作品を「もう観られない」と読ませる表現。
 *
 * **U-NEXT のように見放題とポイントが同居するサービスでだけ効かせる。**
 * Netflix / Prime Video の見放題終了はサービスからの退出そのものなので、
 * 同じ言い回しでも誤りにならない。ここを一律にすると、正しい記述まで止まる。
 */
const UNAVAILABLE_CLAIM = [
  '観られなくなり',
  '観られなくなる',
  '見られなくなり',
  '見られなくなる',
  '視聴できなくなり',
  '視聴できなくなる',
  '観ることができなくなり',
  '観ることができなくなる',
] as const

/**
 * 「配信終了」と、修飾なしで書いている行。
 *
 * ★ ここに「配信が終了します」を足してはいけない。
 *   正しい書き方である**「見放題配信が終了します」もその文字列を含む**ので、
 *   単純な部分一致では区別できず、正しい記述まで error で止まる。
 *   行に「見放題」があるかどうかで見る。
 */
function bareDeliveryEnd(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|'))
    .filter((l) => /配信(が)?終了/.test(l) && !l.includes('見放題'))
}

/**
 * 段落を「視聴を促す形」で締めているとみなす語尾。
 * テンプレート構成2の締めルール（`templates/leaving.md`）に対応する。
 */
const CALL_TO_ACTION = /(ましょう|ください|見逃せません|お見逃しなく|お見逃しがないように|おすすめです)[。！]?$/

export const leavingArticle: ArticleType = {
  id: 'leaving',
  category: 'leaving',
  description: '今月見放題が終了する作品（サービス別）',
  variants: SERVICE_VARIANTS,
  variantFlag: 'service',
  variantNoun: 'サービス',
  minItems: MIN_ITEMS,

  select(rawEvents, _ledger: Ledger, ctx) {
    const service = ctx.variant?.key
    if (!service) return []
    const traits = traitsOf(service)

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    const events = publishable(rawEvents)

    const target = events
      .filter((e) => e.kind === 'expiring')
      .filter((e) => e.service === service)
      // 終了日が不明なものは記事にできない
      .filter((e) => e.at)
      // ★ 見放題とポイントが同居するサービス（U-NEXT）では、
      //   ポイント専用作品が同じ一覧に混ざる。それを載せると
      //   **そもそも見放題ではなかった作品を「見放題が終わる」と書く**ことになる。
      //   svod（見放題のみ）と both（見放題＋ポイント）だけを残す。
      .filter((e) => {
        if (!traits.hasLineup) return true
        const lineup = e.work.meta.lineup
        return lineup === 'svod' || lineup === 'both'
      })
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
    const labelOf = serviceLabels(ctx)
    const offset = ctx.theme.utc_offset_minutes
    const traits = traitsOf(ctx.variant?.key)
    // 「他のサービスで探す」に自分自身を並べても意味がない
    const otherLinks = (ctx.theme.search_links ?? []).filter((l) => l.key !== ctx.variant?.key)

    const rows = items.map((e) => {
      const links = buildSearchLinks(e.work, otherLinks)
      const title = e.work.localizedTitle ?? e.work.title
      const note = traits.localizedTitles
        ? ''
        : e.work.localizedTitle
          ? `（原題: ${e.work.title}）`
          : '（★邦題が未確認。この原題のまま書くこと）'
      const episodes = e.work.meta.episodeCount
      const series = e.work.meta.seriesName

      return [
        `- ${title}${note ? ` ${note}` : ''}`,
        `  サービス: ${labelOf.get(e.service) ?? e.service}`,
        `  終了日: ${formatMonthDay(e.at!, offset)}`,
        e.work.year ? `  公開年: ${e.work.year}年` : '',
        e.work.rating ? `  評価: ${e.work.rating}/100（★表にだけ書き、地の文には書かないこと）` : '',
        e.work.genres.length ? `  ジャンル: ${e.work.genres.join(' / ')}` : '',
        e.work.type === 'series' && typeof episodes === 'number' && episodes > 1
          ? `  全${episodes}話のシリーズ`
          : '',
        typeof series === 'string' && series && series !== title ? `  シリーズ名: ${series}` : '',
        // ★ 見放題は終わるがレンタルでは残る作品。「観られなくなる」と書けない
        traits.hasLineup && e.work.meta.lineup === 'both'
          ? '  ★見放題は終了するが、ポイント（レンタル・購入）での取り扱いは続く'
          : '',
        productionCompanies(e.work)?.length
          ? `  制作: ${productionCompanies(e.work)!.join(' / ')}`
          : '',
        e.work.overview ? `  あらすじ(英語原文): ${e.work.overview}` : '',
        links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    // 差し込み済みの固定文言。プロンプトにも検査にも同じ値を使う。
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

${example}

---

${OUTPUT_FORMAT}`

    // 指示は素材の性質で増減するので、番号は組み立て時に振る。
    // 手で番号を打つと、行を足したときに 6 が2つある指示ができあがる。
    const tasks = [
      `終了日を見比べて「同じ日に終了するまとまり」を探すこと。
   同一監督・同一シリーズ・同一ジャンルの集中があれば、それを記事の軸にする。`,
      `リードの2段落目では、見つけたまとまりのうち**知名度の高いものを終了日順に**、
   作品名・シリーズ名を「」で囲んで挙げること。記事の構造の説明は書かない。
   目立つシリーズが無ければ、有名作・人気作、近年に続編が出た作品を優先する。`,
      `**各セクションは「見出し → 表 → 解説」の順に書くこと。**
   見出しの直後に導入文を挟まず、いきなり表を置きます。
   表の列は「終了日 / 作品 / 評価 / サービス」の4列で固定してください。`,
      `まとまりを解説する \`##\` セクションは、**見出しに具体的な作品名を入れ**、
   **最終段落を「〜しましょう」など視聴を促す形で締める**こと。`,
      `**評価スコアは表にだけ書き、地の文には一切書かないこと。**
   「この日の最高評価は」「評価だけで選ぶなら」はいずれも禁止です。`,
      traits.hasOverview
        ? 'あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。'
        : `**あらすじは素材にありません。作品の内容を創作しないでください。**
   与えられた事実（終了日・公開年・ジャンル・話数・シリーズ名）と、
   作品名から読者が判断できることだけで書きます。
   自信のない筋書き・登場人物・受賞歴を補ってはいけません。`,
      traits.localizedTitles
        ? `作品名は与えられたものをそのまま使ってください。
   原題や英題を併記したり、別表記に言い換えたりしないこと。`
        : `「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。`,
      traits.hasLineup
        ? `**「見放題が終了する」であって「観られなくなる」ではありません。**
   このサービスにはポイント（レンタル・購入）での取り扱いがあり、
   見放題が終わっても残る作品があります。
   「観られなくなります」「視聴できなくなります」「配信が終了します」は
   **すべて禁止**です。「見放題での配信が終了します」と書いてください。
   「★見放題は終了するが、ポイントでの取り扱いは続く」と付いた作品は、
   特にその点が分かるように書きます。`
        : '',
      `制作会社は素材に与えられたものだけを書いてください。
   放送開始日・公開日など、データに無い日付を補ってはいけません。`,
      `記号は全角に統一してください（！ ？ （） を半角で書かない）。
   ただし作品名に含まれる半角記号は正式表記なのでそのまま使ってください。`,
    ].filter(Boolean)

    const prompt = `以下は今月見放題配信の終了が確定している作品のデータです。全${items.length}件。

${rows.join('\n\n')}

---

このデータから記事を書いてください。

特に重要な作業:
${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`

    return { system, prompt }
  },

  /**
   * ショート動画の台本。
   *
   * **配信終了予定はショートに最も向く記事タイプ。** 締切があるので
   * 「あと何日で見放題が終わる」がそのまま30秒の軸になる。
   * サイトのタグライン（消える前に、気づける。）とも噛み合う。
   */
  buildShortPrompt(items, ctx) {
    const traits = traitsOf(ctx.variant?.key)
    const resolved = resolvePhrases(items, ctx)

    return shortScriptSection(ctx, {
      dateLabel: '終了日',
      titlesAreLocalized: traits.localizedTitles,
      candidates: items,
      closer: resolved.shortCloser,
      extraRules: [
        `**この記事タイプの強みは締切。** 「${articleMonth(ctx)}月◯日で見放題が終わる」を軸に置く。
   ただし急かすのは終了日という事実の提示までとし、視聴を命令しない。`,
        traits.hasLineup
          ? `**「見放題が終了する」であって「観られなくなる」ではありません。**
   ${ctx.variant?.label ?? 'このサービス'} にはポイント（レンタル・購入）での取り扱いがあり、
   見放題が終わっても残る作品があります。30秒では但し書きを添えられないので、
   ナレーションもテロップも必ず「見放題」を付けてください。`
          : '',
      ].filter(Boolean),
    })
  },

  tags(items, ctx) {
    const labelOf = serviceLabels(ctx)
    const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
    const [y, m] = ctx.targetMonth.split('-')
    return [...services, '配信終了', `${y}年${Number(m)}月`]
  },

  slug(ctx) {
    // ★ 既に公開済みの 2026-08-leaving / 2026-09-leaving は総合1本だった頃のもの。
    //   サービス別に切り替えた 2026-10 以降がこの形になる。過去分は作り直さない。
    return `${ctx.targetMonth}-leaving-${ctx.variant?.key ?? 'all'}`
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)

    const issues: VerifyIssue[] = []
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const resolved = resolvePhrases(items, ctx)
    const traits = traitsOf(ctx.variant?.key)
    const otherLinks = (ctx.theme.search_links ?? []).filter((l) => l.key !== ctx.variant?.key)

    // --- 事故を防ぐ検査（公開を止める） ---

    // 全終了作品リスト（表）があるか
    if (!md.includes('|')) {
      err('全終了作品の一覧表がありません。テンプレートの構成4が守られていません。')
    }
    // 他サービス検索リンクがあるか（収益導線かつ読者の実用性）
    if (otherLinks.length && !otherLinks.some((l) => md.includes(l.label))) {
      err(
        `他サービス（${otherLinks.map((l) => l.label).join(' / ')}）での検索リンクがありません。` +
          'テンプレートの構成5が守られていません。',
      )
    }
    // 「配信中」と断定していないか。
    // ★ 判定の対象は「この記事のサービス以外」。U-NEXT の記事で
    //   「U-NEXTで配信中」と書くのは事実なので、一律に禁じてはいけない。
    for (const l of otherLinks) {
      if (md.includes(`${l.label}で配信中`)) {
        err(
          `${l.label} について「配信中」と断定しています。` +
            'そのサービスの配信状況のデータを持っていないため書けません。',
        )
      }
    }
    // 見放題とポイントが同居するサービスで、「もう観られない」と読ませていないか。
    // 読者を直接裏切る誤情報なので warn ではなく error。
    if (traits.hasLineup) {
      for (const phrase of UNAVAILABLE_CLAIM) {
        if (md.includes(phrase)) {
          err(
            `「${phrase}」が含まれています。${ctx.variant?.label ?? 'このサービス'} は` +
              '見放題が終わってもポイント（レンタル・購入）で残る作品があるため、' +
              '観られなくなると断定できません。「見放題での配信が終了します」に書き換えてください。',
          )
        }
      }
    }
    // 「見放題」を付けずに「配信終了」と書いている行。断定になるので直す。
    // 判定が行単位で外れることがあるため warn（公開は止めない）。
    if (traits.hasLineup) {
      for (const line of bareDeliveryEnd(md)) {
        warn(
          `「見放題」を付けずに配信終了と書いています: 「${clip(line, 50)}」` +
            '（ポイントでの取り扱いは続く場合があります）',
        )
      }
    }
    // 出典表記。★ サービスごとに文言が違う。
    //   U-NEXT の記事に API の帰属表示が付いていると、出典を偽ることになる。
    if (!md.includes(resolved.attribution)) {
      err(
        `記事末尾の出典表記がありません。次の1行をそのまま入れてください:\n      ${resolved.attribution}`,
      )
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

    // 評価は表にだけ載せる。地の文の言及は読者の役に立たない。
    for (const line of ratingMentionsInProse(md)) {
      warn(`地の文で評価に言及しています: 「${clip(line, 50)}」（評価は表にだけ載せます）`)
    }

    for (const section of dateSections(md)) {
      // ★ 構成の核。見出しの直後に導入文を挟むと、
      //   読者は一覧を掴む前に文章を読まされることになる。
      if (!section.startsWithTable) {
        warn(`「${section.heading}」の見出し直後が表になっていません（見出し → 表 → 解説の順）。`)
      }
      const last = section.lastParagraph
      if (last && !CALL_TO_ACTION.test(last)) {
        warn(
          `「${section.heading}」の最後が視聴を促す形で終わっていません: 「${clip(last)}」` +
            '（「〜しましょう」「見逃せません」など）',
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
  /** 【8月終了】 */
  leadPrefix: string
  leadFirstSentence: string
  leadCloser: string
  otherServicesIntro: string
  attribution: string
  /** ショート動画の締め */
  shortCloser: string
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
    leadPrefix: `【${vars.月}月終了】`,
    leadFirstSentence: get('leaving-lead-first-sentence'),
    leadCloser: get('leaving-lead-closer'),
    otherServicesIntro: get('other-services-intro'),
    // ★ データの出どころが違えば出典表記も違う。機械的に API の帰属表示を
    //   付けると、取得していないAPIを出典として偽ることになる。
    attribution: get(traitsOf(ctx.variant?.key).attributionKey),
    shortCloser: get('short-closer'),
    asOf: vars.基準日,
  }
}

