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
import { productionCompanies, researchLines } from '../work-context.ts'
import {
  articleMonth,
  asOfLabel,
  bareDeliveryEnd,
  clip,
  fixedPhrases,
  foundSince,
  halfWidthSymbols,
  isTargetMonth,
  itemTitles,
  monthTagOf,
  namingRules,
  normalizeBody,
  phraseReader,
  previousAsOf,
  publishable,
  ratingMentionsInProse,
  sectionsOf,
  SECTION_PROSE_LIMIT,
  serviceLabels,
  shortScriptSection,
  structureIssues,
  titleIssues,
  UNAVAILABLE_CLAIM,
  variantKey,
  styleIssues,
  writingRules,
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
 * 最初はジャンル別（アニメ / 洋画 / 邦画）を検討したが、**その時点では成立しなかった**。
 * 配信終了は洋画ライブラリの入れ替えが主因で、邦画が慢性的に枯れていた。
 *
 *     leaving 9月  合計65件 → アニメ 6 / 洋画 47 / 邦画  3
 *     leaving 8月  合計147件 → アニメ41 / 洋画 78 / 邦画 11
 *
 * 一方サービス別なら 9月= Netflix 35 / Prime Video 30 で両方成立する。
 *
 * ★ **この計測は U-NEXT を足す前（2026-08-25 より前）のもの。** U-NEXT が入った今、
 *   8月はジャンル横断なら3ジャンルとも成立する（アニメ55 / 洋画72 / 邦画58）。
 *   それでも**ジャンル別の終了記事は作らないと決めた**（2026-08-27）。
 *   読者は「Netflixで何が終わるのか」を探しに来ており、ジャンルで束ねると
 *   どのサービスの話なのかが読者側で分解できない。9月はアニメ6件・邦画3件で
 *   そもそも成立しないという事情もある（docs/ARTICLE-RULES.md 2-2 に月別の内訳）。
 *   **配信終了はサービス別だけ。**
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
  // 月内に同じ記事を書き直したとき用（2026-08-27 追加）
  'leaving-update-lead-first-sentence',
  /*
   * ★ 2026-09-19 のテンプレ改修で3つ減った。
   *   `*-nochange`         … 頭の 【◯月◯日更新】 を外したので初回の文言と同一になった
   *   `leaving-lead-closer` … リードを1組（2文）だけにしたので置き場所が無くなった
   *   `other-services-intro`… 「他のサービスで探す」の節ごと廃止（行き先は表の各行の下）
   */
  'attribution',
  // U-NEXT の記事に API の帰属表示を付けると出典を偽ることになるため別文言
  'attribution-unext',
  // ショート動画の締め（記事と同時に作る台本で使う）
  'short-closer',
] as const

/**
 * 段落を「視聴を促す形」で締めているとみなす語尾。
 * テンプレート構成2の締めルール（`templates/leaving.md`）に対応する。
 */
const CALL_TO_ACTION = /(ましょう|ください|見逃せません|お見逃しなく|お見逃しがないように|おすすめです)[。！]?$/

export const leavingArticle: ArticleType = {
  id: 'leaving',
  category: 'leaving',
  axis: 'service',
  description: '今月見放題が終了する作品（サービス別）',
  variants: SERVICE_VARIANTS,
  variantFlag: 'service',
  variantNoun: 'サービス',
  minItems: MIN_ITEMS,

  /*
   * その月が終わったら「終了予定」ではなく「終了済み」。**本文は直さない。**
   * 直すのは frontmatter の2行だけで、理由は `core/article.ts` の `retire` に書いてある。
   *
   * ★ 下の `select()` が「対象月に終了」かつ「終了日が未来」で絞っているから、
   *   月が終わった時点で載っている全作品の終了日が過ぎたと**確定できる**。
   *   ここが `retire` を宣言してよい根拠そのもの。片方を変えるならもう片方も見ること。
   * ★ タグで引くので、同じ `配信終了` を付ける特報（`--kind expiring`）も一緒に移る。
   */
  retire: {
    tag: '配信終了',
    becomes: '配信終了済み',
    category: 'ended',
    monthOf: monthTagOf,
  },

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
    const version = versionOf(items, this.slug(ctx))

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
        // ★ 更新版の主役。LLM に日付を突き合わせさせず、素材の側でラベルを振る。
        version.isUpdate && foundSince(e, version.since)
          ? '  ★今回新たに判明した終了予定（前回の版には載っていない）'
          : '',
        e.work.year ? `  公開年: ${e.work.year}年` : '',
        e.work.rating ? `  評価: ${e.work.rating}/100（★記事には書かないこと。表の行を並べる目安にだけ使う）` : '',
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
        researchLines(e.work),
        e.work.overview ? `  あらすじ(英語原文): ${e.work.overview}` : '',
        links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    // 差し込み済みの固定文言。プロンプトにも検査にも同じ値を使う。
    const resolved = resolvePhrases(items, ctx, version)

    const system = `あなたは動画配信サービスの情報を扱う日本語ブログの編集者です。
与えられたデータだけを使って記事を書きます。データに無い事実を書いてはいけません。

${template}

---

${namingRules(ctx)}

---

${writingRules(ctx)}

---

# 今回の版

**この記事は「${version.isUpdate ? '更新版' : '初回'}」です。**

${
  version.isUpdate
    ? `前回の版は ${version.since!.toISOString().slice(0, 10)} 時点のものです。
今回新たに判明した終了予定が **${version.added.length}件** あります（素材に ★ が付いています）。
テンプレートの「更新版」の指示に従い、**今回判明した分を記事の先頭で見せてください。**
タイトルは **【${ctx.targetMonth.split('-')[0]}年${articleMonth(ctx)}月】で始め**、本数の直後に 【${resolved.asOf}更新】 を置いてください。
**先頭を 【${resolved.asOf}更新】 にしないこと。** 先頭が更新日だと、検索結果の一覧でどのカテゴリ・どの月の記事か分からなくなります。
前回までに載っていた作品は落とさず、同じ表に一緒に並べます。`
    : `この記事は今月・${ctx.variant?.label ?? ''} で**はじめて書く版**です。
タイトルにも本文にも「更新」と書いてはいけません。前の版が無いので嘘になります。`
}

---

# 今月そのまま使う固定文言

以下は**一字一句そのまま**本文に入れてください。言い換え・要約・記号の変更をしてはいけません。

## リード（本文の冒頭。**ここだけで1段落。2段落目を書かない**）

${resolved.leadFirstSentence}

## 記事の末尾

${resolved.attribution}

---

${example}

---

${OUTPUT_FORMAT}`

    // 指示は素材の性質で増減するので、番号は組み立て時に振る。
    // 手で番号を打つと、行を足したときに 6 が2つある指示ができあがる。
    const tasks = [
      `**「##」の節は2つだけ作ってください（＋まとめ）。** 記事全体の形は次で固定です。

   \`\`\`
   リード（見出しなし・固定文言の1組だけ）
   ## 小段落1  中心の2〜3作   … 表 → 解説（最大${SECTION_PROSE_LIMIT}字）
   ## 小段落2  残りの全${items.length}件 … 表 → 軽い言及
   ## まとめ
   \`\`\`

   ★ **「他のサービスで探す」「全終了作品リスト」の節は作りません**（2026-09-19 に廃止）。
     行き先は表の各行の下にサイトが出します。残り全件は小段落2の表が持ちます。
   ★ **Amazon・Hulu のリンクも、配信カレンダーへのリンクも本文に書かないこと。**
     小段落の直下と表の直下にビルドが入れます。`,
      version.isUpdate
        ? `**小段落1は「今回新たに判明した終了予定」にしてください。**
   対象は ★ が付いた${version.added.length}件です。解説する2〜3作はその中から選びます。
   前回までに載っていた作品は落とさず、**小段落2の表に全件残してください**。
   前の版の本数は書かないこと（読者が前の版を見ているとは限りません）。`
        : `**小段落1で解説するのは、中心になる2〜3作だけです。**
   本数が多く名前の通ったまとまり（同一シリーズ・同一制作会社・同一ジャンル）を1つ選び、
   その中の2〜3作を解説します。**4作以上を解説しないでください。**`,
      `**リードは上の固定文言の1組（2文）だけです。2段落目を書かないでください。**
   タイトルがすでに中心作を名乗っているので、ここで作品名を挙げると同じ名前を2回読ませることになります。
   リードのすぐ次が小段落1の見出しです。`,
      `**どちらの小段落も「見出し → 表 → 解説」の順に書くこと。**
   見出しの直後に導入文を挟まず、いきなり表を置きます。
   表の列は「終了日 / 作品 / 出演者 / サービス」の4列で固定してください。
   ★ **同じ作品を2つの表に出さないこと。** 小段落1に出した作品は小段落2の表から外します。`,
      `小段落1の解説は**${SECTION_PROSE_LIMIT}字以内**に収めてください。
   調べた事実の密度は落とさず、**扱う作品数を絞る**ことで字数を守ります。
   見出しには具体的な作品名を入れ、**最終段落を「〜しましょう」など視聴を促す形で締める**こと。`,
      `小段落2は**表が主役**です。表の下に、特筆すべき1〜2作だけを1〜2文で書いてください。
   作品名を並べただけの段落を作らないこと。書くことが無ければ表だけで構いません。`,
      `**評価スコアは記事のどこにも書かないこと。** 表にも地の文にも出しません。
   素材の評価は、表の行を並べる順番を決めるための目安としてだけ使ってください。
   「この日の最高評価は」「評価だけで選ぶなら」はいずれも禁止です。`,
      `**表の「出演者」欄には主演と助演を1名ずつ（計2名まで）書くこと。網羅しません。**
   素材の \`出演\` の行から選びます。**アニメは「キャラ名（CV.声優）」の形**で書いてください。
   ★ **素材の \`出演\` は並び順が主演順ではありません。** どちらが主演か分からない作品では、
     代表として2名を挙げるだけにして「主演」と書かないでください。
   ★ 素材に \`出演\` の行が無い作品の欄は **「—」** にします（推測で埋めない）。`,
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
    const resolved = resolvePhrases(items, ctx, versionOf(items, this.slug(ctx)))

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
    // ★ 既に公開済みの 2026-08-leaving は総合1本だった頃のもの（サービス横断）。
    //   サービス別に切り替えた分がこの形になる。過去分は作り直さない。
    //   `?? 'all'` の逃げ道は 2026-08-27 に塞いだ。軸を名乗らない記事は作れない。
    return `${ctx.targetMonth}-leaving-${variantKey(ctx, this.id)}`
  },

  verifyTitle(title, ctx) {
    return titleIssues(title, ctx, {
      axis: 'service',
      verbPhrase: '見放題配信が終了予定の',
      isUpdate: previousAsOf(this.slug(ctx)) !== undefined,
    })
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)

    // 全記事タイプ共通の決まり（templates/writing.md）
    const issues: VerifyIssue[] = [
      ...styleIssues(md),
      // 記事の骨格（小段落2つ＋まとめ・廃止した節・解説の字数）
      ...structureIssues(md, { maxSectionProse: SECTION_PROSE_LIMIT }),
    ]
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const version = versionOf(items, this.slug(ctx))
    const resolved = resolvePhrases(items, ctx, version)
    const traits = traitsOf(ctx.variant?.key)
    const otherLinks = (ctx.theme.search_links ?? []).filter((l) => l.key !== ctx.variant?.key)

    // --- 事故を防ぐ検査（公開を止める） ---

    // 作品の表があるか。**小段落2の表が残り全件を持つ**（2026-09-19 の改修）
    if (!md.includes('|')) {
      err('作品の一覧表がありません。小段落1と小段落2の両方に表が要ります。')
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

    /*
     * ★ リードは**この1組（2文）だけ**（2026-09-19）。頭の 【◯月終了】 も締めの文言も外した。
     *   本文の1行目がこの固定文言そのものであることを見る。
     */
    if (!md.startsWith(resolved.leadFirstSentence)) {
      err(
        '本文の冒頭がリードの固定文言と一致しません。次の1組をそのまま1行目に置いてください:\n' +
          `      ${resolved.leadFirstSentence}`,
      )
    }

    // --- 版の取り違え（公開を止める） ---

    // ★ 初回に「更新」と書くと、前の版が無いのに更新したと読める。読者に対する嘘。
    if (!version.isUpdate && /【[^】]*更新[^】]*】/.test(md)) {
      err('初回の版なのに本文が「更新」を名乗っています。前の版がありません。')
    }
    // 更新版の主役は今回判明した分。表にも本文にも出ていないなら更新の意味が無い。
    if (version.isUpdate && version.added.length > 0) {
      const notShown = version.added
        .map((e) => e.work.localizedTitle ?? e.work.title)
        .filter((t) => t && !md.includes(t))
      if (notShown.length > 0) {
        err(
          `今回新たに判明した終了予定が本文にありません: ` +
            notShown.slice(0, 8).map((t) => clip(t, 24)).join(' / ') +
            (notShown.length > 8 ? ' ほか' : ''),
        )
      }
    }

    // --- 文体の検査（止めない。判定が外れることがあるため） ---

    /*
     * ★ リードは1段落だけ（2026-09-19）。2段落目を書くと、タイトルで名乗った
     *   中心作の名前を読者が2回読むことになる（fixed-phrases.md の理由）。
     *   1行目の固定文言と、次の `##` のあいだに地の文があれば指摘する。
     */
    const beforeFirstHeading = md.split(/\n## /, 1)[0] ?? ''
    const leadExtra = beforeFirstHeading
      .slice(resolved.leadFirstSentence.length)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
    if (leadExtra.length > 0) {
      warn(
        `リードに2段落目があります: 「${clip(leadExtra.join(''), 50)}」\n` +
          '      リードは固定文言の1組だけにして、すぐ小段落1の見出しへ進んでください。',
      )
    }

    // 評価は表にだけ載せる。地の文の言及は読者の役に立たない。
    for (const line of ratingMentionsInProse(md)) {
      warn(`地の文で評価に言及しています: 「${clip(line, 50)}」（評価は表にだけ載せます）`)
    }

    /*
     * ★ 締めの検査は**小段落1だけ**（2026-09-19）。
     *   小段落2は表が主役で、0〜2文しか置かないので促し文句を求めない。
     *   「見出し → 表」の順は structureIssues が全節を見ている。
     */
    for (const section of sectionsOf(md).slice(0, 1)) {
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
  /** リード。**記事の冒頭はこれ1組だけ**（2026-09-19） */
  leadFirstSentence: string
  attribution: string
  /** ショート動画の締め */
  shortCloser: string
  /** 記事作成日。「8月9日」形式 */
  asOf: string
}

/**
 * この記事の「版」。**更新版かどうかの判定はここ1か所。**
 *
 * 終了予定は月の途中で新しく判明する（収集のたびに Issue で通知している内容そのもの）。
 * 記事を1本ずつ増やすと同じ検索語を自分同士で奪い合うので、同じスラッグを書き直す。
 *
 * ★ 「今回判明した分」は**収集日だけ**で決める（`foundSince`）。
 *   終了日で判定すると、終了日は未来なので全件が今回分になる。
 */
function versionOf(items: ChangeEvent[], slug: string) {
  const since = previousAsOf(slug)
  return { since, isUpdate: since !== undefined, added: items.filter((e) => foundSince(e, since)) }
}

interface Version {
  since: Date | undefined
  isUpdate: boolean
  added: ChangeEvent[]
}

/** 固定文言に今月の値を差し込む。プロンプトと検査で同じ結果になることが要件。 */
function resolvePhrases(items: ChangeEvent[], ctx: ArticleContext, version: Version): ResolvedPhrases {
  const vars = {
    月: articleMonth(ctx),
    // ★ items から作らない。素材が0件の月に全サービス名が並んでしまう。
    //   1本の記事が扱うのは1社だけなので、軸のラベルがそのまま答えになる。
    サービス: ctx.variant?.label ?? '',
    基準日: asOfLabel(ctx),
    本数: items.length,
    追加本数: version.added.length,
  }
  const get = phraseReader(fixedPhrases(ctx, REQUIRED_PHRASES), vars)

  return {
    /*
     * ★ **追加0本の更新版は初回と同じ文言**（2026-09-19）。
     *   「今回新たに0本の終了予定が判明し」が読者の見る1文目に出るのを避ける。
     *   頭の 【◯月◯日更新】 を外したので、専用の `-nochange` は要らなくなった。
     */
    leadFirstSentence: get(
      version.isUpdate && version.added.length > 0
        ? 'leaving-update-lead-first-sentence'
        : 'leaving-lead-first-sentence',
    ),
    // ★ データの出どころが違えば出典表記も違う。機械的に API の帰属表示を
    //   付けると、取得していないAPIを出典として偽ることになる。
    attribution: get(traitsOf(ctx.variant?.key).attributionKey),
    shortCloser: get('short-closer'),
    asOf: vars.基準日,
  }
}

