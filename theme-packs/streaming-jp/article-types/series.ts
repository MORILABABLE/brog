/**
 * 記事タイプ: シリーズ（主題別・**月を名乗らない唯一の記事**）
 *
 *   npm run write -- --type series \
 *     --topic "「名探偵コナン」劇場版シリーズ" --slug conan-movies \
 *     --match "名探偵コナン" --emit
 *
 * ■ 何のための記事か
 * 実測したサジェストで、読者は「見放題」を単独では打たない。
 * 必ず作品名かサービス名と一緒に打つ（docs/KEYWORDS.md 2-1）。
 * そのうち**シリーズ名 ＋「いつまで」**は、検索需要と手元のデータが
 * 正面から一致した唯一の的だった（同 3-3）。
 *
 *   サジェスト: 「コナン 映画 配信 いつまで」「コナン 映画 配信終了」
 *   手元データ: 「名探偵コナン」の作品ページ27枚。**全部が終了予定**
 *
 * ■ 特報（`special`）と何が違うのか — **URLに月が入らないこと**
 * 公開中の記事14本はすべてスラッグが `{年}-{月}-…` で始まり、特報ですら
 * `${targetMonth}-special-<slug>` になる。URLが毎月変わるので、
 * **評価も被リンクも1本のURLに積み上がらない**（docs/STOCK.md 2-2）。
 *
 * この記事タイプは `conan-movies` のように**月を持たないスラッグ**を作り、
 * 配信状況が変わるたびに**同じURLを書き直す**。更新のたびに強くなる形にする。
 * タイトル先頭の名乗りも `【保存版】` に差し替える（`TitleRule.periodLabel`）。
 *
 * ■ `--kind` を持たない — **状態はデータから決める**
 * 特報は「これから終わる」か「もう終わった」かを人が `--kind` で選ぶ。
 * **その形はこの記事タイプでは壊れる。** 同じURLを何か月も書き直すので、
 * 今月は終了予定だった作品が来月には終了済みになり、
 * **人が選んだ `--kind` だけが古くなる。**
 *
 * だから状態は素材から決める（`stanceOf()`）。作品ページが
 * 「文言をデータから決める。手書きの説明文を挟むとビルドのたびに古くなる」
 * としているのと同じ考え方（docs/GROWTH.md 3-1）。
 *
 * ■ 素材は `expiring` と `removed` だけ
 * `new` しか観測していない作品（＝いま見放題だが終了日が分からない）は載せない。
 * 理由は2つあって、どちらも外すと記事の性格が変わる。
 *
 *   1. この記事が答えるのは「**いつまで**観られるか」。終了日が無い作品は答えられない
 *   2. 作品ページの掲載条件と同じ集合になるので、**表の全行が作品ページへ繋がる**
 *      （`isWorkPagePublishable` の「終了日を言える」と同じ線）
 *
 * ■ 文章の型は2つのファイルに分かれている
 *   templates/series.md            構成と文体のルール
 *   templates/fixed-phrases.md     `series-` で始まる固定文言
 *
 * 判断の根拠と実測は docs/KEYWORDS.md 6節（案1）。
 */
import { readFileSync } from 'node:fs'
import {
  OUTPUT_FORMAT,
  type ArticleContext,
  type ArticleType,
  type Category,
} from '../../../pipeline/core/article.ts'
import { buildSearchLinks } from '../../../pipeline/core/search-links.ts'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { VerifyIssue } from '../../../pipeline/core/verify.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'
import { castNames, directorNames, productionCompanies, researchLines } from '../work-context.ts'
import {
  asOfLabel,
  bareDeliveryEnd,
  clip,
  fixedPhrases,
  halfWidthSymbols,
  itemTitles,
  MISLEADING_AFTER_END,
  namingRules,
  normalizeBody,
  peopleLine,
  phraseReader,
  previousAsOf,
  publishable,
  ratingMentionsInProse,
  serviceLabels,
  styleIssues,
  titleIssues,
  UNAVAILABLE_CLAIM,
  writingRules,
} from './shared.ts'

/**
 * 1記事に載せる上限。
 *
 * 特報（40件）より大きくしてある。シリーズは1本で全作を引き受けるのが値打ちで、
 * 「27作のうち20作だけ」の記事は読者の用（全部でいつまで観られるか）を満たさない。
 * 実測でいちばん大きい束が「名探偵コナン」59件なので、そこが入る値にする。
 */
const MAX_ITEMS = 80

/**
 * 記事として成立する最低の素材数。
 *
 * 3件。**人物ページの下限と同じ理由**（docs/STOCK.md S-3）。
 * 2件のシリーズ記事は「作品ページ2枚へのリンク＋数行」にしかならず、
 * 作品ページ単体で足りている。永続URLを1本使うだけの中身が無い。
 */
const MIN_ITEMS = 3

/** スラッグに使える形。日本語の主題からURLは作れないので、人に決めてもらう。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/

/** タイトルに年月を名乗らせない検査に使う（この記事タイプの生命線） */
const MONTH_IN_TITLE = /\d{4}年\d{1,2}月|\d{1,2}月\d{1,2}日(?!更新)/

const REQUIRED_PHRASES = [
  'series-lead-first-sentence',
  'series-update-lead-first-sentence',
  'series-ended-lead-first-sentence',
  'leaving-lead-closer',
  'ended-lead-closer',
  'other-services-intro',
  'attribution',
  'attribution-unext',
] as const

/**
 * この記事がいまどちら向きの記事なのか。**素材から決まる。**
 *
 * `leaving` … まだ終わっていない作品が1本でもある。「いつまで観られるか」の記事
 * `ended`   … 全部終わっている。「いつまで観られたか」の記事
 *
 * ★ 途中で入れ替わる。コナンの27本が全部終われば、次に書き直したとき
 *   同じURLのまま `ended` の記事になる。**それが正しい挙動。**
 */
type Stance = 'leaving' | 'ended'

interface StanceTraits {
  category: Category
  /** templates/naming.md の表と1文字も違えないこと */
  verbPhrase: string
  leadKey: string
  closerKey: string
}

const STANCES: Record<Stance, StanceTraits> = {
  leaving: {
    category: 'leaving',
    verbPhrase: '見放題配信が終了予定の',
    leadKey: 'series-lead-first-sentence',
    closerKey: 'leaving-lead-closer',
  },
  ended: {
    category: 'ended',
    verbPhrase: '見放題配信が終了した',
    leadKey: 'series-ended-lead-first-sentence',
    closerKey: 'ended-lead-closer',
  },
}

/** 1件の作品が、いま読者にとってどういう状態か。表の「状態」列にそのまま出る。 */
function stateOf(e: ChangeEvent, now: Date): '終了予定' | '終了済み' {
  if (e.kind === 'removed') return '終了済み'
  return Date.parse(e.at!) >= now.getTime() ? '終了予定' : '終了済み'
}

/** 素材のうち1本でもまだ観られるなら `leaving`。全部終わっていれば `ended`。 */
function stanceOf(items: ChangeEvent[], ctx: ArticleContext): Stance {
  return items.some((e) => stateOf(e, ctx.now) === '終了予定') ? 'leaving' : 'ended'
}

function traitsOf(items: ChangeEvent[], ctx: ArticleContext): StanceTraits {
  return STANCES[stanceOf(items, ctx)]
}

/** 見放題とポイントが同居するサービス。「観られなくなる」と書けない */
function hasLineup(service: string): boolean {
  return service === 'u-next'
}

/** 素材のタイトルが最初から邦題か */
function localizedTitles(items: ChangeEvent[]): boolean {
  return items.length > 0 && items.every((e) => e.work.meta.source === 'u-next')
}

export const seriesArticle: ArticleType = {
  id: 'series',
  // ★ 主題軸。サービスを横断してよい（特報・ジャンル軸と同じ理由）
  axis: 'topic',
  // 既定値。実際には素材から決まる（categoryOf）
  category: 'leaving',
  description: 'シリーズ（月を名乗らない保存版。--topic / --slug / --match が必要）',

  minItems: MIN_ITEMS,

  flags: [
    {
      name: 'topic',
      description: '記事の主題。タイトルと本文にそのまま出る（例: 「名探偵コナン」劇場版シリーズ）',
      required: true,
    },
    {
      name: 'slug',
      description: 'URLに使う半角英数字とハイフン。**月を入れない**（例: conan-movies）',
      required: true,
    },
    {
      name: 'match',
      description: '作品名で絞る正規表現（例: 名探偵コナン）',
      required: true,
    },
    { name: 'service', description: '1社に絞る場合のサービスキー（例: netflix）' },
  ],

  /**
   * ★ **人が選んだフラグではなく、素材から決める。**
   *   全作品が終了していれば `ended`、1本でも残っていれば `leaving`。
   *   同じURLを書き直すうちに入れ替わるので、ここを固定値にすると
   *   バッジだけが古くなる（この記事タイプが `--kind` を持たない理由と同じ）。
   */
  categoryOf(_ctx, items) {
    return STANCES[stanceOf(items, _ctx)].category
  },

  select(rawEvents, _ledger: Ledger, ctx) {
    // --list ではフラグが渡らない。数えようがないので空で返す（--list 側が「要指示」と出す）
    if (!ctx.flags?.match) return []

    const service = ctx.flags.service
    const match = new RegExp(ctx.flags.match, 'i')

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    const events = publishable(rawEvents)

    const target = events
      // 「いつまで」に答えられる観測だけ。`new` と `upcoming` は載せない（冒頭の理由）
      .filter((e) => e.kind === 'expiring' || e.kind === 'removed')
      .filter((e) => e.at)
      .filter((e) => !service || e.service === service)
      // 見放題とポイントが同居するサービスでは、ポイント専用作品を外す。
      // 載せると**そもそも見放題ではなかった作品**を扱うことになる。
      .filter((e) => {
        if (!hasLineup(e.service)) return true
        const lineup = e.work.meta.lineup
        return lineup === 'svod' || lineup === 'both'
      })
      .filter((e) => {
        const w = e.work
        return match.test(w.title) || (w.localizedTitle ? match.test(w.localizedTitle) : false)
      })

    /*
     * ★ **いちばん新しい観測を残す。** 特報は「最初に把握した回」を残すが、
     *   この記事は同じURLを何か月も書き直すので、必要なのは**いまの状態**。
     *   終了予定（8/31）を見たあとに終了済み（9/1）を観測した作品は、
     *   古いほうを残すと「まだ観られます」と書いてしまう。
     *
     *   月をまたいで素材を集めるのもこの記事だけ（`readAllEvents()` の全期間）。
     *   シリーズは「その月に何が起きたか」ではなく「いま全作がどうなっているか」を答える。
     */
    const latest = new Map<string, ChangeEvent>()
    for (const e of target) {
      const key = `${e.service}/${e.work.id}`
      const cur = latest.get(key)
      if (!cur || e.collectedAt > cur.collectedAt) latest.set(key, e)
    }

    const kept = [...latest.values()]
    const limited =
      kept.length <= MAX_ITEMS
        ? kept
        : [...kept].sort((a, b) => (b.work.rating ?? 0) - (a.work.rating ?? 0)).slice(0, MAX_ITEMS)

    /*
     * 並びは「まだ観られるものが先、終了日の早い順」。
     * 読者が最初に知りたいのは締切の近い作品で、終了済みは後ろでよい。
     */
    return limited.sort((a, b) => {
      const sa = stateOf(a, ctx.now) === '終了予定' ? 0 : 1
      const sb = stateOf(b, ctx.now) === '終了予定' ? 0 : 1
      if (sa !== sb) return sa - sb
      return a.at!.localeCompare(b.at!)
    })
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'series.md'), 'utf8')
    const traits = traitsOf(items, ctx)
    const resolved = resolvePhrases(items, ctx)
    const labelOf = serviceLabels(ctx)
    const offset = ctx.theme.utc_offset_minutes
    const unext = localizedTitles(items)
    const isUpdate = previousAsOf(this.slug(ctx)) !== undefined
    const services = [...new Set(items.map((e) => e.service))]
    const stillOn = items.filter((e) => stateOf(e, ctx.now) === '終了予定').length
    const alreadyOff = items.length - stillOn

    const rows = items.map((e) => {
      const w = e.work
      const links = buildSearchLinks(
        w,
        (ctx.theme.search_links ?? []).filter((l) => l.key !== e.service),
      )
      const title = w.localizedTitle ?? w.title
      // ★ 邦題と原題が同じ文字列のことがある（U-NEXT は最初から邦題で、原題を持たない）。
      //   そのまま出すと「◯◯（原題: ◯◯）」になるので出さない。
      const note = !w.localizedTitle
        ? '（★邦題が未確認。この原題のまま書くこと）'
        : w.localizedTitle === w.title
          ? ''
          : `（原題: ${w.title}）`

      return [
        `- ${title}${note ? ` ${note}` : ''}`,
        `  サービス: ${labelOf.get(e.service) ?? e.service}`,
        `  状態: ${stateOf(e, ctx.now)}`,
        `  終了日: ${formatMonthDay(e.at!, offset)}`,
        w.year ? `  公開年: ${w.year}年` : '',
        w.rating ? `  評価: ${w.rating}/100（★表にだけ書き、地の文には書かないこと）` : '',
        w.genres.length ? `  ジャンル: ${w.genres.join(' / ')}` : '',
        hasLineup(e.service) && w.meta.lineup === 'both'
          ? '  ★見放題は終了するが、ポイント（レンタル・購入）での取り扱いは続く'
          : '',
        productionCompanies(w)?.length ? `  制作: ${productionCompanies(w)!.join(' / ')}` : '',
        peopleLine('監督', directorNames(w)),
        peopleLine('出演', castNames(w), true),
        researchLines(w),
        w.overview
          ? `  あらすじ(英語原文): ${w.overview}`
          : '  あらすじ: ★未提供（内容を推測して書かないこと）',
        links.length
          ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    const system = `あなたは動画配信サービスの情報を扱う日本語ブログの編集者です。
与えられたデータだけを使って記事を書きます。データに無い事実を書いてはいけません。

${template}

---

${namingRules(ctx)}

---

${writingRules(ctx)}

---

# この記事の主題

**${resolved.topic}**

この記事は**シリーズを軸にした保存版**です。月次のまとめ記事ではありません。
${
  services.length > 1
    ? `対象は ${services.map((s) => labelOf.get(s) ?? s).join(' / ')} の${services.length}社にまたがります。**主題の記事なので横断して構いません。**`
    : `対象は ${labelOf.get(services[0] ?? '') ?? '対象サービス'} の1社です。他社の配信状況は分かりません。`
}

**タイトルは 【保存版】 で始めてください。**
**タイトルに「2026年9月」のような年月を書かないでください。**
この記事は特定の月のものではなく、配信状況が変わるたびに同じURLを書き直します。
主題（${resolved.topic}）と「${traits.verbPhrase}」を必ず入れてください。

  例: 【保存版】${resolved.topic}の${traits.verbPhrase}作品${items.length}本｜（見どころ）

${
  isUpdate
    ? `**この記事には前の版があります。** 本数の直後に 【${resolved.asOf}更新】 を置いてください。`
    : '**「更新」と書かないでください。** 前の版がありません。'
}

---

# 素材の状態（この記事の書き分けの根拠）

| | 本数 |
| --- | --- |
| まだ観られる（終了予定） | ${stillOn}本 |
| もう観られない（終了済み） | ${alreadyOff}本 |

${
  stillOn > 0 && alreadyOff > 0
    ? `**この記事には両方が混ざっています。** 表の「状態」列で1行ずつ区別し、
地の文でも取り違えないでください。終了済みの作品に「お見逃しなく」と書いてはいけません。`
    : stillOn > 0
      ? '**全作品がまだ観られます。** 「終了しました」と過去形で書かないでください。'
      : '**全作品がすでに終了しています。** 「お見逃しなく」「今のうちに」は書けません。'
}

---

# 今回そのまま使う固定文言

以下は**一字一句そのまま**本文に入れてください。言い換え・要約・記号の変更をしてはいけません。

## リードの1文目（本文の冒頭）

${resolved.leadFirstSentence}

## リードの締め（リード段落の最後の1文）

${resolved.leadCloser}

## 「他のサービスで探す」の冒頭

${resolved.otherServicesIntro}

## 記事の末尾

${resolved.attributions.join('\n\n')}

---

${OUTPUT_FORMAT}`

    const tasks = [
      `**主題（${resolved.topic}）から離れないこと。** 与えられた作品以外の話に広げない。
   「今月の配信終了作品一覧」のような書き方はしない。それは月次記事の仕事です。`,
      `**各セクションは「見出し → 表 → 解説」の順に書くこと。**
   表の列は「終了日 / 作品 / 状態 / 評価 / サービス」の5列で固定してください。
   **サービス列と状態列を省かないでください**（サイトが行のサービス名を読んでリンクを付けます）。`,
      `**対象作品リストの節に、下の${items.length}件を1件残らず表に載せること。**`,
      `**評価スコアは表にだけ書き、地の文には一切書かないこと。**`,
      alreadyOff > 0
        ? `**終了済みの${alreadyOff}本を「これから終わる」と書かないこと。**
   その作品には「お見逃しなく」「今のうちに」「観ておきましょう」「配信中です」を使えません。
   終了は過去形（「終了しました」）で書いてください。`
        : '',
      stillOn > 0
        ? `終了日は確定情報です。**急かすのは終了日という事実の提示までとし、視聴を命令しないこと。**`
        : '',
      items.some((e) => hasLineup(e.service))
        ? `**「見放題が終了する」であって「観られなくなる」ではありません。**
   U-NEXT にはポイント（レンタル・購入）での取り扱いがあり、見放題が終わっても残る作品があります。
   「観られなくなります」「視聴できなくなります」「配信が終了します」は**すべて禁止**です。`
        : '',
      unext
        ? `**あらすじは素材にありません。作品の内容を創作しないでください。**`
        : `あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
   「★未提供」と書かれた作品の内容を推測してはいけません。`,
      `**人名は素材に出ているものだけを書いてください。** 人名の行が無い作品は、人名に触れずに書きます。
   あらすじの英文に人名が出てきても、**地の文に写さないでください**。`,
      `記号は全角に統一してください（！ ？ （） を半角で書かない）。
   ただし作品名に含まれる半角記号は正式表記なのでそのまま使ってください。`,
    ].filter(Boolean)

    const prompt = `「${resolved.topic}」の保存版記事のデータです。全${items.length}件。

${rows.join('\n\n')}

---

このデータから記事を書いてください。

特に重要な作業:
${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`

    return { system, prompt }
  },

  tags(items, ctx) {
    const labelOf = serviceLabels(ctx)
    const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
    /*
     * ★ **年月のタグを付けない。** 月次記事は「2026年8月」を持つが、
     *   この記事は月を名乗らない。付けると月別の一覧に並び、
     *   翌月には古い記事に見える。URLと同じ理由で外す。
     *
     * ★ 「シリーズ」は右の枠（SeriesRail.astro）がこのタグで記事を拾う。
     *   **文字列を変えると枠から消える。**
     */
    return [...services, '配信終了', 'シリーズ']
  },

  slug(ctx) {
    // ★ --list と重複チェックはフラグ無しで呼ぶ。落とさずに形だけ返す。
    const given = ctx.flags?.slug
    if (!given) return 'series-<slug>'
    if (!SLUG_PATTERN.test(given)) {
      throw new Error(
        `--slug は半角英数字とハイフンで書いてください（2〜49文字・先頭は英数字）: ${given}\n` +
          '  日本語の主題からURLは作れないので、ここだけは人が決めます。例: --slug conan-movies',
      )
    }
    /*
     * ★ **月を前に付けない。** ここがこの記事タイプの存在理由そのもの
     *   （docs/STOCK.md 2-2 / docs/KEYWORDS.md 案1）。
     *   `${ctx.targetMonth}-` を足した瞬間に、ただの特報になる。
     */
    return given
  },

  verifyTitle(title, ctx) {
    // ★ タイトルの検査は素材を受け取らない。素材から決まる動詞句を出せないので、
    //   **どちらの動詞句でも通す**形にして、取り違えは本文の verify で見る。
    const issues = titleIssues(title, ctx, {
      axis: 'topic',
      // 空文字＝動詞句の検査をしない。かわりに下で2つのどちらかを求める
      verbPhrase: '',
      periodLabel: '保存版',
      axisLabel: ctx.flags?.topic,
      isUpdate: previousAsOf(this.slug(ctx)) !== undefined,
    })

    const verbs = [STANCES.leaving.verbPhrase, STANCES.ended.verbPhrase]
    if (!verbs.some((v) => title.includes(v))) {
      issues.push({
        level: 'error',
        message:
          `タイトルに「${verbs.join('」か「')}」がありません。記事タイプごとに固定の言い方です` +
          '（「見放題終了する」「配信終了する」などに言い換えないこと）。',
      })
    }

    /*
     * ★ **この記事タイプの生命線。**
     *   月を名乗った瞬間、同じURLを書き直しても翌月には古い記事に見える。
     *   URLから月を外した意味が消えるので、タイトル側でも止める。
     *   【8月30日更新】 の日付だけは通す（更新の印なので）。
     */
    const month = MONTH_IN_TITLE.exec(title)
    if (month) {
      issues.push({
        level: 'error',
        message:
          `タイトルに年月（${month[0]}）が入っています。シリーズ記事は特定の月のものではなく、` +
          '同じURLを書き直し続けます。先頭は【保存版】で、月を名乗らないでください。',
      })
    }

    return issues
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)
    // 全記事タイプ共通の決まり（templates/writing.md）
    const issues: VerifyIssue[] = styleIssues(md)
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const resolved = resolvePhrases(items, ctx)
    const stillOn = items.filter((e) => stateOf(e, ctx.now) === '終了予定').length
    const alreadyOff = items.length - stillOn

    /*
     * --- 主題から離れていないか ---
     *
     * ★ **括弧は主題と本文の両方から落としてから見る。**
     *   主題は `「名探偵コナン」劇場版シリーズ` のように鉤括弧を含む形で渡されるが、
     *   本文では `『名探偵コナン 時計じかけの摩天楼』` のように作品ごとの括弧が付く。
     *   片側だけ落とすと、主題を正しく書いている記事でも必ず警告が出る。
     */
    const bare = (s: string) => s.replace(/[「」『』\s]/g, '')
    if (resolved.topic && !bare(md).includes(bare(resolved.topic))) {
      warn(`本文に主題（${resolved.topic}）がそのまま出てきません。シリーズ記事は主題の記事です。`)
    }

    /*
     * --- 状態の取り違え（この記事タイプの生命線） ---
     *
     * ★ 特報と検査の掛け方が違う。特報は記事1本が1つの `--kind` を持つので
     *   本文全体を一律に見られるが、この記事は**1本の中に両方が混ざる**。
     *   混ざっている記事で「お見逃しなく」を一律に禁じると、
     *   まだ観られる作品についても書けなくなる。
     *
     *   そこで**片側しか無いときだけ**、反対側の言い回しを禁じる。
     *   混在しているときは表の「状態」列とプロンプトの指示に任せ、ここでは止めない。
     */
    if (stillOn === 0) {
      for (const phrase of MISLEADING_AFTER_END) {
        if (md.includes(phrase)) {
          err(
            `「${phrase}」が含まれています。この記事の${items.length}本はすべて配信終了済みで、` +
              '読者は観ることができません。「他のサービスで探せます」の形に書き換えてください。',
          )
        }
      }
      if (/終了します|終了予定です/.test(md)) {
        err('終了を未来形で書いています。全作品が終了済みなので「終了しました」と書きます。')
      }
    }
    if (alreadyOff === 0 && /終了しました/.test(md)) {
      err('終了を過去形で書いています。この記事の作品はまだ観られます（全件が終了予定）。')
    }

    // 見放題とポイントが同居するサービスを含むなら、「もう観られない」と断定できない
    if (items.some((e) => hasLineup(e.service))) {
      for (const phrase of UNAVAILABLE_CLAIM) {
        if (md.includes(phrase)) {
          err(
            `「${phrase}」が含まれています。U-NEXT は見放題が終わってもポイントで残る作品があるため、` +
              '観られなくなると断定できません。「見放題での配信が終了します」に書き換えてください。',
          )
        }
      }
      for (const line of bareDeliveryEnd(md)) {
        warn(`「見放題」を付けずに配信終了と書いています: 「${clip(line, 50)}」`)
      }
    }

    // --- 事故を防ぐ検査 ---
    if (!md.includes('|')) {
      err('対象作品の一覧表がありません。テンプレートの構成3が守られていません。')
    }
    /*
     * ★ 状態列があること。**この記事だけの必須列。**
     *   混在する記事で状態列が落ちると、読者は1行ずつの可否を判断できない。
     */
    if (stillOn > 0 && alreadyOff > 0 && !md.includes('状態')) {
      err(
        '表に「状態」列がありません。この記事は終了予定と終了済みが混ざっているので、' +
          '1行ずつ区別できないと読者を誤らせます。列は「終了日 / 作品 / 状態 / 評価 / サービス」です。',
      )
    }
    const missing = items
      .map((e) => e.work.localizedTitle ?? e.work.title)
      .filter((t) => t && !md.includes(t))
    if (missing.length > 0) {
      err(
        `対象作品リストに載っていない作品が${missing.length}件あります: ` +
          missing
            .slice(0, 8)
            .map((t) => clip(t, 24))
            .join(' / ') +
          (missing.length > 8 ? ' ほか' : ''),
      )
    }
    const asOf = md.match(/[（(](\d{1,2}月\d{1,2}日)時点[）)]/)
    if (!asOf) {
      err(`リードに「（${resolved.asOf}時点）」がありません。いつ時点の情報かを必ず示します。`)
    } else if (asOf[1] !== resolved.asOf) {
      err(`基準日が記事作成日と違います。本文「${asOf[1]}時点」／記事作成日「${resolved.asOf}」。`)
    }

    // --- 固定文言 ---
    for (const [name, text] of [
      ['リードの1文目', resolved.leadFirstSentence],
      ['リードの締め', resolved.leadCloser],
      ['他のサービスで探すの冒頭', resolved.otherServicesIntro],
    ] as const) {
      if (text && !md.includes(text)) {
        err(
          `固定文言（${name}）がそのまま入っていません。fixed-phrases.md の文言をそのまま使ってください。`,
        )
      }
    }
    for (const attribution of resolved.attributions) {
      if (!md.includes(attribution)) {
        err(`記事末尾の出典表記がありません。次の1行をそのまま入れてください:\n      ${attribution}`)
      }
    }

    // --- 文体（止めない） ---
    for (const line of ratingMentionsInProse(md)) {
      warn(`地の文で評価に言及しています: 「${clip(line, 50)}」（評価は表にだけ載せます）`)
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
  topic: string
  leadFirstSentence: string
  leadCloser: string
  otherServicesIntro: string
  /** 素材の出どころが混ざるので配列。**片方だけ書くと出典を偽ることになる。** */
  attributions: string[]
  asOf: string
}

/** 固定文言に値を差し込む。プロンプトと検査で同じ結果になることが要件。 */
function resolvePhrases(items: ChangeEvent[], ctx: ArticleContext): ResolvedPhrases {
  const traits = traitsOf(items, ctx)
  const labelOf = serviceLabels(ctx)
  const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
  const asOf = asOfLabel(ctx)
  const topic = ctx.flags?.topic ?? ''
  const isUpdate = previousAsOf(ctx.flags?.slug ?? '') !== undefined

  const get = phraseReader(fixedPhrases(ctx, REQUIRED_PHRASES), {
    主題: topic,
    サービス: services.length === 2 ? services.join('と') : services.join('・'),
    基準日: asOf,
    本数: items.length,
  })

  /*
   * ★ 更新版の文言を持つのは `leaving` 側だけ。
   *   全作品が終了した記事は「今回新たに終了日が判明した」ということが起きないので、
   *   更新回でも初回と同じ書き出しでよい（`series-ended-lead-first-sentence`）。
   */
  const leadKey =
    isUpdate && traits.leadKey === 'series-lead-first-sentence'
      ? 'series-update-lead-first-sentence'
      : traits.leadKey

  // ★ データの出どころが違えば出典表記も違う。1本の記事に API 由来と
  //   U-NEXT 由来が混ざるので、混ざったぶんだけ全部要る。
  const sourceOf = (e: ChangeEvent) => e.work.meta.source
  const attributions: string[] = []
  if (items.some((e) => sourceOf(e) !== 'u-next')) attributions.push(get('attribution'))
  if (items.some((e) => sourceOf(e) === 'u-next')) attributions.push(get('attribution-unext'))
  if (attributions.length === 0) attributions.push(get('attribution'))

  return {
    topic,
    leadFirstSentence: get(leadKey),
    leadCloser: get(traits.closerKey),
    otherServicesIntro: get('other-services-intro'),
    attributions,
    asOf,
  }
}
