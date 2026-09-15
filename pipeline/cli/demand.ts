/**
 * **いま検索されている作品のうち、当サイトが答えを持っているものを出す。**
 *
 *   npm run demand                    取得して貯めて、候補を出す（直近7日）
 *   npm run demand -- --days 14       突き合わせに使う日数を変える
 *   npm run demand -- --no-fetch      取得しない（貯めてあるぶんだけで出す・通信なし）
 *   npm run demand -- --suggest       上位の候補に**語形の確認**をかける（サジェスト）
 *   npm run demand -- --limit 40      表示する件数
 *   npm run demand -- --all           落とした語も理由つきで出す（切り分け用）
 *   npm run demand -- --trend "ハリー・ポッターシリーズ"
 *                                     **1つの記事の日次推移**（第二波の観測。下の■）
 *
 * ■ このコマンドは記事を作らない
 * 出すのは**候補の一覧まで**。どの記事にするか・主題を何と呼ぶかは人が決める
 * （`npm run write -- --list` の「シリーズ候補」と同じ立場）。
 * 候補から記事への振り分けは docs/DEMAND.md の「4. 未着手」に置いてある。
 *
 * ■ 何をしているか（3つ）
 *   1. 需要を取る    … Wikipedia 日本語版の日次 top 1000／Google トレンド（JP）
 *   2. 在庫と突き合わせる … 観測（data/events）のある作品だけを在庫とする
 *   3. 貯める        … トレンドは全行、Wikipedia は**当たった語だけ**
 *      （あちらは過去日を取り直せるため。`pipeline/core/demand-store.ts`）
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
}

function line(c: DemandCandidate): string {
  const head = `[${ANSWER_LABEL[c.answer]}] ${c.word}`
  const topic = `話題 ${c.peak.toLocaleString()}／${c.days}日`
  const stock =
    c.how === 'exact' ? `在庫 ${c.works.length}作` : `在庫 ${c.works.length}作（束）`
  const when = c.deadline
    ? `終了 ${formatMonthDay(c.deadline)}（あと${daysUntil(c.deadline)}日）`
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
  return [head, topic, stock, c.services.join(','), when, money, covered]
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

  const report = matchDemand([...merged.values()], inventory, {
    ngWords: loadNgWords(),
    people: loadPeople(),
    // ★ 記事があっても候補から外さない（`DemandCandidate.covered` の★）
    posts: await readPublishedPosts(POSTS_DIR),
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
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
