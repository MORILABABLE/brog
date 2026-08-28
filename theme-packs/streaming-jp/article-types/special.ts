/**
 * 記事タイプ: 特報（主題別・その都度の指示で作る）
 *
 * 月次の記事（`leaving` / `ended` / `arrivals` / `arrivals-service`）が
 * **決まった軸で毎月出す**ものなのに対して、この記事タイプは
 * **書きたい主題と時期をそのつど人が決めて出す**。
 *
 *   npm run write -- --type special --kind expiring \
 *     --topic "「007」シリーズ" --slug 007-netflix --match "007|ジェームズ・ボンド" --emit
 *
 * ■ それでもテンプレ通りに作る
 * 「特報だから自由に書く」にすると、月次記事と文体も禁止事項も揃わなくなる。
 * 構成・文体・固定文言・品質ゲートは月次記事と同じ仕組みに載せ、
 * **違うのは「素材の絞り方」と「軸が主題であること」だけ**にしてある。
 *
 * ■ 軸は主題（`axis: 'topic'`）
 * 読者は「あの作品がどこで観られるのか」を探して来る。
 * ジャンル軸と同じ理由で**サービスを横断してよい**し、
 * 1社の話ならタイトルにその社名を出してよい。
 *
 * ■ カテゴリは `--kind` で決まる
 * 同じ記事タイプで「配信開始の特報」も「終了予定の特報」も書くので、
 * `category` を1つに固定できない（`categoryOf()` で切り替える）。
 *
 * ■ 文章の型は2つのファイルに分かれている
 *   templates/special.md          構成と文体のルール
 *   templates/fixed-phrases.md    `special-` で始まる固定文言
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
import { castNames, directorNames, productionCompanies } from '../work-context.ts'
import { classify, GENRES, type GenreKey } from '../genres.ts'
import {
  articleMonth,
  asOfLabel,
  bareDeliveryEnd,
  clip,
  fixedPhrases,
  halfWidthSymbols,
  isTargetMonth,
  itemTitles,
  MISLEADING_AFTER_END,
  namingRules,
  NOT_YET_AVAILABLE_CLAIM,
  normalizeBody,
  peopleLine,
  phraseReader,
  previousAsOf,
  publishable,
  ratingMentionsInProse,
  serviceLabels,
  titleIssues,
  UNAVAILABLE_CLAIM,
} from './shared.ts'

/**
 * 1記事に載せる上限。
 * 特報は絞り込んだ主題を扱うので、月次記事より小さくてよい。
 * これを超えるなら、それは特報ではなく月次記事で扱う範囲。
 *
 * ★ ただし配信開始予定（upcoming）だけは別（`KindTraits.maxItems`）。
 *   素材が**各社が公表したラインナップそのもの**で、これを担当する月次記事が無い。
 *   40件で切ると、公表された一覧より少ない本数を「◯本」と名乗ることになる。
 */
const MAX_ITEMS = 40

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'special-new-lead-first-sentence',
  'special-upcoming-lead-first-sentence',
  'special-leaving-lead-first-sentence',
  'special-ended-lead-first-sentence',
  // 締めは月次記事と同じ役割なので流用する（新しい文言を作らない）
  'arrivals-lead-closer',
  'leaving-lead-closer',
  'ended-lead-closer',
  'other-services-intro',
  'attribution',
  'attribution-unext',
  // 各社の公式発表（配信開始予定）由来の素材に付ける
  'attribution-announcement',
] as const

/**
 * 扱えるイベント種別と、そのときの記事の性格。
 *
 * **`--kind` を必須にしているのは、書き方が正反対になるため。**
 * 「これから終わる」と「もう終わった」を取り違えた記事は読者を裏切る。
 * 人に選ばせて、選んだ結果で検査を切り替える。
 */
interface KindTraits {
  /** 収集データの kind */
  kind: 'new' | 'expiring' | 'removed' | 'upcoming'
  /** frontmatter のカテゴリ */
  category: Category
  /**
   * タイトルに必ず入る言い方（templates/naming.md の表と揃える）。
   * **空文字なら検査しない**（先頭の【】が動詞まで名乗る場合。下の periodSuffix）。
   */
  verbPhrase: string
  /**
   * 先頭の【】に足す語。既定は無しで「【2026年9月】」。
   * `'配信開始'` を渡すと「【2026年9月配信開始】」になる。
   */
  periodSuffix?: string
  /** 素材に出す日付の呼び方 */
  dateLabel: string
  /** リードの1文目に使う固定文言のキー */
  leadKey: string
  /** リードの締めに使う固定文言のキー（月次記事と共用） */
  closerKey: string
  /** 日付が未来のものだけを残すか（true）、過去のものだけか（false）、問わないか（undefined） */
  future?: boolean
  /** 1記事に載せる上限（既定は MAX_ITEMS） */
  maxItems?: number
}

const KINDS: Record<string, KindTraits> = {
  new: {
    kind: 'new',
    category: 'arrivals',
    verbPhrase: '見放題配信開始',
    dateLabel: '配信開始日',
    leadKey: 'special-new-lead-first-sentence',
    closerKey: 'arrivals-lead-closer',
  },
  upcoming: {
    kind: 'upcoming',
    category: 'arrivals',
    /*
     * ★ 先頭の【】が動詞まで名乗る唯一の記事タイプ。
     *
     *   【2026年9月配信開始】Amazon Prime Videoの見放題アニメ10本｜…
     *   【2026年9月】Netflixで見放題配信が終了予定の作品36本｜…
     *
     * 同じ月に「開始」と「終了」の記事が並ぶ。読者が検索結果で見るのは
     * 先頭の数文字なので、そこで**開始と終了を取り違えさせない**。
     * そのぶん本文側の動詞句は求めない（同じことを2回書かせない）。
     */
    verbPhrase: '',
    periodSuffix: '配信開始',
    dateLabel: '配信開始予定日',
    leadKey: 'special-upcoming-lead-first-sentence',
    closerKey: 'arrivals-lead-closer',
    // まだ始まっていないものだけ。始まった作品は new 側で扱う
    future: true,
    // 公表されたラインナップを丸ごと扱う。月次記事（100〜200件）と同じ規模になる
    maxItems: 120,
  },
  expiring: {
    kind: 'expiring',
    category: 'leaving',
    verbPhrase: '見放題配信終了予定',
    dateLabel: '終了日',
    leadKey: 'special-leaving-lead-first-sentence',
    closerKey: 'leaving-lead-closer',
    // まだ終わっていないものだけ。過ぎた作品を「これから終わる」と書かせない
    future: true,
  },
  removed: {
    kind: 'removed',
    category: 'ended',
    verbPhrase: '見放題配信終了',
    dateLabel: '終了日',
    leadKey: 'special-ended-lead-first-sentence',
    closerKey: 'ended-lead-closer',
    // もう終わったものだけ。データが先行することがあるので念のため絞る
    future: false,
  },
}

/** スラッグに使える形。日本語の主題からURLは作れないので、人に決めてもらう。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/

function kindOf(ctx: ArticleContext): KindTraits {
  const key = ctx.flags?.kind ?? ''
  const traits = KINDS[key]
  if (!traits) {
    throw new Error(
      `--kind は ${Object.keys(KINDS).join(' / ')} のいずれかです（指定: ${key || 'なし'}）\n` +
        '  new=配信開始の特報 / upcoming=配信開始予定の特報（まだ始まっていない）\n' +
        '  expiring=終了予定の特報 / removed=終了済みの特報',
    )
  }
  return traits
}

/**
 * `--genre` の値。指定が無ければ undefined（ジャンルで絞らない）。
 *
 * ■ なぜ特報にジャンルの絞り込みがあるか（2026-08-28 追加）
 * 配信開始予定（`--kind upcoming`）の素材は**各社が公表したラインナップ丸ごと**で、
 * 1社ぶんが80件を超える。1本にまとめると読者は自分の観たいものに辿り着けない。
 * ジャンル別記事（`arrivals`）と**同じ3区分**で切って、サービス×ジャンルで出す。
 *
 *   npm run write -- --type special --kind upcoming --service prime-video --genre anime \
 *     --topic "アニメ" --slug prime-video-anime --month 2026-09 --emit
 *
 * ★ 区分を独自に増やさないこと。ジャンルの呼び方がサイト内で2種類になる。
 */
function genreOf(ctx: ArticleContext): GenreKey | undefined {
  const key = ctx.flags?.genre
  if (!key) return undefined
  const known = GENRES.find((g) => g.key === key)
  if (!known) {
    throw new Error(
      `--genre は ${GENRES.map((g) => g.key).join(' / ')} のいずれかです（指定: ${key}）`,
    )
  }
  return key as GenreKey
}

/**
 * タイトル先頭の【】に入れる名乗り。既定は「2026年9月」。
 * 配信開始予定だけ「2026年9月配信開始」になる（KindTraits.periodSuffix）。
 */
function periodLabelOf(ctx: ArticleContext): string {
  const [y, m] = ctx.targetMonth.split('-')
  return `${y}年${Number(m)}月${kindOf(ctx).periodSuffix ?? ''}`
}

/** 見放題とポイントが同居するサービス。「観られなくなる」と書けない */
function hasLineup(service: string): boolean {
  return service === 'u-next'
}

/** 素材のタイトルが最初から邦題か */
function localizedTitles(items: ChangeEvent[]): boolean {
  return items.length > 0 && items.every((e) => e.work.meta.source === 'u-next')
}

export const specialArticle: ArticleType = {
  id: 'special',
  // ★ 主題軸。サービスを横断してよい（ジャンル軸と同じ理由）
  axis: 'topic',
  // 既定値。実際には --kind で決まる（categoryOf）
  category: 'arrivals',
  description: '特報（主題を指定して書く。--kind / --topic / --slug が必要）',

  flags: [
    {
      name: 'kind',
      description:
        'new=配信開始 / upcoming=配信開始予定 / expiring=終了予定 / removed=終了済み',
      required: true,
    },
    { name: 'topic', description: '記事の主題。タイトルと本文にそのまま出る（例: 「007」シリーズ）', required: true },
    { name: 'slug', description: 'URLに使う半角英数字とハイフン（例: 007-netflix）', required: true },
    { name: 'match', description: '作品名で絞る正規表現（例: 007|ジェームズ・ボンド）' },
    { name: 'service', description: '1社に絞る場合のサービスキー（例: netflix）' },
    {
      name: 'genre',
      description: 'ジャンルで絞る（anime / western / japanese）。--match の代わりになる',
    },
    { name: 'from', description: '対象期間の開始日 YYYY-MM-DD（既定は対象月の初日）' },
    { name: 'to', description: '対象期間の終了日 YYYY-MM-DD（既定は対象月の末日）' },
  ],

  categoryOf(ctx) {
    return kindOf(ctx).category
  },

  select(rawEvents, _ledger: Ledger, ctx) {
    // --list ではフラグが渡らない。数えようがないので空で返す（--list 側が「要指示」と出す）
    if (!ctx.flags?.kind) return []
    const traits = kindOf(ctx)

    // ★ 絞り込みを1つも渡さないと「その月の全件」になる。それは月次記事の仕事で、
    //   同じ内容を2本出すと同じ検索語を自分同士で奪い合う。
    //   --service だけでも同じ（1社の当月全件＝月次記事そのもの）なので、
    //   **主題を切り出す条件**（作品名か期間）を必ず1つは求める。
    if (!ctx.flags.match && !ctx.flags.from && !ctx.flags.to && !ctx.flags.genre) {
      throw new Error(
        '特報には絞り込みが要ります。--match / --genre / --from / --to のどれかを指定してください。\n' +
          '  絞り込みが無いとその月の全件になり、それは月次記事（leaving / ended / arrivals…）の担当です。\n' +
          '  例: --match "007|ジェームズ・ボンド"   例: --genre anime   例: --from 2026-09-01 --to 2026-09-01',
      )
    }

    const service = ctx.flags.service
    const genre = genreOf(ctx)
    const match = ctx.flags.match ? new RegExp(ctx.flags.match, 'i') : undefined
    const from = ctx.flags.from ? Date.parse(`${ctx.flags.from}T00:00:00+09:00`) : undefined
    const to = ctx.flags.to ? Date.parse(`${ctx.flags.to}T23:59:59+09:00`) : undefined

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    const events = publishable(rawEvents)

    const target = events
      .filter((e) => e.kind === traits.kind)
      .filter((e) => e.at)
      .filter((e) => !service || e.service === service)
      // 見放題とポイントが同居するサービスでは、ポイント専用作品を外す。
      // 載せると**そもそも見放題ではなかった作品**を扱うことになる。
      .filter((e) => {
        if (!hasLineup(e.service)) return true
        const lineup = e.work.meta.lineup
        return lineup === 'svod' || lineup === 'both'
      })
      // 期間。--from/--to があればその範囲、無ければ対象月まるごと
      .filter((e) => {
        const at = Date.parse(e.at!)
        if (from !== undefined || to !== undefined) {
          return (from === undefined || at >= from) && (to === undefined || at <= to)
        }
        return isTargetMonth(e.at!, ctx)
      })
      // 「これから終わる」と「もう終わった」を取り違えさせない
      .filter((e) => {
        if (traits.future === undefined) return true
        const at = Date.parse(e.at!)
        return traits.future ? at >= ctx.now.getTime() : at <= ctx.now.getTime()
      })
      .filter((e) => {
        if (!match) return true
        const w = e.work
        return match.test(w.title) || (w.localizedTitle ? match.test(w.localizedTitle) : false)
      })
      // ★ ジャンルで判定できなかった作品は**落とす**（classify が undefined を返す）。
      //   邦画記事に海外作品を混ぜるより落とすほうが害が小さい、という
      //   genres.ts の方針をそのまま引き継ぐ。落ちるのはスポーツ・バラエティー等。
      .filter((e) => !genre || classify(e.work) === genre)

    // ★ 同じ作品が複数回収集されている。最初に把握した回を残す。
    //   サービスをまたぐ主題では、同じ作品がサービスごとに1件ずつ出るのは正しいので、
    //   キーに作品とサービスの両方を使う。
    const firstSeen = new Map<string, ChangeEvent>()
    for (const e of target) {
      const key = `${e.service}/${e.work.id}`
      const cur = firstSeen.get(key)
      if (!cur || e.collectedAt < cur.collectedAt) firstSeen.set(key, e)
    }

    const kept = [...firstSeen.values()]
    const max = traits.maxItems ?? MAX_ITEMS
    const limited =
      kept.length <= max
        ? kept
        : [...kept].sort((a, b) => (b.work.rating ?? 0) - (a.work.rating ?? 0)).slice(0, max)

    return limited.sort((a, b) => a.at!.localeCompare(b.at!))
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'special.md'), 'utf8')
    const traits = kindOf(ctx)
    const resolved = resolvePhrases(items, ctx)
    const labelOf = serviceLabels(ctx)
    const offset = ctx.theme.utc_offset_minutes
    const unext = localizedTitles(items)
    const isUpdate = previousAsOf(this.slug(ctx)) !== undefined
    const services = [...new Set(items.map((e) => e.service))]

    const rows = items.map((e) => {
      const w = e.work
      const links = buildSearchLinks(w, (ctx.theme.search_links ?? []).filter((l) => l.key !== e.service))
      const title = w.localizedTitle ?? w.title
      // ★ 邦題と原題が同じ文字列のことがある（U-NEXT・公式発表は最初から邦題で、
      //   原題を持たない）。そのまま出すと「◯◯（原題: ◯◯）」になるので出さない。
      const note = !w.localizedTitle
        ? '（★邦題が未確認。この原題のまま書くこと）'
        : w.localizedTitle === w.title
          ? ''
          : `（原題: ${w.title}）`

      return [
        `- ${title}${note ? ` ${note}` : ''}`,
        `  サービス: ${labelOf.get(e.service) ?? e.service}`,
        `  ${traits.dateLabel}: ${formatMonthDay(e.at!, offset)}`,
        w.year ? `  公開年: ${w.year}年` : '',
        w.rating ? `  評価: ${w.rating}/100（★表にだけ書き、地の文には書かないこと）` : '',
        w.genres.length ? `  ジャンル: ${w.genres.join(' / ')}` : '',
        hasLineup(e.service) && w.meta.lineup === 'both'
          ? '  ★見放題は終了するが、ポイント（レンタル・購入）での取り扱いは続く'
          : '',
        // 告知に書かれていた区分（独占配信・見放題独占配信 など）。
        // ★ 記事で「独占」と書けるのはこの行がある作品だけ。無い作品に付けない。
        typeof w.meta.note === 'string' && w.meta.note ? `  告知の区分: ${w.meta.note}` : '',
        productionCompanies(w)?.length ? `  制作: ${productionCompanies(w)!.join(' / ')}` : '',
        peopleLine('監督', directorNames(w)),
        peopleLine('出演', castNames(w), true),
        w.overview ? `  あらすじ(英語原文): ${w.overview}` : '  あらすじ: ★未提供（内容を推測して書かないこと）',
        links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
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

# この記事の主題

**${resolved.topic}**

この記事は**主題を軸にした特報**です。月次のまとめ記事ではありません。
${
  services.length > 1
    ? `対象は ${services.map((s) => labelOf.get(s) ?? s).join(' / ')} の${services.length}社にまたがります。**主題の記事なので横断して構いません。**`
    : `対象は ${labelOf.get(services[0] ?? '') ?? '対象サービス'} の1社です。他社の配信状況は分かりません。`
}

タイトルは **【${periodLabelOf(ctx)}】で始め**、主題（${resolved.topic}）を必ず入れてください。
${
  traits.verbPhrase
    ? `そのうえで「${traits.verbPhrase}」も必ず入れてください。`
    : `先頭の【】が「配信開始」まで名乗るので、**動詞句を重ねて書かないでください**。
かわりに **「見放題」の3文字を必ず入れてください**（購入・レンタルと区別するため）。
  例: 【${periodLabelOf(ctx)}】${labelOf.get(services[0] ?? '') ?? 'サービス名'}の見放題${resolved.topic}${items.length}本｜（見どころ）`
}
${
  isUpdate
    ? `**この記事には前の版があります。** 本数の直後に 【${resolved.asOf}更新】 を置いてください。`
    : '**「更新」と書かないでください。** 前の版がありません。'
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
   月次のまとめ記事ではないので、「今月の配信終了作品一覧」のような書き方はしない。`,
      `**各セクションは「見出し → 表 → 解説」の順に書くこと。**
   表の列は「${traits.dateLabel} / 作品 / 評価 / サービス」の4列で固定してください。
   **サービス列を省かないでください**（サイトが行のサービス名を読んでリンクを付けます）。`,
      `**対象作品リストの節に、下の${items.length}件を1件残らず表に載せること。**`,
      `**評価スコアは表にだけ書き、地の文には一切書かないこと。**`,
      traits.kind === 'removed'
        ? `**もう観られない作品であることを、絶対に取り違えないこと。**
   「お見逃しなく」「今のうちに」「観ておきましょう」「配信中です」は使用禁止です。
   終了は必ず過去形（「終了しました」）で書いてください。`
        : traits.kind === 'expiring'
          ? `終了日は確定情報です。**急かすのは終了日という事実の提示までとし、視聴を命令しないこと。**`
          : traits.kind === 'upcoming'
            ? `**まだ配信が始まっていない作品です。取り違えないこと。**
   「配信中です」「配信が始まりました」「今すぐ観られます」は使用禁止。
   配信開始は必ず未来形（「◯月◯日から配信開始予定です」）で書いてください。
   **日付は各社の告知にもとづく予定**であって、変更されることがあります。
   確定した事実のように「必ず」「決定」と書かないでください。
   **急かさないこと。** 配信開始には締切がありません。編集部のおすすめも書かない。`
            : `**急かさないこと。** 配信開始には締切がありません。
   「ぜひ観ましょう」「見逃せません」は書かない。編集部のおすすめも書かない。`,
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

    const prompt = `「${resolved.topic}」の特報記事のデータです。全${items.length}件。

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
    const [y, m] = ctx.targetMonth.split('-')
    const kindTag = {
      new: '配信開始',
      upcoming: '配信開始予定',
      expiring: '配信終了',
      removed: '配信終了済み',
    }[kindOf(ctx).kind]
    return [...services, kindTag, '特報', `${y}年${Number(m)}月`].filter(Boolean)
  },

  slug(ctx) {
    // ★ --list と重複チェックはフラグ無しで呼ぶ。落とさずに形だけ返す。
    const given = ctx.flags?.slug
    if (!given) return `${ctx.targetMonth}-special-<slug>`
    if (!SLUG_PATTERN.test(given)) {
      throw new Error(
        `--slug は半角英数字とハイフンで書いてください（2〜49文字・先頭は英数字）: ${given}\n` +
          '  日本語の主題からURLは作れないので、ここだけは人が決めます。例: --slug 007-netflix',
      )
    }
    return `${ctx.targetMonth}-special-${given}`
  },

  verifyTitle(title, ctx) {
    const traits = kindOf(ctx)
    const issues = titleIssues(title, ctx, {
      axis: 'topic',
      verbPhrase: traits.verbPhrase,
      periodLabel: periodLabelOf(ctx),
      axisLabel: ctx.flags?.topic,
      isUpdate: previousAsOf(this.slug(ctx)) !== undefined,
      // 1作品だけの特報がありうるので本数は求めない
      requiresCount: false,
    })

    // ★ 先頭の【】から動詞句の検査を外したぶん、**見放題であることは必ず名乗らせる。**
    //   「配信」だけだと購入・レンタルと区別が付かない（naming.md の決まり）。
    if (traits.kind === 'upcoming' && !title.includes('見放題')) {
      issues.push({
        level: 'error',
        message:
          'タイトルに「見放題」がありません。購入・レンタルと区別できないタイトルは作りません。' +
          '例:【2026年9月配信開始】Amazon Prime Videoの見放題アニメ10本｜…',
      })
    }

    // ★ 「見放題配信終了予定」は「見放題配信終了」を**文字列として含む**ので、
    //   終了済みの特報に終了予定のタイトルを付けても動詞句の検査は通ってしまう。
    //   終了済みを「これから終わる」と読ませるのは読者を直接裏切るので、ここで止める。
    if (traits.kind === 'removed' && title.includes('終了予定')) {
      issues.push({
        level: 'error',
        message:
          'タイトルが「終了予定」になっていますが、--kind removed は**すでに終了した**作品の特報です。' +
          '「見放題配信終了」と書いてください。',
      })
    }

    // ★ 裏返しの取り違え。「見放題配信開始予定」は「見放題配信開始」を含むので、
    //   開始済みの特報に予定のタイトルを付けても動詞句の検査は通ってしまう。
    if (traits.kind === 'new' && title.includes('配信開始予定')) {
      issues.push({
        level: 'error',
        message:
          'タイトルが「配信開始予定」になっていますが、--kind new は**すでに配信が始まった**作品の特報です。' +
          '「見放題配信開始」と書いてください。',
      })
    }
    return issues
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)
    const issues: VerifyIssue[] = []
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const traits = kindOf(ctx)
    const resolved = resolvePhrases(items, ctx)

    // --- 主題から離れていないか ---
    if (resolved.topic && !md.includes(resolved.topic.replace(/[「」『』]/g, ''))) {
      warn(`本文に主題（${resolved.topic}）がそのまま出てきません。特報は主題の記事です。`)
    }

    // --- kind の取り違え（この記事タイプの生命線） ---
    if (traits.kind === 'removed') {
      for (const phrase of MISLEADING_AFTER_END) {
        if (md.includes(phrase)) {
          err(
            `「${phrase}」が含まれています。--kind removed の特報は既に配信終了した作品を扱うので、` +
              '読者は観ることができません。「他のサービスで探せます」の形に書き換えてください。',
          )
        }
      }
      if (/終了します|終了予定です/.test(md)) {
        err('終了を未来形で書いています。--kind removed は終了済みなので「終了しました」と書きます。')
      }
    }
    if (traits.kind === 'expiring' && /終了しました/.test(md)) {
      err('終了を過去形で書いています。--kind expiring はこれから終わる作品です。')
    }
    // --- 「まだ始まっていない」を「もう観られる」と読ませない ---
    if (traits.kind === 'upcoming') {
      for (const phrase of NOT_YET_AVAILABLE_CLAIM) {
        if (md.includes(phrase)) {
          err(
            `「${phrase}」が含まれています。--kind upcoming の特報は**まだ配信が始まっていない**作品を扱います。` +
              '読者はいま観に行っても観られません。「◯月◯日から配信開始予定です」の形に書き換えてください。',
          )
        }
      }
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
    const missing = items
      .map((e) => e.work.localizedTitle ?? e.work.title)
      .filter((t) => t && !md.includes(t))
    if (missing.length > 0) {
      err(
        `対象作品リストに載っていない作品が${missing.length}件あります: ` +
          missing.slice(0, 8).map((t) => clip(t, 24)).join(' / ') +
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
        err(`固定文言（${name}）がそのまま入っていません。fixed-phrases.md の文言をそのまま使ってください。`)
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
  /** 素材の出どころが混ざる月があるので配列。**片方だけ書くと出典を偽ることになる。** */
  attributions: string[]
  asOf: string
}

/** 固定文言に値を差し込む。プロンプトと検査で同じ結果になることが要件。 */
function resolvePhrases(items: ChangeEvent[], ctx: ArticleContext): ResolvedPhrases {
  const traits = kindOf(ctx)
  const labelOf = serviceLabels(ctx)
  const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
  const asOf = asOfLabel(ctx)
  const topic = ctx.flags?.topic ?? ''

  // 公式発表の出典表記に出す告知元（About Amazon など）。
  // 素材に告知が無ければ空文字で、その表記自体も使われない。
  const publishers = [
    ...new Set(
      items
        .filter((e) => e.work.meta.source === 'announcement')
        .map((e) => String(e.work.meta.publisher ?? ''))
        .filter(Boolean),
    ),
  ]

  const get = phraseReader(fixedPhrases(ctx, REQUIRED_PHRASES), {
    月: articleMonth(ctx),
    主題: topic,
    サービス: services.length === 2 ? services.join('と') : services.join('・'),
    基準日: asOf,
    本数: items.length,
    告知元: publishers.join('・'),
  })

  // ★ データの出どころが違えば出典表記も違う。主題によっては1本の記事に
  //   API 由来・U-NEXT 由来・公式発表由来が混ざるので、混ざったぶんだけ全部要る。
  //   **「u-next 以外はAPI」と書いてはいけない。** 公式発表の告知まで
  //   API 由来に落ちてしまい、取得していないAPIを出典として偽ることになる。
  const sourceOf = (e: ChangeEvent) => e.work.meta.source
  const attributions: string[] = []
  if (items.some((e) => sourceOf(e) !== 'u-next' && sourceOf(e) !== 'announcement')) {
    attributions.push(get('attribution'))
  }
  if (items.some((e) => sourceOf(e) === 'u-next')) attributions.push(get('attribution-unext'))
  if (items.some((e) => sourceOf(e) === 'announcement')) {
    attributions.push(get('attribution-announcement'))
  }
  if (attributions.length === 0) attributions.push(get('attribution'))

  return {
    topic,
    leadFirstSentence: get(traits.leadKey),
    leadCloser: get(traits.closerKey),
    otherServicesIntro: get('other-services-intro'),
    attributions,
    asOf,
  }
}
