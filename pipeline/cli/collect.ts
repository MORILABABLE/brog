/**
 * 配信状況の変化を収集する。
 *
 *   npm run collect              前回の収集からのぶん（new / removed / expiring）
 *   npm run collect -- --days 14 期間を明示する（前回の記録を無視する）
 *   npm run collect -- --kinds new,expiring
 *   npm run collect -- --plan   APIを使わず、次に何をどれだけ取るかだけ見る
 *
 * 記事化(P2)はここで貯めた data/events/*.jsonl を読む。
 * 収集と執筆を分けているのは、APIリクエストを節約しつつ
 * 記事生成だけを何度でもやり直せるようにするため。
 *
 * ■ 期間は固定ではない（2026-09-20 に `--days 7` 固定から変更）
 * 実行は火・金なので、7日固定だと**毎回3〜4日ぶんを重ねて取り直していた。**
 * 重なったぶんは台帳が落とすので記事は1件も増えず、リクエストだけが増える。
 * いまは前回の収集からの実間隔で窓を決める（core/collect-window.ts）。
 *
 * ■ `upcoming` は月に一度しか問い合わせない
 * 日本カタログでは一度も返ってきていないため（同上）。
 *
 * ■ 応答に入っている在庫を拾う（2026-09-20 追加・**APIの追加消費は0**）
 * `/changes` の応答には作品ごとの `streamingOptions`（＝いまどこで観られるか）が
 * 同梱されていて、これまで捨てていた。表の「どこで観られるか」の印は
 * `data/availability.json` から出るので、これを積むと印が増える。
 * **イベントログには何も足さない**（変化と在庫を混ぜない。core/availability.ts 冒頭）。
 */
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import type { ChangeEvent, ChangeKind } from '../sources/types.ts'
import {
  appendEvents,
  dedupe,
  eventKey,
  loadLedger,
  readAllEvents,
  saveLedger,
} from '../core/events.ts'
import { appendHistory, type StockChange } from '../core/history.ts'
import { isFresh, loadAvailability, saveAvailability } from '../core/availability.ts'
import { addUsage, monthlyPlan, warnIfLow } from '../core/api-usage.ts'
import {
  decideWindow,
  loadState,
  recordRequests,
  saveState,
  shouldProbeUpcoming,
  yearMonthOf,
} from '../core/collect-window.ts'
import {
  loadCompanyCache,
  loadOriginCache,
  loadTitleCache,
  resolveCompanies,
  resolveOrigins,
  resolveTitles,
  saveCompanyCache,
  saveOriginCache,
  saveTitleCache,
  titleCacheKey,
  type TitleRef,
} from '../sources/wikidata.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かず、環境変数を直接渡す
}

const VALID_KINDS: ChangeKind[] = ['new', 'removed', 'expiring', 'upcoming']

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const now = new Date()
  const state = await loadState()

  const explicitDays = arg('days') != null ? Number(arg('days')) : undefined
  const window = decideWindow(state, now, explicitDays)
  const sinceDays = window.days

  const explicitKinds = arg('kinds')?.split(',') as ChangeKind[] | undefined

  /*
   * `upcoming`（配信開始予定）は**月に一度しか問い合わせない**（2026-09-20）。
   *
   * 日本カタログでは一度も返ってきていない。theme.yaml の実測（2026-08・6回）で
   * 4社とも0件、2026-09-20 に `data/events/` を数え直しても
   * **APIの作品IDを持つ `upcoming` は1件も無かった**（記録上の177件は全部
   * `collect:announce` 由来の `ann-` ID）。それでも毎回 movie / series で
   * 1回ずつ投げていて、**月18回ぶんが空振りに消えていた。**
   *
   * ★ やめきらないのは、API側が返し始めたときに気づけなくなるため。
   *   月の最初の収集でだけ様子を見る（2回）。
   * ★ `--kinds` を明示した回は**そのとおりに投げる**（手で確かめる道を塞がない）。
   */
  let kinds: ChangeKind[]
  let upcomingNote = ''
  if (explicitKinds) {
    kinds = explicitKinds
  } else {
    const probe = shouldProbeUpcoming(state, now, theme.utc_offset_minutes)
    kinds = ['new', 'removed', 'expiring', ...(probe ? (['upcoming'] as ChangeKind[]) : [])]
    upcomingNote = probe
      ? '  upcoming: 今月はじめての収集なので様子を見ます'
      : `  upcoming: 今月は確認済みのため省略（${state.lastUpcomingProbeMonth}）`
  }

  const invalid = kinds.filter((k) => !VALID_KINDS.includes(k))
  if (invalid.length) {
    throw new Error(`不正な kind: ${invalid.join(', ')}（有効: ${VALID_KINDS.join(', ')}）`)
  }

  console.log(`テーマ: ${theme.label} (${theme.key})  国: ${theme.country}`)
  console.log(`対象: ${kinds.join(', ')}`)
  console.log(`期間: 直近${sinceDays}日  ${window.reason}`)
  if (upcomingNote) console.log(upcomingNote)

  /*
   * **APIを1回も使わずに、次の収集の形だけを見る**（2026-09-20 追加）。
   * 節約の効きを確かめるのに収集を1回走らせるのでは本末転倒なので、
   * 窓と kind の決まり方だけを出して終わる。記録にも触らない。
   */
  if (process.argv.includes('--plan')) {
    const plan = await monthlyPlan(theme.utc_offset_minutes)
    console.log(
      `\n今月の消費 ${plan.used}/${plan.limit}` +
        `（月末までの定期実行ぶん ${plan.reserve}回を確保・手作業に回せるぶん ${plan.spare}回）`,
    )
    console.log('--plan のためAPIは呼んでいません。記録も更新していません。')
    return
  }
  console.log()

  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY ?? '', theme)

  let raw: ChangeEvent[]
  try {
    raw = await source.collectChanges({ sinceDays, kinds })
  } finally {
    /*
     * 途中で落ちてもリクエストは消費されている。枠の記録だけは必ず残す。
     * ここを finally にしていないと、429 で落ちた回の消費が記録から抜ける。
     *
     * ★ **収集した時刻もここで残す。** 次回の窓はこれを起点に決まるので、
     *   落ちた回に書き残さないと次回が7日固定に戻り、節約が効かない。
     */
    state.lastCollectedAt = now.toISOString()
    if (kinds.includes('upcoming')) {
      state.lastUpcomingProbeMonth = yearMonthOf(now, theme.utc_offset_minutes)
    }
    /*
     * ★ **実消費を積む。** 予約枠（`scheduledRemaining`）はこれで較正される。
     *   定数のままだと、ここで節約したぶんが手作業に回らない。
     *
     *   `--days` や `--kinds` を明示した回は形が違うので積まない。
     *   手で広げた回を「定期実行はこれだけ要る」の根拠にすると予約が膨らむ。
     */
    if (explicitDays == null && !explicitKinds) {
      recordRequests(state, source.requestCount)
    }
    await saveState(state)

    const usage = await addUsage(source.requestCount, theme.utc_offset_minutes)
    console.log(
      `\nAPIリクエスト ${source.requestCount}回  ` +
        `${usage.month} の消費 ${usage.used}/${usage.limit}`,
    )
    // 何に使ったかの内訳。**削りどころはここにしか出ない**（2026-09-20 追加）。
    for (const [tag, n] of source.requestsByTag) {
      console.log(`    ${tag.padEnd(24)} ${String(n).padStart(3)}回`)
    }
    console.log()
    // ★ 残量の警告はここでも出す（2026-09-10 追加。**ここだけ抜けていた**）。
    //   availability / collect-announce / refresh-images は前から出していたが、
    //   **定期収集のログにだけ残量が出ていなかった。**
    //   9月の消費232回のうち定期実行は42回で、残りは手で叩いた分だった。
    //   ブラウザで Actions のログを見たときに残量が分かることが大事。
    warnIfLow(usage)
  }

  const ledger = await loadLedger()

  /*
   * ★ **重複として落とす前に、終了日が動いていないかを見る**（2026-09-07 追加）。
   *
   * 台帳は `service:kind:作品ID` で重複を落とす。同じ作品を二度記事にしないための
   * 仕組みで、そこは正しい。だが**そのせいで、同じ作品の2回目の `expiring`
   * （＝終了日が変わった、延長された）が丸ごと消えていた。**
   *
   *   実測（2026-09-07）: Netflix の expiring 190作のうち、
   *   同じ作品で2回記録されたものは **0件**。構造上ありえない。
   *
   * U-NEXT には `unext:refresh` があって延長に気づけるが、
   * **配信APIの4社には気づく手段が1つも無かった。**
   * `expiring` が実際に返るのは Netflix と Prime Video の2社だけなので
   * （theme.yaml の実測）、ここが**この2社で唯一「時間」を積める場所**。
   *
   * ★ **イベントは今までどおり落とす。** 記事の素材は増やさない
   *   （同じ作品を二度記事にしない決まりは変えない）。
   *   積むのは履歴だけ（`data/history/`）。
   */
  const dateShifts: StockChange[] = []
  {
    const known = new Map<string, string>()
    for (const e of await readAllEvents()) {
      if (!e.at) continue
      known.set(eventKey(e), e.at)
    }
    const observedAt = new Date().toISOString()
    for (const e of raw) {
      if (e.kind !== 'expiring' || !e.at) continue
      const was = known.get(eventKey(e))
      if (!was || was === e.at) continue
      dateShifts.push({
        observedAt,
        service: e.service,
        workId: String(e.work.id),
        title: e.work.localizedTitle ?? e.work.title,
        field: 'endDate',
        from: was,
        to: e.at,
        via: `collect --kinds ${kinds.join(',')}`,
      })
    }
  }
  if (dateShifts.length > 0) {
    console.log(`終了日が動いた作品 ${dateShifts.length}件（履歴に積みます）`)
    for (const c of dateShifts.slice(0, 10)) {
      console.log(`  ${c.title}: ${c.from?.slice(0, 10)} → ${c.to?.slice(0, 10)}`)
    }
  }

  const fresh = dedupe(raw, ledger)

  // 邦題を解決する。APIが日本語を返さないため、Wikidata(CC0)から引く。
  // 失敗しても収集は止めない（原題のまま記録される）。
  const cache = await loadTitleCache()
  const refs: TitleRef[] = fresh.map((e) => ({
    imdbId: typeof e.work.meta.imdbId === 'string' ? e.work.meta.imdbId : undefined,
    tmdbId: typeof e.work.meta.tmdbId === 'string' ? e.work.meta.tmdbId : undefined,
  }))
  await resolveTitles(refs, theme.site_language, cache)
  await saveTitleCache(cache)

  // 原語も解決する。ジャンル別記事（アニメ/洋画/邦画）の振り分けに使う。
  // 同じく Wikidata なので無料。失敗しても収集は止めない。
  const originCache = await loadOriginCache()
  await resolveOrigins(refs, originCache)
  await saveOriginCache(originCache)

  // 制作会社も解決する。「同じ制作会社の作品が一斉に配信開始」というまとまりを
  // 推測ではなく事実として書くための材料になる。
  const companyCache = await loadCompanyCache()
  await resolveCompanies(refs, theme.site_language, companyCache)
  await saveCompanyCache(companyCache)

  let resolved = 0
  for (const [i, e] of fresh.entries()) {
    const key = titleCacheKey(refs[i]!)
    const title = key ? cache[key] : undefined
    if (title) {
      e.work.localizedTitle = title
      resolved++
    }
  }

  // サービス×種別ごとの内訳を出す。取得漏れに気づくため。
  const tally = new Map<string, number>()
  for (const e of fresh) {
    const k = `${e.service} / ${e.kind}`
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...tally].sort()) {
    console.log(`  ${k.padEnd(28)} ${String(n).padStart(4)}件`)
  }

  // ★ `upcoming` を月1回に落とした前提（「日本では返ってこない」）が
  //   崩れた日に気づくため。返り始めたら毎回に戻す判断ができる。
  if (kinds.includes('upcoming') && raw.some((e) => e.kind === 'upcoming')) {
    console.log(
      '\n★ APIの upcoming が返り始めました。' +
        '月1回の様子見をやめて毎回取るか検討してください（pipeline/core/collect-window.ts）。',
    )
  }

  /*
   * ★ **応答に同梱されていた在庫を台帳へ積む**（2026-09-20 追加）。**APIは1回も増えない。**
   *
   * ■ なぜここでやるのか
   * 表の「どこで観られるか」の印は `data/availability.json` から出る
   * （`core/availability.ts` の `subscriptionServices`）。その台帳は
   * ID直引き（**1作品1リクエスト**）で埋めるしかなく、2026-09-20 の実測で
   * **イベントに出る3,989作品のうち印を出せるのは154作（4%）**だった。
   * 14日で古くなるので、ID直引きで追いかけるのは枠の上で不可能
   * （238枚を維持するだけで月476リクエスト）。
   *
   * 一方 `/changes` の応答には**最初から全作品ぶんの在庫が入っている。**
   * これまで `toWork()` が `link` を1本取り出すためだけに読んで捨てていた。
   *
   * ■ 原則は守る（`core/availability.ts` の「絶対に守ること」5）
   *   - **イベントログには何も足さない。** 変化の記録は変化のまま
   *   - 在庫は在庫の台帳へ、`via: 'changes'` と出どころを付けて入れる
   *   - `/changes` の `changes[]`（＝変化。「配信中」と書いてはいけない根拠）ではなく、
   *     同じ応答の `shows{}` が持つ `streamingOptions` を積む。**別物である**
   *
   * ■ 上書きの決まり
   * **新しいほうを残す。** 手で取った `search` / `id` のほうが必ず良いとは限らない
   * （在庫は日々変わるので、新しさがそのまま質になる）。
   * 逆に、まだ新しい既存の記録を古い収穫で潰さないよう、時刻で比べる。
   */
  {
    const stock = source.harvestedStock
    if (stock.size > 0) {
      const ledger = await loadAvailability()
      const observedAt = new Date().toISOString()
      let added = 0
      let refreshed = 0
      /** 古くなって印が消えていたものを拾い直した数。**効きはここに出る** */
      let revived = 0
      for (const [id, services] of stock) {
        const prev = ledger.works[id]
        if (prev && Date.parse(prev.fetchedAt) >= Date.parse(observedAt)) continue
        if (!prev) added++
        else if (isFresh(prev)) refreshed++
        else revived++
        // ★ `work` は触らない。あれは `--adopt` が入れる素材で、性格が違う。
        ledger.works[id] = { ...prev, fetchedAt: observedAt, via: 'changes', services }
      }
      await saveAvailability(ledger)
      const total = Object.keys(ledger.works).length
      console.log(
        `在庫を収穫 ${stock.size}件` +
          `（新規 ${added} / 期限切れを復活 ${revived} / 更新 ${refreshed}）` +
          `  台帳の合計 ${total}件  **APIの追加消費なし**`,
      )
    }
  }

  await appendEvents(fresh, theme.utc_offset_minutes)
  await appendHistory(dateShifts, theme.utc_offset_minutes)
  ledger.seen.push(...fresh.map(eventKey))
  await saveLedger(ledger)

  console.log(
    `\n取得 ${raw.length}件 / 新規 ${fresh.length}件（${raw.length - fresh.length}件は既出のため除外）`,
  )
  if (fresh.length > 0) {
    const pct = Math.round((resolved / fresh.length) * 100)
    console.log(`邦題解決 ${resolved}/${fresh.length}件 (${pct}%)  ※残りは原題のまま`)
  }
  if (fresh.length === 0 && raw.length > 0) {
    console.log('すべて既出でした。期間を延ばすか、次回の実行を待ってください。')
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
