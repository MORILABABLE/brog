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
 * ■ ショート動画の台本を作らない（buildShortPrompt を実装していない）
 * leaving / arrivals には台本が付くが、この記事タイプには意図的に付けていない。
 *
 * この記事の要点は「もう観られない」で、それを30秒で誤解なく伝える型が無い。
 * 短い尺では但し書きを添えられず、「終了」の2文字だけが残って
 * **まだ間に合うと読まれる**（同じ危険があるから記事側では MISLEADING_AFTER_END 検査で
 * 公開を止めている）。型が見つかっていない以上、たたき台も作らない。
 *
 * 作れるようになったら `buildShortPrompt` を実装すれば、それだけで台本が付く。
 * CLI もスラッシュコマンドも変えなくてよい。
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
import { productionCompanies, researchLines } from '../work-context.ts'
import {
  articleMonth,
  asOfLabel,
  clip,
  fixedPhrases,
  foundSince,
  halfWidthSymbols,
  isTargetMonth,
  itemTitles,
  MISLEADING_AFTER_END,
  namingRules,
  normalizeBody,
  phraseReader,
  previousAsOf,
  publishable,
  ratingMentionsInProse,
  sectionsOf,
  SECTION_PROSE_LIMIT,
  serviceLabels,
  sectionCountLine,
  extraSectionNote,
  sectionLimit,
  structureIssues,
  titleIssues,
  variantKey,
  styleIssues,
  writingRules,
} from './shared.ts'

/**
 * この記事を作るサービス。**1社につき1本**。
 *
 * **expiring が取れないサービスだけを入れること。**
 * Netflix と Amazon Prime Video は `leaving` が終了前に知らせているので、
 * ここに入れると同じ作品を二度扱うことになり、しかも後から出す分だけ価値が低い。
 *
 * Apple TV+ を入れていないのは、removed が月2〜3件しかなく記事にならないため。
 * 件数が増えたらここに追加すればよい（他の変更は不要）。
 *
 * ★ **バリアントにしてあるのが要点**（2026-08-27）。
 *   以前はここが対象サービスの配列で、記事は1本だけだった。
 *   1社しか入っていないあいだは1社記事に見えるが、2社目を足した瞬間に
 *   **サービス横断のまとめ記事に変わる**。軸を名乗る形にして塞いである。
 *   ラベルは theme.yaml の catalogs と揃えること。
 */
const SERVICE_VARIANTS = [{ key: 'disney-plus', label: 'Disney+' }] as const

/**
 * 1記事に載せる上限。
 * 構成3「全終了作品リストは漏れなく全件」が原則なので、
 * 通常の月がまるごと収まる数にしておく（Disney+ は月70〜80件）。
 */
const MAX_ITEMS = 80

/** fixed-phrases.md に必ずあるべきキー。欠けていれば読み込み時に落ちる。 */
const REQUIRED_PHRASES = [
  'ended-lead-first-sentence',
  // 月内に同じ記事を書き直したとき用（2026-08-27 追加）
  'ended-update-lead-first-sentence',
  /*
   * ★ 2026-09-19 のテンプレ改修で3つ減った（理由は leaving.ts と同じ）。
   *   `*-nochange` / `ended-lead-closer` / `other-services-intro`。
   *   締めの1文（もう観られないと明言して次の一手に繋ぐ）は
   *   `ended-lead-first-sentence` の末尾に畳んである。
   */
  'attribution',
] as const

/**
 * 段落を「次の一手を示す形」で締めているとみなす語尾。
 * templates/ended.md の締めルールに対応する。
 */
const NEXT_STEP = /(探せます|探してみましょう|探すことができます|確認できます|確認してみましょう|ご確認ください|見つかる場合があります)[。]?$/

export const endedArticle: ArticleType = {
  id: 'ended',
  category: 'ended',
  axis: 'service',
  description: '今月見放題が終了した作品（配信終了予定を取得できないサービス・サービス別）',
  variants: SERVICE_VARIANTS,
  variantFlag: 'service',
  variantNoun: 'サービス',

  select(rawEvents, _ledger: Ledger, ctx) {
    const service = ctx.variant?.key
    if (!service) return []

    // ★ 出さないと決めた作品を最初に外す（data/excluded-works.json）
    const events = publishable(rawEvents)

    const target = events
      .filter((e) => e.kind === 'removed')
      .filter((e) => e.service === service)
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
    const version = versionOf(items, this.slug(ctx))

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
        // ★ 更新版の主役。素材の側でラベルを振り、LLM に日付を突き合わせさせない。
        version.isUpdate && foundSince(e, version.since)
          ? '  ★今回新たに終了が確認された作品（前回の版には載っていない）'
          : '',
        e.work.year ? `  公開年: ${e.work.year}年` : '',
        e.work.rating ? `  評価: ${e.work.rating}/100（★記事には書かないこと。表の行を並べる目安にだけ使う）` : '',
        e.work.genres.length ? `  ジャンル: ${e.work.genres.join(' / ')}` : '',
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
今回新たに終了が確認された作品が **${version.added.length}件** あります（素材に ★ が付いています）。
その分をリードの直後で見せてください。前回までに載っていた作品は落としません。
タイトルは **【${ctx.targetMonth.split('-')[0]}年${articleMonth(ctx)}月】で始め**、本数の直後に 【${resolved.asOf}更新】 を置いてください。
**先頭を 【${resolved.asOf}更新】 にしないこと。** 先頭が更新日だと、検索結果の一覧でどのカテゴリ・どの月の記事か分からなくなります。`
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
2. ${sectionCountLine(ctx)} 記事全体の形は次で固定です。

   \`\`\`
   リード（見出しなし・固定文言の1組だけ）
   ## 小段落1  中心の2〜3作   … 表 → 解説（最大${SECTION_PROSE_LIMIT}字）${
     ctx.extraSection
       ? `
   ## 小段落2  大きなシリーズ  … 表 → 解説（最大${SECTION_PROSE_LIMIT}字）
   ## 小段落3  残りの全件     … 表 → 軽い言及`
       : `
   ## 小段落2  残りの全${items.length}件 … 表 → 軽い言及`
   }
   ## まとめ
   \`\`\`

${extraSectionNote(ctx, items.length)}

   ★ **「他のサービスで探す」「全終了作品リスト」の節は作りません**（2026-09-19 に廃止）。
     終了後どこで観られるかは、**表の各行の下にサイトが出します。**
     U-NEXT・Hulu・DMM TV について「配信中」と断定してはいけません（配信状況データがありません）。
   ★ **Amazon・Hulu のリンクも、配信カレンダーへのリンクも本文に書かないこと。**
     小段落の直下と表の直下にビルドが入れます。
3. **リードは上の固定文言の1組だけです。2段落目を書かないでください。**
   タイトルがすでに中心作を名乗っているので、ここで作品名を挙げると同じ名前を2回読ませることになります。
4. **どちらの小段落も「見出し → 表 → 解説」の順に書くこと。**
   見出しの直後に導入文を挟まず、いきなり表を置きます。
   表の列は「終了日 / 作品 / 出演者 / サービス」の4列で固定してください。
   ★ **同じ作品を2つの表に出さないこと。** 小段落1に出した作品は小段落2の表から外します。
5. **小段落1で解説するのは、中心になる2〜3作だけです（最大${SECTION_PROSE_LIMIT}字）。**
   本数が多く名前の通ったまとまり（同一シリーズ・同一制作会社・同一ジャンル）を1つ選びます。
   **見出しに具体的な作品名を入れ**、
   **最終段落を「〜で探せます」「〜から確認できます」など次の一手を示す形で締める**こと。
6. 小段落2は**表が主役**です。表の下に、特筆すべき1〜2作だけを1〜2文で書いてください。
   作品名を並べただけの段落を作らないこと。書くことが無ければ表だけで構いません。
7. **評価スコアは記事のどこにも書かないこと。** 表にも地の文にも出しません。
   素材の評価は、表の行を並べる順番を決めるための目安としてだけ使ってください。
8. **表の「出演者」欄には主演と助演を1名ずつ（計2名まで）書くこと。網羅しません。**
   素材の \`出演\` の行から選びます。**アニメは「キャラ名（CV.声優）」の形**で書いてください。
   ★ **素材の \`出演\` は並び順が主演順ではありません。** どちらが主演か分からない作品では、
     代表として2名を挙げるだけにして「主演」と書かないでください。
   ★ 素材に \`出演\` の行が無い作品の欄は **「—」** にします（推測で埋めない）。
9. あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
10. 「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。
11. 記号は全角に統一してください（！ ？ （） を半角で書かない）。
    ただし作品名に含まれる半角記号は正式表記なのでそのまま使ってください。`

    return { system, prompt }
  },

  tags(items, ctx) {
    const [y, m] = ctx.targetMonth.split('-')
    return [ctx.variant?.label ?? '', '配信終了済み', `${y}年${Number(m)}月`].filter(Boolean)
  },

  slug(ctx) {
    // ★ 公開済みの 2026-08-ended は、軸を名乗っていなかった頃のもの（Disney+ 1社）。
    //   サービス別に切り替えた分がこの形になる。過去分は作り直さない。
    return `${ctx.targetMonth}-ended-${variantKey(ctx, this.id)}`
  },

  verifyTitle(title, ctx) {
    /*
     * ★ **`questionClause` を渡さない。これは意図的。**
     *
     * 主題軸の「終了済み」記事（`series.ts` の `ended` / `special.ts` の `removed`）は
     * 2026-09-06 にタイトルへ「はどこで見れる？」を足した。
     * **この記事タイプには足さない。** 理由は3つある。
     *
     *   1. **文として成立しない。** 軸がサービスなので、問いの主語が
     *      「Disney+は」になる。読者が探しているのは作品であってサービスではない
     *   2. **主語をまとまりに変えても、記事の名乗りとずれる。**
     *      `Disney+で見放題配信が終了した名探偵コナン劇場版22作はどこで見れる？` は、
     *      **48本を扱う記事なのにコナンの記事に見える**
     *   3. **答えは表がもう持っている。** 終了記事の表には行ごとに
     *      「では、どこで観られるか」の1行が入る（`site/plugins/rehype-availability.ts`）。
     *      そのうえでタイトルにも置くと、1つの記事で同じことを2回聞くことになる
     *
     * ★ **2026-09-10 に一度渡して、同じ日に戻した。**
     *   タイトルと節の見出し6つすべてに問いが並び、運用者の判断で撤回している
     *   （「『どこで見れる？』という問いかけが過剰です。表の他サービスへの表記で
     *   誘導は済んでいるので、『見放題が終了』という従来の表示で良い」）。
     *   **経緯は templates/naming.md「終わった記事は問いから入る」にある。**
     *
     * ★ **CTRが低いからといって、ここに同じ処方を当てないこと。**
     *   実測（2026-09-06）で `/posts/2026-08-ended` は 21表示・0クリック・**10.1位**。
     *   11位以下は表示があってもクリックがほぼ0になる帯なので、
     *   **これは順位の問題であってタイトルの問題ではない**（同 4節）。
     */
    return titleIssues(title, ctx, {
      axis: 'service',
      verbPhrase: '見放題配信が終了した',
      isUpdate: previousAsOf(this.slug(ctx)) !== undefined,
    })
  },

  verify(raw, items, ctx): VerifyIssue[] {
    const md = normalizeBody(raw)

    // 全記事タイプ共通の決まり（templates/writing.md）
    const issues: VerifyIssue[] = [
      ...styleIssues(md),
      // 記事の骨格（小段落2つ＋まとめ・廃止した節・解説の字数）
      ...structureIssues(md, { maxSectionProse: SECTION_PROSE_LIMIT, maxSections: sectionLimit(ctx) }),
    ]
    const err = (message: string) => issues.push({ level: 'error', message })
    const warn = (message: string) => issues.push({ level: 'warn', message })

    const version = versionOf(items, this.slug(ctx))
    const resolved = resolvePhrases(items, ctx, version)

    // --- この記事タイプ固有の最重要検査（公開を止める） ---

    // 「まだ観られる」と誤解させる表現。読者を直接裏切るため error。
    for (const phrase of MISLEADING_AFTER_END) {
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

    // 作品の表があるか。**小段落2の表が残り全件を持つ**（2026-09-19 の改修）
    if (!md.includes('|')) {
      err('作品の一覧表がありません。小段落1と小段落2の両方に表が要ります。')
    }
    /*
     * ★ 「他サービスでの検索リンクがあるか」の検査は 2026-09-19 に外した。
     *   節ごと廃止し、行き先は**表の各行の下**にサイトが出すようになったため
     *   （`site/plugins/rehype-availability.ts`）。本文にリンクは無くてよい。
     *   「配信中と断定しない」だけは残す（地の文で書けてしまうので）。
     */
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

    /*
     * ★ リードは**この1組だけ**（2026-09-19）。頭の 【◯月終了済み】 も締めの文言も外した。
     *   「終了済み」と言い切る役割は固定文言そのものが持っている
     *   （終了予定の記事と一覧上で見分けがつかなくなるため、この型は固定）。
     */
    if (!md.startsWith(resolved.leadFirstSentence)) {
      err(
        '本文の冒頭がリードの固定文言と一致しません。次の1組をそのまま1行目に置いてください:\n' +
          `      ${resolved.leadFirstSentence}`,
      )
    }

    // --- 版の取り違え（公開を止める） ---

    if (!version.isUpdate && /【[^】]*更新[^】]*】/.test(md)) {
      err('初回の版なのに本文が「更新」を名乗っています。前の版がありません。')
    }
    if (version.isUpdate && version.added.length > 0) {
      const notShown = version.added
        .map((e) => e.work.localizedTitle ?? e.work.title)
        .filter((t) => t && !md.includes(t))
      if (notShown.length > 0) {
        err(
          '今回新たに終了が確認された作品が本文にありません: ' +
            notShown.slice(0, 8).map((t) => clip(t, 24)).join(' / ') +
            (notShown.length > 8 ? ' ほか' : ''),
        )
      }
    }

    // --- 文体の検査（止めない。判定が外れることがあるため） ---

    /*
     * ★ リードは1段落だけ（2026-09-19）。理由は fixed-phrases.md の
     *   `leaving-lead-first-sentence` にある（タイトルで名乗った中心作を2回読ませない）。
     */
    const leadExtra = (md.split(/\n## /, 1)[0] ?? '')
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

    for (const line of ratingMentionsInProse(md)) {
      warn(`地の文で評価に言及しています: 「${clip(line, 50)}」（評価は表にだけ載せます）`)
    }

    /*
     * ★ 締めの検査は**小段落1だけ**（2026-09-19）。
     *   小段落2は表が主役で、0〜2文しか置かないので締めの形を求めない。
     *   「見出し → 表」の順は structureIssues が全節を見ている。
     */
    for (const section of sectionsOf(md).slice(0, 1)) {
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
  /** リード。**記事の冒頭はこれ1組だけ**（2026-09-19） */
  leadFirstSentence: string
  attribution: string
  /** 記事作成日。「8月9日」形式 */
  asOf: string
}

/**
 * この記事の「版」。判定の考え方は `leaving.ts` の `versionOf` と同じ。
 * 月の途中で新たに終了が確認された作品が、更新版の主役になる。
 */
function versionOf(items: ChangeEvent[], slug: string): Version {
  const since = previousAsOf(slug)
  return { since, isUpdate: since !== undefined, added: items.filter((e) => foundSince(e, since)) }
}

interface Version {
  since: Date | undefined
  isUpdate: boolean
  added: ChangeEvent[]
}

/** 固定文言に今月の値を差し込む。プロンプトと検査で同じ結果になることが要件。 */
function resolvePhrases(
  items: ChangeEvent[],
  ctx: ArticleContext,
  version: Version,
): ResolvedPhrases {
  const vars = {
    月: articleMonth(ctx),
    // ★ items から作らない。素材が0件の月に全サービス名が並んでしまう。
    サービス: ctx.variant?.label ?? '',
    基準日: asOfLabel(ctx),
    本数: items.length,
    追加本数: version.added.length,
  }
  const get = phraseReader(fixedPhrases(ctx, REQUIRED_PHRASES), vars)

  return {
    /*
     * ★ **追加が0本の回は初回と同じ文言に落ちる**（2026-09-10 の判断・2026-09-19 に簡素化）。
     *   書き直しは素材が増えたときだけ起きるわけではない（文章の質を上げる書き直しがある）。
     *   そのとき「今回新たに0本の終了を確認し」が読者の見る1文目に出てしまう。
     */
    leadFirstSentence: get(
      version.isUpdate && version.added.length > 0
        ? 'ended-update-lead-first-sentence'
        : 'ended-lead-first-sentence',
    ),
    attribution: get('attribution'),
    asOf: vars.基準日,
  }
}
