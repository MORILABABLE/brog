/**
 * 記事タイプ: 見放題配信開始（new）／ジャンル別
 *
 * 収集済みの new イベントから「今月見放題に入った作品」の記事を、
 * アニメ / 洋画・海外ドラマ / 邦画・国内ドラマ の3本に分けて作る。
 * 末尾には、まだ始まっていない upcoming を「配信開始予定」として添える。
 *
 * ■ 文章の型は2つのファイルに分かれている
 *   templates/arrivals.md         構成と文体のルール
 *   templates/fixed-phrases.md    毎月そのまま使う文言（arrivals- で始まるキー）
 * このファイルはそれらを組み立ててプロンプトにし、書かれた記事を検査する。
 *
 * ■ 配信終了記事との一番の違い
 * この記事には締切が無い。「今観ないと観られなくなる」が使えない。
 * 急かしも編集部のおすすめも置かず、**作品を並べて中身を伝えることに徹する**。
 * どれを観るかは読者が決める。検査もその方針で書かれている。
 */
import { readFileSync } from 'node:fs'
import { OUTPUT_FORMAT, type ArticleContext, type ArticleType } from '../../../pipeline/core/article.ts'
import { buildSearchLinks } from '../../../pipeline/core/search-links.ts'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { VerifyIssue } from '../../../pipeline/core/verify.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'
import { GENRES, classify } from '../genres.ts'
import { productionCompanies } from '../work-context.ts'
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
  normalizeBody,
  phraseReader,
  publishable,
  previousAsOf,
  ratingMentionsInProse,
  serviceLabels,
  serviceNames,
  shortScriptSection,
  type Freshness,
} from './shared.ts'

/**
 * 1記事に載せる配信開始作品の上限。
 *
 * 洋画は月に180件を超えるため、全件を載せると1作1文でも記事が破綻する。
 * ジャンルを分けたうえで、さらにここで絞る。
 * アニメ・邦画は通常この数に収まるので、実質は洋画のための上限。
 */
const MAX_ITEMS = 60

/**
 * 末尾に載せる「配信開始予定」の上限。
 *
 * 少なく抑えるのは、予定作品は邦題が未確認のものが多く、
 * 品質ゲートが「原題が本文に無い」で公開を止めるため。
 * 表に全件並べきれる数にしておく。
 */
const MAX_UPCOMING = 12

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'arrivals-lead-first-sentence',
  'arrivals-update-lead-first-sentence',
  'arrivals-lead-closer',
  'arrivals-upcoming-intro',
  'other-services-intro',
  'attribution',
  // ★ U-NEXT 由来の作品が混ざる月がある（2026-08-26 にジャンル判定を足してから）。
  //   品質ゲートは**素材の出どころ**から必要な表記を決めるので、
  //   片方しか渡さないと「提供元表記がありません」で公開が止まる。
  'attribution-unext-arrivals',
  // ショート動画の締め（記事と同時に作る台本で使う）
  'short-closer',
] as const

/**
 * 配信終了記事の急かし文句。
 * 締切がある終了記事では成立するが、配信開始記事では不自然になる。
 * テンプレート `arrivals.md`「配信終了記事との決定的な違い」に対応する検査。
 */
const URGING = /(ぜひ観ましょう|見逃せません|お見逃しなく|お見逃しがないように|今のうちに観)/

/**
 * 編集部が観る順番や選定を押し付けている表現。
 *
 * 読者が求めているのは「その月に増えた作品の中で自分に合うもの」であって、
 * 編集部のおすすめではない。作品を並べて中身を伝え、判断は読者に委ねる。
 */
const RECOMMENDING =
  /(この日(?:から)?観るなら|まず1本選ぶなら|はじめて観るなら|から入って|順番が観やすい|のが分かりやすいです|向いています)/

/**
 * 段落がです・ます調の文で終わっているか。体言止め・尻すぼみの検出用。
 *
 * 過去形（「〜となりました。」）を入れ忘れると、正しい文を毎回警告してしまう。
 * 配信開始記事は起きたことを書く記事なので、過去形の締めがむしろ普通。
 */
const PROPER_ENDING = /(です|ます|ました|ません|でした|でしょう)[。！]?$/

export const arrivalsArticle: ArticleType = {
  id: 'arrivals',
  category: 'arrivals',
  description: '今月見放題配信が始まった作品（ジャンル別）',
  variants: GENRES,

  select(rawEvents, _ledger: Ledger, ctx) {
    const genre = ctx.variant?.key
    if (!genre) return []

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    const events = publishable(rawEvents)

    const started = events
      .filter((e) => e.kind === 'new')
      // 配信開始日が不明なものは時系列に並べられないので記事にしない
      .filter((e) => e.at)
      .filter((e) => isTargetMonth(e.at!, ctx))
      .filter((e) => classify(e.work) === genre)

    // 上限を超えるときは「配信開始日順」ではなく素材の厚い順で残す。
    // 日付順で切ると月の後半がまるごと落ち、
    // 「月後半は何も始まらない」と読める記事になってしまう。
    /*
     * 上限を超えるときは「配信開始日順」ではなく素材の厚い順で残す。
     * 日付順で切ると月の後半がまるごと落ち、
     * 「月後半は何も始まらない」と読める記事になってしまう。
     *
     * ★ **今回の追加分を先に取る**（2026-08-26）。
     *   この記事タイプは月内に何度も書き直すようになった。
     *   新しく入った作品が上限で落ちると、更新回なのに
     *   「今回増えたぶん」を書けない記事ができあがる。
     *
     * ★ ただし**上限そのものは外さず、追加分に渡す枠も半分までにする。**
     *   追加分だけで上限を超える月がある（実測: U-NEXT のジャンル判定を
     *   足した直後、洋画の追加分が95件になった）。
     *   追加分を優先しきると**前の版に載っていた作品が全部押し出され**、
     *   「今回新たに60本、今月は60本」という、更新ではなく総入れ替えの
     *   記事ができあがる。読者から見ると前に読んだ記事が消えたことになる。
     *   半分を上限にすれば、増えたぶんと今月の全体像が両方残る。
     */
    const since = previousAsOf(this.slug(ctx))
    const byMaterial = (a: ChangeEvent, b: ChangeEvent) => materialScore(b) - materialScore(a)
    const added = started.filter((e) => freshnessOf(e, since) !== 'known').sort(byMaterial)
    const rest = started.filter((e) => freshnessOf(e, since) === 'known').sort(byMaterial)

    const addedRoom = Math.min(added.length, Math.ceil(MAX_ITEMS / 2))
    const kept =
      started.length <= MAX_ITEMS
        ? started
        : [
            ...added.slice(0, addedRoom),
            ...rest.slice(0, MAX_ITEMS - addedRoom),
          ]

    // 記事は配信開始日順に書くので、最後に日付で並べ直す
    kept.sort((a, b) => a.at!.localeCompare(b.at!))

    // ★ 開始予定は対象月に縛らない。「これから始まるもの」がそのまま読者の関心。
    //   既に開始日を過ぎたものは除く（過ぎていれば new 側で拾われる）。
    const upcoming = events
      .filter((e) => e.kind === 'upcoming')
      .filter((e) => classify(e.work) === genre)
      .filter((e) => !e.at || Date.parse(e.at) >= ctx.now.getTime())
      .sort(compareUpcoming)
      .slice(0, MAX_UPCOMING)

    return [...kept, ...upcoming]
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'arrivals.md'), 'utf8')
    const since = previousAsOf(this.slug(ctx))
    const isUpdate = since !== undefined
    const resolved = resolvePhrases(items, ctx, since)
    const started = startedItems(items)
    const upcoming = upcomingItems(items)
    const added = started.filter((e) => freshnessOf(e, since) !== 'known')

    const system = `あなたは動画配信サービスの情報を扱う日本語ブログの編集者です。
与えられたデータだけを使って記事を書きます。データに無い事実を書いてはいけません。

${template}

---

# この記事のジャンル

**${resolved.genre}**。このジャンルの作品だけを扱います。

---

# 今回の版

**この記事は「${isUpdate ? '更新回' : '初回'}」です。**

${
  isUpdate
    ? `前回の版は ${since.toISOString().slice(0, 10)} 時点のものです。
今回新たに載る作品が **${added.length}件** あります（素材に ★今回の追加分 と付けてあります）。
**冒頭に近い位置で、今回増えたぶんを先に見せてください。**
タイトルの先頭は 【${resolved.asOf}更新】 にします。`
    : `このジャンルで今月**はじめて書く版**です。
タイトルに「更新」と書いてはいけません。前の版が無いので嘘になります。`
}

---

# 今月そのまま使う固定文言

以下は**一字一句そのまま**本文に入れてください。言い換え・要約・記号の変更をしてはいけません。

## リードの1文目（本文の冒頭）

${resolved.leadFirstSentence}

## リードの締め（リード段落の最後の1文）

${resolved.leadCloser}

## 「これから配信開始予定」の冒頭

${resolved.upcomingIntro}

## 「他のサービスで探す」の冒頭

${resolved.otherServicesIntro}

## 記事の末尾

${resolved.attributions.join('\n\n')}

---

${OUTPUT_FORMAT}`

    const parts = [
      `以下は今月見放題配信が始まった${resolved.genre}のデータです。全${started.length}件。`,
      '',
      started.map((e) => row(e, ctx, '配信開始日', freshnessOf(e, since))).join('\n\n'),
    ]

    if (upcoming.length) {
      parts.push(
        '',
        '---',
        '',
        `以下は**まだ配信が始まっていない**作品です。全${upcoming.length}件。`,
        'テンプレートの構成5「これから配信開始予定」だけで扱い、上の作品と混ぜないでください。',
        '',
        upcoming.map((e) => row(e, ctx, '配信開始予定日', 'known')).join('\n\n'),
      )
    }

    parts.push(
      '',
      '---',
      '',
      'このデータから記事を書いてください。',
      '',
      `特に重要な作業:
1. **「なぜ今これがまとめて入ったのか」を探すこと。** 優先順は
   新作起点 → 制作会社起点（素材の「制作」を見る） → シリーズ起点 → 配信開始日。
   **上位3つは日付をまたいでまとめてよい**（別の日に入った同一シリーズは1つの節にする）。
2. **各セクションは「見出し → 表 → 解説」の順に書くこと。**
   見出しの直後に導入文を挟まず、いきなり表を置きます。
   表の列は「配信開始日 / 作品 / 評価 / サービス」の4列で固定してください。
3. 見出しは \`## ○月○日：\` で始め、そのあとに**まとまりの正体を固有名詞で**書くこと。
4. **評価スコアは表にだけ書き、地の文には一切書かないこと。**
   「評価は67です」「今月最高の評価です」「評価だけで選ぶなら」はすべて禁止です。
5. **観る順番やおすすめを書かないこと。** 「この日から観るなら」「まず1本選ぶなら」
   「はじめて観るなら」は書きません。作品の紹介に徹し、判断は読者に委ねます。
   この記事には締切が無いので、「ぜひ観ましょう」「見逃せません」も書きません。
6. **解説するのは12〜15作品まで。** 全作品に触れると読み飛ばされます。
   絞る基準は**知名度**です。評価が未提供でも広く知られた作品は外さないでください。
   残りは構成4の全作品リストに漏れなく載せます。
7. あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
8. **「★あらすじ未提供」と書かれた作品は、話の筋を書いてはいけません。**
   与えられた公開年・ジャンル・制作会社・監督・出演者の範囲だけで1文にしてください。
9. 「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。
10. 監督名・出演者名はローマ字で与えられています。**日本語表記に直さないでください。**
11. 制作会社は素材に与えられたものだけを書いてください。
    シリーズの新作に触れるときは「新作が続いています」までとし、
    **放送開始日・公開日・シーズン番号は書かないでください**（誤情報になります）。
12. 記号は全角に統一してください（！ ？ （） を半角で書かない）。
    ただし作品名に含まれる半角記号は正式表記なのでそのまま使ってください。`,
    )

    return { system, prompt: parts.join('\n') }
  },

  /**
   * ショート動画の台本。
   *
   * **配信終了記事と違い、この記事には締切が無い。** 急かせないぶん、
   * 台本が成立するかは「まとまり」の強さだけで決まる
   * （制作会社の一斉配信、シリーズがそろった、など）。
   * まとまりが弱い月は、台本を作らない判断があってよい。
   */
  buildShortPrompt(items, ctx) {
    const resolved = resolvePhrases(items, ctx, previousAsOf(this.slug(ctx)))

    return shortScriptSection(ctx, {
      dateLabel: '配信開始日',
      titlesAreLocalized: false,
      // ★ 開始予定（upcoming）は候補に入れない。まだ観られない作品を
      //   30秒の中で「始まりました」と並べると、視聴者は今すぐ観られると誤解する。
      //   記事では節を分けて断れるが、ショートにはその余地が無い。
      candidates: startedItems(items),
      closer: resolved.shortCloser,
      extraRules: [
        `**この記事には締切が無い。** 「今観ないと観られなくなる」は使えません。
   「見放題に入りました」という事実の提示で終え、視聴を急かさないこと。`,
        `**まとまりが弱いと感じたら、そう報告してください。** 無理に1本作るより、
   その月はショートを見送るほうがチャンネルの価値を保てます。`,
      ],
    })
  },

  tags(items, ctx) {
    const labelOf = serviceLabels(ctx)
    const services = [...new Set(startedItems(items).map((e) => labelOf.get(e.service) ?? e.service))]
    const [y, m] = ctx.targetMonth.split('-')
    return [...services, '配信開始', ctx.variant?.label ?? '', `${y}年${Number(m)}月`].filter(Boolean)
  },

  slug(ctx) {
    return `${ctx.targetMonth}-arrivals-${ctx.variant?.key ?? 'all'}`
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)

    const issues: VerifyIssue[] = []
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const since = previousAsOf(this.slug(ctx))
    const resolved = resolvePhrases(items, ctx, since)

    // --- 事故を防ぐ検査（公開を止める） ---

    if (!md.includes('|')) {
      err('全作品の一覧表がありません。テンプレートの構成4が守られていません。')
    }
    /*
     * ★ 初回の版に「更新」と書かせない。
     *   読者にとって「更新」は「前に読んだものが変わった」の意味で、
     *   前の版が無いのに名乗るのは嘘になる（arrivals-service.ts と同じ検査）。
     */
    if (since === undefined && /【[^】]*更新[^】]*】/.test(md)) {
      err('初回の版なのにタイトルまたは本文が「更新」を名乗っています。前の版がありません。')
    }
    if (since !== undefined) {
      const notShown = startedItems(items)
        .filter((e) => freshnessOf(e, since) !== 'known')
        .map((e) => e.work.localizedTitle ?? e.work.title)
        .filter((title) => title && !md.includes(title))
      if (notShown.length > 0) {
        err(`今回の追加分が本文にありません: ${notShown.map((t) => clip(t, 24)).join(' / ')}`)
      }
    }
    if (!/U-NEXT|Hulu|DMM/.test(md)) {
      err('他サービスでの検索リンクがありません。テンプレートの構成6が守られていません。')
    }
    if (/U-NEXTで配信中|Huluで配信中|DMM TVで配信中/.test(md)) {
      err('対象外サービスについて「配信中」と断定しています。配信状況のデータを持っていないため書けません。')
    }
    // ★ 開始済みと開始予定の混同は、読者が「今すぐ観られる」と誤解する直接の原因。
    if (upcomingItems(items).length > 0 && !md.includes('配信開始予定')) {
      err(
        '配信開始予定の作品が素材にあるのに、本文に「配信開始予定」の節がありません。' +
          'まだ観られない作品を、観られる作品と同じ扱いで並べてはいけません。',
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
    if (upcomingItems(items).length > 0 && !md.includes(resolved.upcomingIntro)) {
      err(
        '「これから配信開始予定」の冒頭が固定文言と一致しません。\n      ' +
          '開始日が変わりうることを断る一文なので、そのまま入れてください。',
      )
    }

    // --- 文体の検査（止めない。判定が外れることがあるため） ---

    const firstLine = md.split('\n', 1)[0] ?? ''
    if (firstLine !== resolved.leadFirstSentence && md.startsWith(resolved.leadPrefix)) {
      warn(`リードの1文目が想定の型と違います。想定:\n      ${resolved.leadFirstSentence}`)
    }

    const urging = md.match(URGING)
    if (urging) {
      warn(
        `配信終了記事の急かし文句が混ざっています: 「${urging[0]}」` +
          '（この記事には締切が無いので、作品の紹介で終えます）',
      )
    }

    const recommending = md.match(RECOMMENDING)
    if (recommending) {
      warn(
        `編集部の選定・観る順番の押し付けが混ざっています: 「${recommending[0]}」` +
          '（作品を並べて中身を伝え、どれを観るかは読者に委ねます）',
      )
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
      if (last && !PROPER_ENDING.test(last)) {
        warn(`「${section.heading}」の最後が体言止め・尻すぼみになっています: 「${clip(last)}」`)
      }
    }

    const halfWidth = halfWidthSymbols(md, itemTitles(items))
    if (halfWidth.length) {
      warn(`半角記号が混ざっています: ${halfWidth.join(' ')} → 全角（！ ？ （ ））に統一してください。`)
    }

    return issues
  },
}

// --- 素材の並べ方 ---------------------------------------------------------

/**
 * 上限を超えたときに何を残すかの優先度。
 *
 * ■ 評価を主軸にしない理由
 * 評価だけで切ると、**評価が付いていない有名作が落ちる。**
 * 実際に「ONE PIECE STAMPEDE」（評価なし）が末尾に追いやられ、
 * 読者にとって価値の高い作品を取りこぼした。
 *
 * そこで知名度の手がかり（邦題が確認できている・Wikidataに制作会社の記載がある・
 * 解説の材料が揃っている）を重く見て、評価は最後の決め手にとどめる。
 * 評価スコアは記事本文には出さない。ここで作品を選ぶためだけに使う。
 */
function materialScore(e: ChangeEvent): number {
  const w = e.work
  let score = 0

  // 邦題が引けている＝日本で流通した作品。知名度の代理として最も効く
  if (w.localizedTitle) score += 40
  // Wikidata に制作会社まで載っている作品は、項目が充実している＝知られている
  if (productionCompanies(w)?.length) score += 20
  // 解説を書ける材料があるか
  if (w.overview.length > 10) score += 15
  if (w.directors?.length || w.cast?.length) score += 5
  // 公開から日が浅い作品は、評価が付いていなくても関心が高い
  const thisYear = new Date().getUTCFullYear()
  if ((w.year ?? 0) >= thisYear - 1) score += 20

  // 評価は最後の決め手。同じくらいの知名度の作品を並べ替える程度の重みにする
  score += (w.rating ?? 0) / 4
  return score
}

/** 開始予定は日付順。日付が取れていないものは最後にまとめる。 */
function compareUpcoming(a: ChangeEvent, b: ChangeEvent): number {
  if (!a.at && !b.at) return (b.work.rating ?? 0) - (a.work.rating ?? 0)
  if (!a.at) return 1
  if (!b.at) return -1
  return a.at.localeCompare(b.at)
}

const startedItems = (items: ChangeEvent[]) => items.filter((e) => e.kind === 'new')
const upcomingItems = (items: ChangeEvent[]) => items.filter((e) => e.kind === 'upcoming')

/** 1作品ぶんのプロンプト行 */
function row(
  e: ChangeEvent,
  ctx: ArticleContext,
  dateLabel: string,
  freshness: Freshness,
): string {
  const w = e.work
  const links = buildSearchLinks(w, ctx.theme.search_links ?? [])
  const title = w.localizedTitle ?? w.title
  const note = w.localizedTitle ? `（原題: ${w.title}）` : '（★邦題が未確認。この原題のまま書くこと）'
  const offset = ctx.theme.utc_offset_minutes

  return [
    `- ${title} ${note}`,
    // 日本作品は原語表記がそのまま返るので、邦題の裏取りになる
    w.originalTitle && w.originalTitle !== w.localizedTitle ? `  原語表記: ${w.originalTitle}` : '',
    `  サービス: ${serviceLabels(ctx).get(e.service) ?? e.service}`,
    `  ${dateLabel}: ${e.at ? formatMonthDay(e.at, offset) : '★未定（日付を書かないこと）'}`,
    // ★ 誤情報を止める要。LLM に日付を突き合わせさせない（shared.ts）。
    freshnessNote(freshness),
    w.year ? `  公開年: ${w.year}年` : '',
    w.rating ? `  評価: ${w.rating}/100（★表にだけ書き、地の文には書かないこと）` : '',
    w.genres.length ? `  ジャンル: ${w.genres.join(' / ')}` : '',
    // 「同じ制作会社の作品が一斉に入った」を推測でなく事実として書くための材料
    productionCompanies(w)?.length ? `  制作: ${productionCompanies(w)!.join(' / ')}` : '',
    w.directors?.length ? `  監督: ${w.directors.join(' / ')}（★ローマ字のまま書くこと）` : '',
    w.cast?.length ? `  出演: ${w.cast.join(' / ')}（★ローマ字のまま書くこと）` : '',
    w.overview.length > 10
      ? `  あらすじ(英語原文): ${w.overview}`
      : '  あらすじ: ★未提供（内容を推測して書かないこと）',
    links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// --- 固定文言 -------------------------------------------------------------

interface ResolvedPhrases {
  /** 【8月配信開始】 */
  leadPrefix: string
  leadFirstSentence: string
  leadCloser: string
  upcomingIntro: string
  otherServicesIntro: string
  /** 素材の出どころに応じた出典表記。**複数になることがある** */
  attributions: string[]
  /** ショート動画の締め */
  shortCloser: string
  /** 記事作成日。「8月9日」形式 */
  asOf: string
  /** アニメ / 洋画・海外ドラマ / 邦画・国内ドラマ */
  genre: string
}

/**
 * 固定文言に今月の値を差し込む。プロンプトと検査で同じ結果になることが要件。
 *
 * @param since 前回の版の基準日。undefined なら初回の版。
 */
function resolvePhrases(
  items: ChangeEvent[],
  ctx: ArticleContext,
  since: Date | undefined,
): ResolvedPhrases {
  const started = startedItems(items)
  const added = started.filter((e) => freshnessOf(e, since) !== 'known')
  const vars = {
    月: articleMonth(ctx),
    ジャンル: ctx.variant?.label ?? '',
    サービス: serviceNames(started, ctx),
    基準日: asOfLabel(ctx),
    // ★ 配信開始予定は数に入れない。リードの本数は「今観られる本数」。
    本数: started.length,
    追加本数: added.length,
  }
  const get = phraseReader(fixedPhrases(ctx, REQUIRED_PHRASES), vars)
  const isUpdate = since !== undefined

  return {
    leadPrefix: isUpdate ? `【${vars.基準日}更新】` : `【${vars.月}月配信開始】`,
    leadFirstSentence: get(
      isUpdate ? 'arrivals-update-lead-first-sentence' : 'arrivals-lead-first-sentence',
    ),
    leadCloser: get('arrivals-lead-closer'),
    upcomingIntro: get('arrivals-upcoming-intro'),
    otherServicesIntro: get('other-services-intro'),
    /*
     * ★ ジャンル別記事は**複数のサービスが混ざる。**
     *   U-NEXT 由来の作品が1件でもあれば U-NEXT の表記が要り、
     *   API 由来が1件でもあれば API の表記が要る（両方あれば両方）。
     *   判定は pipeline/core/verify.ts の ATTRIBUTIONS と同じ条件にすること。
     */
    attributions: [
      started.some((e) => e.work.meta.source !== 'u-next') ? get('attribution') : '',
      started.some((e) => e.work.meta.source === 'u-next')
        ? get('attribution-unext-arrivals')
        : '',
    ].filter(Boolean),
    shortCloser: get('short-closer'),
    asOf: vars.基準日,
    genre: vars.ジャンル,
  }
}
