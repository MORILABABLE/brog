/**
 * 記事タイプ: シリーズ（主題別・**月を名乗らない唯一の記事**）
 *
 *   npm run write -- --type series --topic "「名探偵コナン」劇場版シリーズ" --slug conan-movies --match "名探偵コナン" --emit
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
import { liveElsewhere } from '../../../pipeline/core/cross-service.ts'
import { readAllEventsSync } from '../../../pipeline/core/events.ts'
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
  'series-returned-lead-first-sentence',
  'series-ended-lead-first-sentence',
  'series-unext-note',
  'other-services-intro',
  'attribution',
  'attribution-unext',
] as const

/**
 * 同じ作品を、サービスごとの表記ゆれを越えて突き合わせるためのキー。
 *
 * ■ なぜ要るのか
 * 同じ映画がサービスごとに違う題で入っている。
 *
 *     Netflix  名探偵コナン ベイカー街の亡霊
 *     U-NEXT   劇場版 名探偵コナン ベイカー街（ストリート）の亡霊
 *
 * 素材はサービスごとに1件ずつ持つ（終了日が別々に決まるので、それが正しい）。
 * だが**表に2行出すと、読者には別の作品に見える。**
 * 記事側で1行にまとめられるように、検査の側で同じ作品だと分かるようにする。
 *
 * ★ **突き合わせに使うだけで、記事に出す題は変えない。** 表記を正規化して
 *   表示すると、どちらのサービスの呼び方でもない題が生まれる。
 * ★ 一致に使うのは**この記事の素材どうし**だけ（`verify` の使い方を参照）。
 *   外の作品と当てないので、正規化が多少ゆるくても別作品を巻き込まない。
 */
const TITLE_PREFIX = /^(劇場版|総集編|TVシリーズ特別編集版|テレビシリーズ特別編集版)/

function workKey(title: string): string {
  let s = title
    // ルビ・別題（（サブマリン）(ラブレター) など）
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[「」『』]/g, '')
    .replace(/[～〜―—\-－]/g, '')
    .replace(/[\s　]/g, '')
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(TITLE_PREFIX, '')
  }
  return s
}

/**
 * この記事がいまどちら向きの記事なのか。**素材から決まる。**
 *
 * `leaving`  … まだ終わっていない作品が1本でもある。「いつまで観られるか」の記事
 * `returned` … 終了予定は無いが、**外れたあとに見放題へ戻った作品**がある
 * `ended`    … 全部終わっている。「いつまで観られたか」の記事
 *
 * ★ 途中で入れ替わる。コナンの27本が全部終われば、次に書き直したとき
 *   同じURLのまま `ended` の記事になる。**それが正しい挙動。**
 *
 * ★ **入れ替わりは一方通行ではない**（2026-08-31 に `returned` を追加）。
 *   終了した作品が別のサービスで見放題に戻ることが実際にある。
 *   1か月ぶんの観測でも4件あった（docs/KEYWORDS.md 3-1）。
 *
 *     トランスフォーマー/最後の騎士王  Disney+ で終了(8/10) → Amazon Prime Video に復帰(8/17)
 *     ブラックベリー                  Netflix で終了(8/13) → Amazon Prime Video に復帰(8/17)
 *     ピンクパンサー / ピンクパンサー2  Amazon Prime Video で終了(8/17) → Netflix に復帰(8/20・8/24)
 *
 *   `ended` にしたまま戻せないと、**また観られる作品を「もう観られません」と
 *   書き続ける**ことになる。ここが唯一その嘘を止められる場所。
 *
 * ★ 復帰したあとに新しい終了日が付けば、そのサービスの観測が最新になるので
 *   `leaving` に戻る（`select()` の `latest`）。**3つの状態を行き来する。**
 */
type Stance = 'leaving' | 'returned' | 'ended'

interface StanceTraits {
  category: Category
  /** templates/naming.md の表と1文字も違えないこと */
  verbPhrase: string
  leadKey: string
}

/**
 * ★ **リードの締め（`*-lead-closer`）を持たない。**
 *   月次記事は「1文目＝要点」「締め＝行動の促し」の2本立てだが、
 *   シリーズ記事は1文目の末尾に行動の促しを畳み込んである（fixed-phrases.md）。
 *   両方置くと「チェックしましょう」を2回言うことになる（2026-08-30 の添削）。
 */
const STANCES: Record<Stance, StanceTraits> = {
  leaving: {
    category: 'leaving',
    verbPhrase: '見放題配信が終了予定の',
    leadKey: 'series-lead-first-sentence',
  },
  /*
   * ★ カテゴリだけ `arrivals`（新着配信）になる。**それでよい。**
   *   このとき記事が読者に渡すのは「終わったこと」ではなく
   *   「また観られるようになったこと」で、用事が新着配信の記事と同じになる。
   *   バッジも一覧（ハブ）も、そちらへ移るのが正しい
   *   （site/src/config.ts の CATEGORY_HUBS）。
   *
   * ★ 動詞句を「見放題配信が復帰した」にしないこと。作品が主語なら復帰でよいが、
   *   タイトルの主語は配信なので「再開」になる（naming.md の表と揃えること）。
   */
  returned: {
    category: 'arrivals',
    verbPhrase: '見放題配信が再開した',
    leadKey: 'series-returned-lead-first-sentence',
  },
  ended: {
    category: 'ended',
    verbPhrase: '見放題配信が終了した',
    leadKey: 'series-ended-lead-first-sentence',
  },
}

/**
 * **読者から見た作品数。** タイトルとリードの「◯本」はこの数を使う。
 *
 * ■ なぜ素材の件数（`items.length`）ではないのか
 * 素材はサービスごとに1件ずつ持っている（終了日が別々に決まるので、それが正しい）。
 * だが**記事の表では同じ作品を1行にまとめる決まり**（`templates/series.md`）なので、
 * 素材の件数をそのまま名乗ると、**読者が表で数えられる行数と合わない。**
 *
 *   素材 6件（トランスフォーマー実写5作＋『最後の騎士王』が2社ぶん）
 *   表   5行
 *   → 「作品6本」と名乗ると、読者は表を数え直して1本足りないと感じる
 *
 * 2026-08-31 の添削で決めた。ズレを本文で説明する手もあるが、
 * **説明そのものが読者には冗長で、記事の流れを切る。**
 * 「なぜ数字がずれるのか」は運営の都合であって、読者の用ではない。
 * **統合した数を名乗り、ズレを作らない。**
 *
 * ★ 突き合わせは `workKey`（題の正規化）で、`work.id` ではない。
 *   **表を1行にまとめる判定と同じものを使う**のがここでの正しさ。
 *   サービスごとに違う題で入っている同じ映画（`名探偵コナン ベイカー街の亡霊` /
 *   `劇場版 名探偵コナン ベイカー街（ストリート）の亡霊`）は `work.id` が別々なので、
 *   IDで数えると表の行数とまた合わなくなる。
 */
function workCount(items: ChangeEvent[]): number {
  return new Set(items.map((e) => workKey(e.work.localizedTitle ?? e.work.title))).size
}

/**
 * **見放題に復帰した観測**を選び出す。返すのは「復帰」と見なす `new` の集合。
 *
 * ■ なぜ要るのか
 * この記事タイプは同じURLを何か月も書き直す。作品が全部終われば `ended` になるが、
 * **終わった作品が別のサービスで見放題に戻ることが実際にある。**
 * `removed` の観測は消えないので、戻せる仕組みが無いと
 * 記事は永久に「もう観られません」と言い続ける（`Stance` の説明の4件）。
 *
 * ■ 何をもって「復帰」とするか
 * **同じ作品（`work.id`）について、見放題から外れたと分かったあとに、
 * 見放題に入った観測がある**こと。サービスは問わない。
 *
 *   外れた … `removed` の観測／`expiring` のうち終了日が過ぎているもの
 *   入った … `new` の観測
 *
 * ★ **サービスをまたいでよい。** 実測4件のうち3件は別のサービスへの移動で、
 *   同じサービスへ戻った例は無かった。読者にとっては
 *   「どこかでまた観られる」ことが要点で、戻り先が同じ社かどうかは用ではない。
 *
 * ★ 突き合わせは `work.id`（配信APIの作品ID）で、`workKey`（題の正規化）ではない。
 *   復帰は「同じ作品が戻った」と言い切れるときだけ立てたい。
 *   題の正規化は表を1行にまとめるための緩い判定なので、ここに使うと
 *   別作品を復帰に見せる事故が起きる。**U-NEXT は自前IDなので混ざらない。**
 *
 * ■ 前後は「観測した順」で見る（`collectedAt`）
 * 配信開始日（`at`）ではなく、**当サイトがそれを把握した順**で並べる。
 * `at` は各社の申告で、遡って埋まることがある。観測順なら
 * 「終了を伝えたあとに、また観られると伝えた」という**読者に見えていた順**になる。
 *
 * ★ 復帰したあとに新しい終了日が付いたら、`select()` の `latest` が
 *   そちらを最新として残すので、この `new` は表に出ない。
 *   **記事は自動で `leaving` に戻る。** それが正しい（`Stance` の説明）。
 */
function revivals(matched: ChangeEvent[]): Set<ChangeEvent> {
  const byWork = new Map<string, ChangeEvent[]>()
  for (const e of matched) {
    const k = String(e.work.id)
    byWork.set(k, [...(byWork.get(k) ?? []), e])
  }

  const out = new Set<ChangeEvent>()
  for (const events of byWork.values()) {
    for (const n of events) {
      if (n.kind !== 'new') continue
      /*
       * その `new` を観測した時点で、**すでに見放題から外れていた**か。
       *   `removed`  … 外れたことを直接観測している
       *   `expiring` … 予告した終了日が、この `new` を観測する前に過ぎている
       * `expiring` を collectedAt だけで見てはいけない（予告は終了日より前に来る）。
       */
      const wasOff = events.some(
        (e) =>
          e.collectedAt < n.collectedAt &&
          (e.kind === 'removed' ||
            (e.kind === 'expiring' && Date.parse(e.at!) < Date.parse(n.collectedAt))),
      )
      if (wasOff) out.add(n)
    }
  }
  return out
}

/** 表の「状態」列にそのまま出る3つの値。**ここ以外に状態の呼び方を作らないこと。** */
type State = '終了予定' | '終了済み' | '見放題に復帰'

/**
 * 1件の観測が、いま読者にとってどういう状態か。
 *
 * ★ `new` がここに来るのは**復帰と判定されたものだけ**（`select()` の `revivals`）。
 *   ふつうの `new`（ただの配信開始）は素材に入らないので、
 *   この関数が「見放題に復帰」を返すのは復帰の観測に限られる。
 */
function stateOf(e: ChangeEvent, now: Date): State {
  if (e.kind === 'new') return '見放題に復帰'
  if (e.kind === 'removed') return '終了済み'
  return Date.parse(e.at!) >= now.getTime() ? '終了予定' : '終了済み'
}

/**
 * 記事の向きを素材から決める。**上から順に見る（優先順位がある）。**
 *
 *   1. 終了予定が1本でもある      → `leaving`  「いつまで観られるか」
 *   2. 無いが、復帰が1本でもある  → `returned` 「また観られるようになった」
 *   3. どちらも無い               → `ended`    「いつまで観られたか」
 *
 * ★ 1 が 2 より先。終了予定と復帰が混ざる記事（復帰したあと別の作品が
 *   終わりかけている、など）で読者にとって急ぐ理由があるのは締切のほう。
 */
function stanceOf(items: ChangeEvent[], ctx: ArticleContext): Stance {
  const states = items.map((e) => stateOf(e, ctx.now))
  if (states.includes('終了予定')) return 'leaving'
  if (states.includes('見放題に復帰')) return 'returned'
  return 'ended'
}

/** 状態ごとの本数。プロンプトと品質ゲートが同じ数え方を使うための1か所。 */
function tally(items: ChangeEvent[], ctx: ArticleContext): Record<State, number> {
  const out: Record<State, number> = {
    終了予定: 0,
    終了済み: 0,
    見放題に復帰: 0,
  }
  for (const e of items) out[stateOf(e, ctx.now)] += 1
  return out
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

  /*
   * ★ **この記事タイプだけが書き直しどきを持つ。**
   *   月を名乗らないURLを何か月も書き直すので、終了予定だった作品が
   *   終了済みになった時点で、書き直すまで記事だけが古い事実を言い続ける。
   *   宣言しておくと `npm run write -- --refresh` と毎日の通知が拾う
   *   （`pipeline/core/stale.ts`）。
   */
  evergreen: true,

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

    /** 主題に当たる観測。**`new` も残す**（下の復帰の判定に要る） */
    const matched = events
      .filter((e) => e.at)
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

    const revived = revivals(matched)

    const target = matched
      // 「いつまで」に答えられる観測と、**復帰の観測**だけ。
      // ただの `new`（終了日が分からない配信開始）と `upcoming` は載せない（冒頭の理由）
      .filter((e) => e.kind === 'expiring' || e.kind === 'removed' || revived.has(e))
      .filter((e) => !service || e.service === service)

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
     * 並びは「まだ観られるものが先、日付の早い順」。
     * 読者が最初に知りたいのは締切の近い作品で、終了済みは後ろでよい。
     *
     * ★ 復帰は終了予定と終了済みのあいだ。締切がある作品ほどは急がないが、
     *   **もう観られない作品より先に見せる**（また観られる、が要点なので）。
     */
    const ORDER: Record<State, number> = {
      終了予定: 0,
      見放題に復帰: 1,
      終了済み: 2,
    }
    return limited.sort((a, b) => {
      const d = ORDER[stateOf(a, ctx.now)] - ORDER[stateOf(b, ctx.now)]
      if (d !== 0) return d
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
    const count = tally(items, ctx)
    const stillOn = count['終了予定']
    const alreadyOff = count['終了済み']
    const backOn = count['見放題に復帰']

    /*
     * 同じ作品が複数サービスに出ているか。**表を1行にまとめてよい印**を素材に付ける。
     * 判定は `workKey`（サービスごとの表記ゆれを吸収する）。
     */
    const spread = new Map<string, string[]>()
    for (const e of items) {
      const k = workKey(e.work.localizedTitle ?? e.work.title)
      spread.set(k, [...new Set([...(spread.get(k) ?? []), e.service])])
    }

    /*
     * 復帰した観測ごとに、**その前に見放題から外れていたサービス**。
     * 素材に「どこで終わってどこへ戻ったか」を1行で渡すために使う。
     * 突き合わせは `work.id`（`revivals()` と同じ理由で、題の正規化を使わない）。
     */
    const leftBefore = new Map<ChangeEvent, string[]>()
    for (const e of items) {
      if (stateOf(e, ctx.now) !== '見放題に復帰') continue
      const from = items
        .filter((o) => o.work.id === e.work.id && stateOf(o, ctx.now) === '終了済み')
        .map((o) => o.service)
      leftBefore.set(e, [...new Set(from)])
    }

    /*
     * 復帰した作品の**戻り先**。終了済みの行のほうに出す。
     *
     * ★ この作品には「まとめてよい」の印（下の alsoOn）を出してはいけない。
     *   終了済みの行と復帰の行は**別の事実**で、1行にまとめると
     *   「終わった」と「戻った」のどちらなのか読者に分からなくなる。
     */
    const revivedTo = new Map<string, string[]>()
    for (const [e, _from] of leftBefore) {
      revivedTo.set(String(e.work.id), [
        ...new Set([...(revivedTo.get(String(e.work.id)) ?? []), e.service]),
      ])
    }

    const rows = items.map((e) => {
      const w = e.work
      const state = stateOf(e, ctx.now)
      const alsoOn = (spread.get(workKey(w.localizedTitle ?? w.title)) ?? []).filter(
        (sv) => sv !== e.service,
      )
      /*
       * ★ **復帰した作品が、どこで終わっていたか。**
       *   同じ作品の「終了済み」の行と、この「見放題に復帰」の行は
       *   **まとめてはいけない**（別々の事実で、日付の意味も違う）。
       *   まとめてよい印（下の alsoOn）を出さず、代わりにこれを出す。
       */
      const leftFrom = leftBefore.get(e) ?? []
      /** この作品が復帰した先。終了済みの行に出す（復帰の行では空） */
      const backTo = state === '見放題に復帰' ? [] : (revivedTo.get(String(w.id)) ?? [])
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
        state === '見放題に復帰'
          ? `  ★この作品は${leftFrom.length ? leftFrom.map((sv) => labelOf.get(sv) ?? sv).join(' / ') + 'で' : ''}見放題が終わったあと、ここで見放題に戻っています（**終了済みの行とまとめず、別の行にすること**）`
          : backTo.length
            ? `  ★この作品はそのあと ${backTo.map((sv) => labelOf.get(sv) ?? sv).join(' / ')} で見放題に復帰しています（**復帰の行と1行にまとめないこと**。終わったことと戻ったことは別の事実です）`
            : alsoOn.length
              ? `  ★同じ作品が ${alsoOn.map((sv) => labelOf.get(sv) ?? sv).join(' / ')} にもあります（表では1行にまとめ、サービス列に両方を書いてよい）`
              : '',
        `  状態: ${state}`,
        /*
         * ★ **復帰の行に終了日は無い。** `at` は配信**開始**日なので、
         *   終了日として出すと真逆の日付を表に書かせることになる。
         *   次の終了日が付いたら、その観測が最新になって行ごと入れ替わる。
         */
        state === '見放題に復帰'
          ? `  復帰日: ${formatMonthDay(e.at!, offset)}（★終了日は未定。表の終了日の欄には「—」と書くこと）`
          : `  終了日: ${formatMonthDay(e.at!, offset)}`,
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

  例: 【保存版】${resolved.topic}の${traits.verbPhrase}作品${workCount(items)}本｜（見どころ）
${
  workCount(items) !== items.length
    ? `
**本数は「${workCount(items)}本」です。素材の件数（${items.length}件）ではありません。**
同じ作品が複数のサービスにあるため、素材は${items.length}件・作品は${workCount(items)}本になります。
表では同じ作品を1行にまとめるので、**読者が数えられるのは${workCount(items)}のほう**です。
リードの固定文言も${workCount(items)}本になっています。

**このズレを本文で説明しないでください。**「件数が${items.length}本になっているのは〜」のような
断り書きは読者には冗長で、記事の流れを切ります。統合した数だけを名乗ってください。
`
    : ''
}
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
| 一度終わったあと見放題に戻った（見放題に復帰） | ${backOn}本 |

${
  [stillOn, alreadyOff, backOn].filter((n) => n > 0).length > 1
    ? `**この記事には複数の状態が混ざっています。** 表の「状態」列で1行ずつ区別し、
地の文でも取り違えないでください。終了済みの作品に「お見逃しなく」と書いてはいけません。`
    : stillOn > 0
      ? '**全作品がまだ観られます。** 「終了しました」と過去形で書かないでください。'
      : backOn > 0
        ? '**全作品が見放題に戻っています。** 「もう観られません」と書かないでください。'
        : '**全作品がすでに終了しています。** 「お見逃しなく」「今のうちに」は書けません。'
}${
      backOn > 0
        ? `

**「見放題に復帰」の${backOn}本は、いま観られます。** 一度見放題から外れたあと、
素材に書かれたサービスで見放題での取り扱いが再び始まった作品です。

- 表の**終了日の欄は「—」**にしてください。次の終了日はまだ分かりません
- 「終了しました」と書かないでください。**戻ってきたことがこの行の要点**です
- **いつまで観られるかは書けません。** 「◯月まで」「当面は観られます」と書かないこと
- 復帰の理由（契約・権利）を推測しないでください`
        : ''
    }

---

# 今回そのまま使う固定文言

以下は**一字一句そのまま**本文に入れてください。言い換え・要約・記号の変更をしてはいけません。

## リードの1文目（本文の冒頭）

${resolved.leadFirstSentence}

${
  resolved.unextNote
    ? `## U-NEXTの但し書き（U-NEXTの表のすぐ後ろに置く）

${resolved.unextNote}

`
    : ''
}## 「他のサービスで探す」の冒頭

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
      `**対象作品リストの節に、下の${items.length}件を1件残らず表に載せること。**${
        workCount(items) !== items.length
          ? `
   同じ作品が複数サービスにあるので、**作品の数は${workCount(items)}本**です。
   タイトルとリードで名乗るのはこちらの数で、**ズレの理由は本文に書きません。**`
          : ''
      }`,
      `**評価スコアは表にだけ書き、地の文には一切書かないこと。**`,
      alreadyOff > 0
        ? `**終了済みの${alreadyOff}本を「これから終わる」と書かないこと。**
   その作品には「お見逃しなく」「今のうちに」「観ておきましょう」「配信中です」を使えません。
   終了は過去形（「終了しました」）で書いてください。`
        : '',
      stillOn > 0
        ? `終了日は確定情報です。**急かすのは終了日という事実の提示までとし、視聴を命令しないこと。**`
        : '',
      backOn > 0
        ? `**見放題に復帰した${backOn}本を、終了済みの行とまとめないこと。**
   一度見放題から外れたあと、素材のサービスで見放題に戻った作品です。
   終了日は分からないので、表の終了日の欄は「—」にし、
   **「いつまで観られるか」を書かないでください**（推測になります）。`
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

  /**
   * ★ **同じ作品を指す別の題が本文にあれば「載っている」と見なす。**
   *   同じ映画がサービスごとに違う題で入っているので（`workKey` の説明）、
   *   記事側は表に1回だけ出す。既定の判定のままだと、
   *   正しく書いた記事に毎回「取りこぼし」の警告が出る。
   *
   *   突き合わせるのは**この記事の素材どうし**だけなので、別作品を巻き込まない。
   */
  mentions(item, body, items) {
    const key = workKey(item.work.localizedTitle ?? item.work.title)
    return items
      .filter((e) => workKey(e.work.localizedTitle ?? e.work.title) === key)
      .some((e) => body.includes(e.work.localizedTitle ?? e.work.title))
  },

  /**
   * ★ **題の正規化で突き合わせる**（`ArticleType.sameWork` の説明）。
   *   同じ映画がサービスごとに違うIDで入っているので、既定の `work.id` 一致では
   *   「Netflixで終わったが U-NEXT にはまだある」を1件も拾えない。
   *
   * ★ 使い道は**警告を出すためだけ**（`core/cross-service.ts`）。
   *   表の行をまとめる `mentions` と同じ緩さの判定なので、
   *   **これを根拠に「配信中」と書かせてはいけない。**
   *   復帰（`revivals()`）が `work.id` のままなのは、あちらが
   *   記事の状態そのものを動かすため。**判定の重さで使い分けている。**
   */
  sameWork(a, b) {
    return workKey(a.work.localizedTitle ?? a.work.title) === workKey(b.work.localizedTitle ?? b.work.title)
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

    // ★ STANCES から作る。状態を増やしたときにここを直し忘れると、
    //   正しく書いた記事がタイトル検査で落ちる。
    const verbs = Object.values(STANCES).map((t) => t.verbPhrase)
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
    const count = tally(items, ctx)
    const stillOn = count['終了予定']
    const alreadyOff = count['終了済み']
    const backOn = count['見放題に復帰']
    // 他社に生きている観測を知らせるときのサービス名（下の liveElsewhere）
    const labelOf = serviceLabels(ctx)

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
    /*
     * ★ **復帰が1本でもあれば、この検査は掛けない。**
     *   「配信中です」「今のうちに」は、戻ってきた作品については事実。
     *   全作が終了済みのときだけ禁じる（それが元々の趣旨）。
     */
    if (stillOn === 0 && backOn === 0) {
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

      /*
       * ★ **「終了しました」と書く直前に、他社に生きている観測が無いかを見る。**
       *
       *   この記事の素材は主題に当たる観測だけで、**他社での配信開始は入らない**
       *   （`select()` は expiring / removed / 復帰しか残さない）。
       *   そのため「Netflixで終了、しかしAmazon Prime Videoでは配信開始を観測したまま」
       *   という作品があっても、記事は素材の範囲で「終了しました」と書いてしまう。
       *
       * ★ **warn。公開は止めない。** 観測しているのは変化であって在庫ではないので、
       *   「他社で配信中」とは言い切れない（`core/cross-service.ts` の説明）。
       *   止めると、正しく終了した記事まで出せなくなる。
       *   運用者に「確かめる材料」を渡すところまでが役目。
       */
      for (const hit of liveElsewhere(items, readAllEventsSync(), ctx.now, this.sameWork)) {
        const title = hit.ended.work.localizedTitle ?? hit.ended.work.title
        const where = labelOf.get(hit.live.service) ?? hit.live.service
        const when = hit.live.at ? formatMonthDay(hit.live.at, ctx.theme.utc_offset_minutes) : '日付なし'
        warn(
          `「${clip(title, 24)}」は ${where} で` +
            `${hit.kind === 'leaving' ? `${when}まで見放題の予定` : `${when}に配信開始を観測`}` +
            'したまま、終了の観測がありません。**この記事は全作終了として書かれています。**\n' +
            '      「配信中」とは断定できません（当サイトが持っているのは変化の観測で、在庫ではない）が、' +
            '本文で言い切る前に確かめてください。',
        )
      }
    }
    if (alreadyOff === 0 && backOn === 0 && /終了しました/.test(md)) {
      err('終了を過去形で書いています。この記事の作品はまだ観られます（全件が終了予定）。')
    }

    /*
     * --- 復帰の書き方 ---
     *
     * ★ 復帰した作品には**終了日が無い**。「いつまで観られるか」を書けば必ず推測になる。
     *   素材にその日付が無いので、書かれていたらそれは作った日付。
     */
    if (backOn > 0) {
      for (const phrase of [
        '当面は観られます',
        '当面は視聴できます',
        'いつまで観られるかは未定ですが',
      ]) {
        if (md.includes(phrase)) {
          err(
            `「${phrase}」が含まれています。見放題に復帰した作品の終了日は分かりません。` +
              '観られる期間について書かず、復帰したという事実だけを書いてください。',
          )
        }
      }
      if (!md.includes('復帰')) {
        warn(
          `見放題に復帰した作品が${backOn}本ありますが、本文に「復帰」がありません。` +
            'この記事でいちばん新しい事実なので、表の状態列だけでなく地の文でも触れてください。',
        )
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
    /*
     * ★ 状態列があること。**この記事だけの必須列。**
     *   混在する記事で状態列が落ちると、読者は1行ずつの可否を判断できない。
     */
    if ([stillOn, alreadyOff, backOn].filter((n) => n > 0).length > 1 && !md.includes('状態')) {
      err(
        '表に「状態」列がありません。この記事は終了予定・終了済み・見放題に復帰のうち' +
          '2つ以上が混ざっているので、1行ずつ区別できないと読者を誤らせます。' +
          '列は「終了日 / 作品 / 状態 / 評価 / サービス」です。',
      )
    }
    /*
     * ★ **同じ作品を2回書かせない。**
     *   同じ映画がサービスごとに別の題で入っている（`workKey` の説明）。
     *   両方を表に出すと読者には別作品に見えるので、記事側は1行にまとめてよい。
     *   ここでは「**その作品を指すどれかの題が本文にあるか**」だけを見る。
     *   突き合わせるのは**この記事の素材どうし**に限るので、別作品を巻き込まない。
     */
    const spellings = new Map<string, string[]>()
    for (const e of items) {
      const t = e.work.localizedTitle ?? e.work.title
      if (!t) continue
      const k = workKey(t)
      spellings.set(k, [...(spellings.get(k) ?? []), t])
    }
    const missing = [...spellings.entries()]
      .filter(([, alts]) => !alts.some((t) => md.includes(t)))
      .map(([, alts]) => alts[0]!)
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
      ['U-NEXTの但し書き', resolved.unextNote],
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
  /** U-NEXT の作品が入るときだけ。入らなければ空文字で、使われない */
  unextNote: string
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
    // ★ 素材の件数ではなく**作品数**（`workCount` の説明）。
    //   タイトルの「◯本」とリードの「◯本」は必ず同じ数にする。
    本数: workCount(items),
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
    unextNote: items.some((e) => hasLineup(e.service)) ? get('series-unext-note') : '',
    otherServicesIntro: get('other-services-intro'),
    attributions,
    asOf,
  }
}
