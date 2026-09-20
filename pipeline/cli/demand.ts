/**
 * **いま検索されている作品のうち、当サイトが答えを持っているものを出す。**
 *
 *   npm run demand                    取得して貯めて、候補を出す（直近7日）
 *   npm run demand -- --days 14       突き合わせに使う日数を変える
 *   npm run demand -- --no-fetch      取得しない（貯めてあるぶんだけで出す・通信なし）
 *   npm run demand -- --suggest       上位の候補に**語形の確認**をかける（サジェスト）
 *   npm run demand -- --limit 40      表示する件数
 *   npm run demand -- --all           落とした語も理由つきで出す（切り分け用）
 *   npm run demand -- --picks         サイトに出すぶんを data/demand-picks.json に書く
 *   npm run demand -- --notify        **新規記事の候補**があれば Issue で知らせる
 *   npm run demand -- --trend "ハリー・ポッターシリーズ"
 *                                     **1つの記事の日次推移**（第二波の観測。下の■）
 *
 * ■ このコマンドは記事を作らない
 * 出すのは**候補の一覧まで**。どの記事にするか・主題を何と呼ぶかは人が決める
 * （`npm run write -- --list` の「シリーズ候補」と同じ立場）。
 *
 * ■ 出口は3つ（docs/DEMAND.md 6節）。**自動化できる範囲が違う**
 *
 *   A 押し出し   `--picks`   … サイトに出す。**完全自動**。記事（.md）には触らない
 *   B 新規記事   `--notify`  … 束かつシリーズ記事が無いものだけ Issue で知らせる。**人が書く**
 *   C 需要の取得 （既定）     … Search Console を3つ目の取得元にする（`demand-queries.ts`）
 *
 * ★ **B を自動生成にしていない理由は2つ。**
 *   1. `/article` は課金を避けて**このセッションで書く**作りになっている（LLM APIを使わない）
 *   2. **単発の話題作品に新記事を作らないと決めてある**（docs/DEMAND.md 6-2 の🔴）。
 *      実測（2026-09-16）で候補32件のうち束は1件だけで、
 *      **残り31件の正しい受け皿は作品ページ**。それはもう存在する
 *
 * ■ 需要の取得元は3つ。**数字を1つに畳まない**
 * Wikipedia（万の桁）・トレンド（推定検索数）・Search Console（表示回数・十〜百の桁）。
 * 畳むと Search Console 側が必ず負ける（`五等分の花嫁 232` 対 `VIVANT 45,561`）が、
 * **当サイトの読者に近いのは後者**。並び順では Search Console を先に見る
 * （`demand-match.ts` の並び順の★）。
 *
 * ■ 何をしているか（3つ）
 *   1. 需要を取る    … Wikipedia 日本語版の日次 top 1000／Google トレンド（JP）
 *                      ／**Search Console の検索語**（取り込み済みのファイルを読むだけ）
 *   2. 在庫と突き合わせる … 観測（data/events）のある作品だけを在庫とする
 *   3. 貯める        … トレンドは全行、Wikipedia は**当たった語だけ**
 *      （あちらは過去日を取り直せるため。`pipeline/core/demand-store.ts`）
 *      Search Console は**貯めない**（`data/search-queries.json` が既に台帳）
 *
 * ■ API課金なし
 * 使うのは無料の公開APIだけ。**Streaming Availability API も LLM も呼ばない。**
 *
 * ■ `--trend` は何のためにあるか（2026-09-15）
 * `/posts/harry-potter` は9/2〜9/12に流入が集中し、**9/13以降ゼロ**になった。
 * だが Wikipedia で測ると「ハリー・ポッターシリーズ」は
 * **1日1,400〜1,800回で横ばい**で、需要そのものは消えていない。
 * 落ちたのは**「配信終了」というニュースの語**のほうだった。
 *
 * **終了日（9/30）の直前にもう一度山が来るのかは、まだ誰も知らない。**
 * 来るなら「期限前に書き直す」運用に意味があり、来ないなら無い。
 * `--trend` はそれを**測るための口**で、判断そのものは人がする。
 *
 * ■ 収集（npm run collect）との関係
 * 在庫の側は週2回（火・金 JST）しか動かない。需要の側は日次で動く。
 * **ずれていて構わない。** 話題が先に立ち、在庫は次の収集で追いつく。
 * 逆に、収集の直後に実行すると当たりが増える。
 */
import { readAllEvents } from '../core/events.ts'
import { daysUntil, formatMonthDay } from '../core/datetime.ts'
import {
  buildInventory,
  loadExcludedIds,
  loadNgWords,
  loadPeople,
  matchDemand,
  type DemandCandidate,
} from '../core/demand-match.ts'
import { readAllDemand, saveDemand } from '../core/demand-store.ts'
import { readSearchConsoleDemand } from '../core/demand-queries.ts'
import { buildPicks, readPicks, savePicks, DEMAND_PICKS_PATH } from '../core/demand-picks.ts'
import { createChannels } from '../notify/index.ts'
import { readPublishedPosts, POSTS_DIR } from '../core/coverage.ts'
import { fetchArticleTrend, fetchRecentPageviews } from '../sources/demand/wikipedia-pageviews.ts'
import { fetchTrends } from '../sources/demand/google-trends.ts'
import { fetchSuggests, QUESTION_SHAPES } from '../sources/demand/google-suggest.ts'
import type { DemandSignal } from '../sources/demand/types.ts'
import { signalKey } from '../core/demand-store.ts'

/** 既定で何日ぶんの話題を見るか。短いと瞬間の話題しか出ず、長いと古い話題が混ざる */
const DEFAULT_DAYS = 7

/** 既定の表示件数 */
const DEFAULT_LIMIT = 30

/** `--suggest` で語形を確認する上限。**叩きすぎない**（0.4秒間隔） */
const SUGGEST_LIMIT = 10

const flag = (name: string) => process.argv.includes(`--${name}`)
function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 答えの型の表示 */
const ANSWER_LABEL: Record<DemandCandidate['answer'], string> = {
  until: 'いつまで',
  where: 'どこで  ',
  // ★ 幅を揃える（一覧が縦に読めなくなるため）。中身は「終わった」
  ended: '終了済み',
}

/** シリーズ記事の目印。`series-candidates.ts` の同名の定数と揃えること */
const SERIES_TAG = 'シリーズ'

function line(c: DemandCandidate): string {
  const head = `[${ANSWER_LABEL[c.answer]}] ${c.word}`
  /*
   * ★ **Search Console だけで出てきた候補は「話題」を名乗らせない。**
   *   `話題 0／0日` と出ると、需要が無いのに候補に出ているように読める。
   *   実際には需要の出どころが違うだけ（当サイトの検索結果に出ている）。
   */
  const topic = c.peak > 0 ? `話題 ${c.peak.toLocaleString()}／${c.days}日` : ''
  const stock =
    c.how === 'exact' ? `在庫 ${c.works.length}作` : `在庫 ${c.works.length}作（束）`
  const when = c.deadline
    ? `終了 ${formatMonthDay(c.deadline)}（あと${daysUntil(c.deadline)}日）`
    : c.endedAt
      ? `終了 ${formatMonthDay(c.endedAt)}`
      : ''
  /*
   * ★ **当サイトの検索結果での実測。** 話題（外の数字）と並べて出し、畳まない。
   *   ここが入っている候補は「もう出ているが取れていない」で、
   *   打つ手がいちばん短い（書かなくてよい。押し出すだけでよい）。
   */
  const search = c.search
    ? `検索 表示${c.search.impressions}・クリック${c.search.clicks}・${c.search.position}位`
    : ''
  const money = c.affiliates.length > 0 ? `導線 ${c.affiliates.join('/')}` : '導線なし'
  /*
   * ★ **記事があることは「済み」ではない。** 話題が立っているのに記事が古い、
   *   という状態がいちばん取りこぼしやすい。1本だけ出して、残りは件数で示す。
   */
  const covered =
    c.covered.length > 0
      ? `記事あり ${c.covered[0]}${c.covered.length > 1 ? ` ほか${c.covered.length - 1}本` : ''}`
      : ''
  return [head, topic, search, stock, c.services.join(','), when, money, covered]
    .filter(Boolean)
    .join('  ')
}

/**
 * 1つの記事の日次推移を出す。
 *
 * ★ **判定は「直近7日 ÷ その前7日」だけ。** 統計的な検定はしない。
 *   ここで欲しいのは「山が来ているかどうか」の粗い当たりで、
 *   細かい判定を足すほどデータは無い（この口は1記事ぶんしか返さない）。
 */
async function trend(article: string, days: number): Promise<void> {
  const rows = await fetchArticleTrend(article, days)
  if (rows.length === 0) {
    console.log(`「${article}」は0件でした。`)
    console.log('**Wikipedia の記事名そのまま**で渡してください（曖昧さ回避の括弧も含めて）。')
    return
  }
  console.log(`【${article}】直近${rows.length}日`)
  console.log('  ' + rows.map((r) => `${r.day.slice(5)}:${r.views}`).join(' '))

  const last7 = rows.slice(-7)
  const prev7 = rows.slice(-14, -7)
  const avg = (xs: { views: number }[]) =>
    xs.length ? Math.round(xs.reduce((a, x) => a + x.views, 0) / xs.length) : 0
  const now = avg(last7)
  const before = avg(prev7)
  const ratio = before > 0 ? now / before : 0
  const verdict = ratio >= 1.2 ? '上昇' : ratio <= 0.8 ? '下降' : '横ばい'
  console.log('')
  console.log(`  直近7日の平均 ${now}／その前7日 ${before}  → **${verdict}**（${ratio.toFixed(2)}倍）`)
  console.log('')
  console.log('  ※ この数字は記事に書かない。当サイトの観測ではない。')
}

async function main(): Promise<void> {
  const days = Number(value('days') ?? DEFAULT_DAYS)
  const limit = Number(value('limit') ?? DEFAULT_LIMIT)

  const word = value('trend')
  if (flag('trend')) {
    if (!word) {
      console.log('記事名を渡してください:  npm run demand -- --trend "ハリー・ポッターシリーズ"')
      return
    }
    await trend(word, Number(value('days') ?? 30))
    return
  }

  /* ---- 1. 需要を取る --------------------------------------------------- */
  const fetched: DemandSignal[] = []
  if (!flag('no-fetch')) {
    console.log(`需要を取得します（Wikipedia ${days}日ぶん ＋ Google トレンド）…`)
    try {
      const rows = await fetchRecentPageviews(days, 2, (day, count) => {
        console.log(`  Wikipedia ${day}  ${count}件`)
      })
      fetched.push(...rows)
    } catch (err) {
      // 片方が落ちてももう片方で続ける。**候補が0件になるだけで、壊れてはいない**
      console.warn(`  ! Wikipedia の取得に失敗: ${err instanceof Error ? err.message : err}`)
    }
    try {
      const rows = await fetchTrends('JP')
      console.log(`  Google トレンド  ${rows.length}件`)
      fetched.push(...rows)
    } catch (err) {
      console.warn(`  ! Google トレンドの取得に失敗: ${err instanceof Error ? err.message : err}`)
    }
  }

  /* ---- 2. 在庫と突き合わせる ------------------------------------------- */
  const events = await readAllEvents()
  const inventory = buildInventory(events, loadExcludedIds())

  // 貯めてあるぶんと今回ぶんを混ぜる。同じ日・同じ語は大きいほうを採る
  const stored = await readAllDemand()
  const cutoff = new Date(Date.now() - (days + 2) * 86_400_000).toISOString().slice(0, 10)
  const merged = new Map<string, DemandSignal>()
  for (const s of [...stored, ...fetched]) {
    if (s.day < cutoff) continue
    const prev = merged.get(signalKey(s))
    if (!prev || s.count > prev.count) merged.set(signalKey(s), s)
  }

  /*
   * Search Console。**取り込み済みのファイルを読むだけで、通信しない。**
   *
   * ★ **日付の足切り（`cutoff`）に掛けない。** あちらの1行は28日の集計で、
   *   `day` には集計期間の末日が入る。取り込みが週1回なので、
   *   足切りに掛けると**最大7日ぶん古いだけで全部落ちる。**
   *   使うのは「いま当サイトが何位で出ているか」であって、その日の話題ではない。
   */
  const sc = readSearchConsoleDemand(inventory)
  if (sc.signals.length > 0) {
    console.log(
      `  Search Console  ${sc.signals.length}作品（${sc.range.start}〜${sc.range.end} の集計・` +
        `当たらなかった検索語 ${sc.unmatched}件）`,
    )
  } else {
    console.log('  Search Console  0件（data/search-queries.json が無いか、在庫に当たらなかった）')
  }

  /*
   * 取り込みが**止まっていること**を言う。
   *
   * ★ 上の行は集計期間を出すが、**古いこと自体は言わない。** ファイルが
   *   凍っていても、もっともらしい期間が毎日表示されるだけになる。
   *   2026-09-06〜09-20 に実際に踏んだ: queries が GSC_SERVICE_ACCOUNT_JSON
   *   未登録で3週続けて落ち、その間この行は 08-03〜08-31 を出し続けていた。
   *
   * 14日にしているのは、取り込みが週1回（queries.yml）なので
   * **1回飛ばしたら気づける幅**（check-ads.ts の45日と同じ考え方で、
   * あちらは月1回の運用だから45日）。
   */
  const scFetchedAt = sc.fetchedAt ? Date.parse(sc.fetchedAt) : NaN
  const scStaleDays = Number.isNaN(scFetchedAt) ? Infinity : (Date.now() - scFetchedAt) / 86_400_000
  if (sc.signals.length > 0 && scStaleDays > 14) {
    console.log(
      `  ⚠ 検索語の取り込みが止まっています（${Math.floor(scStaleDays)}日前）。` +
        'queries.yml の実行結果を見てください（npm run queries で手元からも取り込めます）。',
    )
  }

  const posts = await readPublishedPosts(POSTS_DIR)
  const report = matchDemand([...merged.values(), ...sc.signals], inventory, {
    ngWords: loadNgWords(),
    people: loadPeople(),
    // ★ 記事があっても候補から外さない（`DemandCandidate.covered` の★）
    posts,
  })

  console.log('')
  console.log(
    `在庫 ${inventory.size}作品（観測のあるもの）／ 需要 ${report.words}語（${cutoff} 以降）`,
  )

  /* ---- 3. 貯める ------------------------------------------------------- */
  if (fetched.length > 0) {
    /*
     * ★ **Wikipedia は当たった語だけ貯める。** 過去日を取り直せるので、
     *   当たらなかった999件を抱える理由がない（理由は demand-store.ts の表）。
     *   トレンドは当日ぶんしか返らないので全行貯める。
     */
    const kept = new Set(report.candidates.map((c) => c.word))
    /*
     * ★ Search Console はここに入らない（`fetched` に積んでいない）。
     *   **復元できるものは貯めない** — `data/search-queries.json` そのものが台帳で、
     *   同じ28日を投げ直せば同じ値が返る（demand-store.ts の表と同じ判断）。
     */
    const toSave = fetched.filter((s) => s.source === 'google-trends' || kept.has(s.word))
    const saved = await saveDemand(toSave)
    console.log(
      `貯めました: 新規 ${saved.added}行／更新 ${saved.updated}行／据え置き ${saved.skipped}行` +
        `（Wikipedia は在庫に当たった語のみ）`,
    )
  }

  /* ---- 4. 出す --------------------------------------------------------- */
  const shown = report.candidates.slice(0, limit)

  if (flag('json')) {
    console.log(JSON.stringify({ ...report, candidates: shown }, null, 2))
    return
  }

  console.log('')
  console.log(`  話題があり、当サイトが答えを持っている作品（${report.candidates.length}件）`)
  console.log(`  ${'-'.repeat(72)}`)
  if (shown.length === 0) {
    console.log('  0件でした。収集の直後（火・金）に実行すると当たりが増えます。')
  }
  for (const c of shown) {
    console.log(`  ${line(c)}`)
    console.log(`      ${c.works.slice(0, 3).map((w) => w.title).join(' / ')}`)
  }
  if (report.candidates.length > shown.length) {
    console.log(`  … ほか ${report.candidates.length - shown.length}件（--limit で増やせる）`)
  }

  console.log('')
  console.log('  ※ 話題の数字（閲覧数・検索数）は**記事に書かない**。主題を選ぶまでの手がかり。')
  console.log('  ※ 作品でない語が混ざっていたら data/demand-ng.json に足す。')

  if (flag('all')) {
    console.log('')
    console.log('  落とした語の内訳')
    console.log(`  ${'-'.repeat(72)}`)
    if (flag('no-fetch')) {
      /*
       * ★ **--no-fetch では「在庫に無い」が実態より小さく出る。**
       *   Wikipedia は在庫に当たった語しか貯めていないので（demand-store.ts）、
       *   貯めたぶんだけを読むと、落ちた999件がそもそも手元にない。
       *   内訳を見たいときは取得しながら実行すること。
       */
      console.log('  ※ --no-fetch では「在庫に無い」は実態より小さく出る（当たった語しか貯めていない）。')
    }
    for (const [reason, count] of Object.entries(report.dropped).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)}  ${reason}`)
    }
  }

  /* ---- 5. 語形の確認（任意） ------------------------------------------- */
  if (flag('suggest') && shown.length > 0) {
    const seeds = shown.slice(0, SUGGEST_LIMIT).map((c) => `${c.word} 配信`)
    console.log('')
    console.log(`  読者がその作品に付けている問い（サジェスト・${seeds.length}語）`)
    console.log(`  ${'-'.repeat(72)}`)
    for (const r of await fetchSuggests(seeds)) {
      const shapes = r.shapes
        .map((k) => QUESTION_SHAPES.find((s) => s.key === k)?.label ?? k)
        .join('・')
      console.log(`  ${r.seed}`)
      console.log(`      ${r.candidates.slice(0, 6).join(' / ') || '（候補なし）'}`)
      if (shapes) console.log(`      → ${shapes}`)
    }
    console.log('')
    console.log('  ※ サジェストは検索ボリュームではない。その語形で検索されているか、だけ。')
  }

  /* ---- 6. 出口A: サイトに出すぶんを書く（--picks） --------------------- */
  if (flag('picks')) {
    const previous = await readPicks()
    const built = buildPicks(report.candidates, previous)
    console.log('')
    if (!built.changed) {
      /*
       * ★ **同じ回は書かない。** 書けばコミットが立ち、Cloudflare Pages の
       *   再ビルドが走る。中身が変わっていないのに毎日サイトを作り直すのは、
       *   `queries.yml` が「中身が同じならファイルを書かない」としているのと同じ理由。
       */
      console.log(`  ${DEMAND_PICKS_PATH} は変わりませんでした（書いていません）。`)
    } else {
      if (!flag('dry-run')) await savePicks(built.file)
      console.log(
        `  ${DEMAND_PICKS_PATH} ${flag('dry-run') ? 'に書く内容' : 'を更新'}: ` +
          `${built.file.picks.length}件（新規 ${built.added}／持ち越し ${built.kept}／落とした ${built.dropped}）`,
      )
      for (const p of built.file.picks.slice(0, 8)) {
        const when = p.deadline ? `終了 ${formatMonthDay(p.deadline)}` : ANSWER_LABEL[p.answer].trim()
        console.log(`      ${p.title}  ${when}  ${p.services.join(',')}`)
      }
    }
    console.log('  ※ 需要の数字はこのファイルに入れていない（並び順だけが需要を反映する）。')
  }

  /* ---- 7. 出口B: 新規記事の候補を知らせる（--notify） ------------------ */
  if (flag('notify')) await notifyNewArticles(report.candidates, posts)
}

/**
 * **シリーズ記事にできる束のうち、まだ記事が無いものだけ**を Issue で知らせる。
 *
 * ■ なぜこれだけなのか
 * docs/DEMAND.md 6-2 の🔴 —「単発の話題作品に新しい記事タイプを作らない」。
 * 単発は `/works/<id>` とほぼ同じ内容になり、**自サイト内で食い合う。**
 * 実測（2026-09-16）で候補32件のうち束は1件だけなので、**この通知は滅多に鳴らない。**
 * 鳴らないことが正しい状態で、鳴ったときだけ手を動かす。
 *
 * ■ なぜ記事を自動生成しないのか
 * `/article` は課金を避けて**セッションの中で書く**作りになっている。
 * ここから LLM を呼ぶと、その設計を回避して毎日課金する道ができる。
 *
 * ★ **顔ぶれで重複を止める。** 書くまで同じ束が毎日候補に出るので、
 *   日付で持つと鳴りっぱなしになる（`notify/state.ts` の `staleSignature` と同じ）。
 */
async function notifyNewArticles(
  candidates: DemandCandidate[],
  posts: { slug: string; tags: string[]; draft: boolean }[],
): Promise<void> {
  const seriesSlugs = new Set(
    posts.filter((p) => !p.draft && p.tags.includes(SERIES_TAG)).map((p) => p.slug),
  )
  const targets = candidates.filter(
    (c) => c.how === 'bundle' && !c.covered.some((slug) => seriesSlugs.has(slug)),
  )

  const previous = await readPicks()
  const signature = targets.map((c) => c.word).sort().join('|')

  if (targets.length === 0) {
    console.log('')
    console.log('  新規記事の候補（束・シリーズ記事なし）: 0件。通知しません。')
    if (signature !== previous.notifiedSignature && !flag('dry-run')) {
      // 顔ぶれが空に戻ったことも記録する（次に出たとき確実に鳴らせる）
      await savePicks({ ...previous, notifiedSignature: signature })
    }
    return
  }
  if (signature === previous.notifiedSignature) {
    console.log('')
    console.log(`  新規記事の候補 ${targets.length}件。**前回と同じ顔ぶれ**なので通知しません。`)
    return
  }

  const body = [
    '**話題があり、答えを持っていて、まだシリーズ記事が無い束です。**',
    '',
    '単発の作品は載せていません（作品ページと食い合うため。docs/DEMAND.md 6-2）。',
    '',
    ...targets.flatMap((c) => [
      `### ${c.word}`,
      '',
      `- 在庫 ${c.works.length}作 ／ ${c.services.join(' / ')}`,
      c.deadline ? `- 最短の終了予定 ${formatMonthDay(c.deadline)}（あと${daysUntil(c.deadline)}日）` : undefined,
      c.search
        ? `- 検索実測 表示${c.search.impressions}・クリック${c.search.clicks}・${c.search.position}位` +
          (c.search.queries[0] ? `（例: ${c.search.queries[0]}）` : '')
        : undefined,
      c.affiliates.length > 0 ? `- 導線 ${c.affiliates.join(' / ')}` : '- 導線なし',
      `- 作品: ${c.works.slice(0, 6).map((w) => w.title).join(' / ')}`,
      '',
      '```',
      `npm run write -- --type series --topic "「?」シリーズ" --slug ? --match "${c.word}" --dry-run`,
      '```',
      '',
    ]),
    '---',
    '',
    '`--topic` と `--slug` は人が決めます（束の名前をそのまま主題にしない）。',
    '書き出しは `/article`。**このコマンドは記事を作りません。**',
  ]
    /*
     * ★ **空行は残す。** ここで落としてよいのは「条件が合わず出さなかった行」
     *   （`undefined`）だけ。空文字まで落とすと、見出しと箇条書きのあいだの
     *   空行が消えて **Markdown が段落として描かれなくなる**（2026-09-16 に実際に出した）。
     */
    .filter((l): l is string => l !== undefined)
    .join('\n')

  const notification = {
    subject: `新規記事の候補 ${targets.length}件（需要 × 在庫）`,
    body,
  }

  if (flag('dry-run')) {
    console.log('')
    console.log(`  --dry-run のため送りません。件名: ${notification.subject}`)
    console.log(body)
    return
  }

  for (const channel of createChannels(value('channel'))) {
    await channel.send(notification)
    console.log(`  ${channel.name} に送りました: ${notification.subject}`)
  }
  await savePicks({ ...previous, notifiedSignature: signature })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
