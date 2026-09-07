/**
 * これから書く記事の作品について、**いまどこで観られるか**を取る。
 *
 *   npm run write -- --type series --topic "「◯◯」シリーズ" --slug x --match ◯◯ --emit
 *   npm run availability                ← ここで在庫を取る
 *   npm run write -- ... --emit         ← もう一度出すと、素材に在庫が入る
 *
 *   npm run availability -- --dry-run   取って表示するだけ（**枠は消費する**）
 *   npm run availability -- --keyword "Harry Potter"   キーワードを指定する
 *   npm run availability -- --max-by-id 5   ID直引きの上限（既定12・1件1リクエスト）
 *   npm run availability -- --no-by-id      ID直引きをしない（キーワードだけ）
 *   npm run availability -- --ids 138947,2699508   作品IDを直に指定する（下書きを見ない）
 *   npm run availability -- --adopt --match "仮面ライダー|風都探偵"
 *                                       下書きに無い作品も**素材として**台帳に入れる
 *
 * ■ `--adopt` — 変化ログに出ない作品を拾う（2026-09-07 追加）
 * 既定の動きは「**下書きに載っている作品**の在庫を注釈する」だけで、
 * キーワード検索が返した他の作品は捨てていた（`wanted.has(id)` の行）。
 * だが素材そのものは `/changes`（変化ログ）だけから作られていて、
 * **収集を始める前から在庫にある作品は、何年経っても記事に出ない。**
 *
 *   実測（2026-09-07・「仮面ライダー」）
 *     変化ログ由来の素材            11本（すべて8月31日に new が立った分）
 *     在庫で Prime Video の見放題    14本
 *     → シン・仮面ライダー / 仮面ライダーBLACK SUN / 風都探偵 が欠けていた
 *
 * `--adopt` は**見放題（subscription）で観られる作品だけ**を、
 * 作品そのものごと台帳に入れる。シリーズ記事の `select()` がそれを読んで
 * 「見放題配信中」の素材に加える（`article-types/series.ts` の `stockEvents`）。
 *
 * ★ **`--match` で必ず絞ること。** 絞らないとキーワードに引っかかった
 *   無関係な作品まで台帳に入り、次のシリーズ記事の素材に混ざる。
 * ★ **`addon` を拾わない。** Prime Video チャンネル（東映特撮ファンクラブ等）は
 *   別料金で、見放題ではない（core/availability.ts の「絶対に守ること」1）。
 *   実測では「仮面ライダー」93作のうち17作が addon だった。
 *
 * ■ なぜ `--emit` のあとなのか
 * **調べる対象は「その記事に載る作品」だけでよい。**
 * `--emit` が `data/draft/context.json` に確定した作品リストを書いているので、
 * それを読めば選び方を二重に持たずに済む（`npm run research` と同じ流れ）。
 *
 * ■ 何を取るのか
 * `/shows/search/filters` の `streamingOptions.jp[]` ＝ **その時点の在庫**。
 * `/changes`（変化の観測）とは根拠が違うので、置き場所も分けてある
 * （`data/availability.json`。core/availability.ts の冒頭）。
 *
 * ■ 枠の消費
 * **1キーワード＝1〜3リクエスト**（ページングした場合）。無料枠は500/月。
 * 実測（2026-09-06）で `keyword=Harry Potter` が **8作品を1リクエスト**で返した。
 * 作品ごとに `/shows/{id}` を叩くと559リクエストになって枠を超えるので、
 * **キーワードでまとめて取るのがこの施策の前提**（docs/CROSS-SERVICE.md 9-4）。
 *
 * ★ **キーワードは記事の主題から作る。** `--topic "「ハリー・ポッター」シリーズ"`
 *   のような日本語の主題からは当たらないことがある（APIの題名は英語）。
 *   当たらなければ `--keyword` で原題を渡すこと。**推測で日本語を投げ続けない。**
 *
 * ★ **`--ids` は「表に残っているのに素材から外れた作品」のためにある。**
 *   記事の書き直しは前の版の表の行を落とさない（templates/series.md）ので、
 *   **表にはあるが今回の素材には無い**作品が出る。下書きから作る `wanted` には
 *   入らないため、在庫が永久に取れず、表のその行だけ印が出ない
 *   （2026-09-06 にコナンで踏んだ。`名探偵コナン 緋色の不在証明` など3件）。
 *   IDは `data/events/*.jsonl` の `work.id`。**SID… は渡さない**（U-NEXTのIDは当たらない）。
 *
 * ★ **取れなかった作品を「無い」と書かせない。** 台帳に載らなかった作品は
 *   `data/availability.json` に現れない ＝ 記事側は「分からない」として扱う。
 *   0件と未取得を混同すると、**在庫が無いと断定する記事**ができる。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import { addUsage } from '../core/api-usage.ts'
import { readAllEventsSync, withJapaneseWorkTitle } from '../core/events.ts'
import { appendHistory, type StockChange } from '../core/history.ts'
import {
  loadTitleCache,
  resolveTitles,
  saveTitleCache,
  titleCacheKey,
  type TitleRef,
} from '../sources/wikidata.ts'
import type { Work } from '../sources/types.ts'
import {
  AVAILABILITY_PATH,
  loadAvailability,
  saveAvailability,
  isFresh,
  subscriptionServices,
  type WorkAvailability,
} from '../core/availability.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

const CONTEXT_PATH = join('data', 'draft', 'context.json')

interface DraftContext {
  typeId?: string
  flags?: Record<string, string>
  items?: { work?: { id?: string | number; title?: string; localizedTitle?: string } }[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

/**
 * U-NEXT 由来の作品か。**IDの体系が配信APIと違う**（`SID0240341` の形）。
 *
 * ★ この作品はキーワード検索でも**絶対に一致しない。**
 *   IDが別体系なうえ、[GROWTH 2-3](../../docs/GROWTH.md) で
 *   U-NEXT をカタログとして扱わないと決めてある。
 *   「取れなかった」に数えると、毎回必ず失敗が出て警告が意味を失う。
 */
function isUnextWork(id: string): boolean {
  return /^SID/i.test(id)
}

/**
 * 記事の下書きから検索キーワードを決める。
 *
 * ★ **ラテン文字の題だけを使う。** APIの `keyword` は英語の題に当たる。
 *   素材の `title` は配信API由来なら原題（英語）だが、
 *   **U-NEXT 由来の作品は最初から邦題**で、原題を持たない。
 *   混ぜると日本語を投げて0件になる（2026-09-06 に1リクエスト無駄にした）。
 *
 * ★ 原題から**共通の頭**を取る。シリーズは
 *   「Harry Potter and the ...」のように前方が揃うため。
 *
 * ★ **決まらなければ undefined を返す。** 当てずっぽうで投げない。
 *   1回の失敗が無料枠を1つ食う。呼び出し側が `--keyword` を促す。
 */
function keywordFrom(items: DraftContext['items']): string | undefined {
  const titles = (items ?? [])
    .filter((e) => e.work?.id == null || !isUnextWork(String(e.work.id)))
    .map((e) => e.work?.title)
    // ラテン文字を半分以上含む題だけ（日本語の題を除く）
    .filter((t): t is string => !!t && (t.match(/[A-Za-z]/g)?.length ?? 0) >= t.length / 2)
  if (titles.length === 0) return undefined
  if (titles.length === 1) return titles[0]

  const words = titles.map((t) => t.split(/\s+/))
  const head: string[] = []
  for (let i = 0; i < words[0]!.length; i++) {
    const w = words[0]![i]!
    if (!words.every((ws) => ws[i]?.toLowerCase() === w.toLowerCase())) break
    head.push(w)
  }
  // 1語だけの共通頭（"The" など）は当たりが広すぎるので使わない
  return head.length >= 2 ? head.join(' ') : titles[0]
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const apiKey = process.env.STREAMING_API_KEY
  if (!apiKey) {
    console.error('STREAMING_API_KEY が未設定です。.env を確認してください。')
    process.exitCode = 1
    return
  }

  let ctx: DraftContext = {}
  try {
    ctx = JSON.parse(await readFile(CONTEXT_PATH, 'utf8')) as DraftContext
  } catch {
    // --keyword を直接渡す使い方なら下書きは要らない
  }

  /*
   * `--ids` は下書きを見ない別経路。**1件1リクエスト**なので、
   * 数件の取りこぼしを埋めるためだけに使う（まとめて取るならキーワード）。
   */
  const explicitIds = (arg('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (explicitIds.length > 0) {
    const ledger = await loadAvailability()
    const source = new StreamingAvailabilitySource(apiKey, theme)
    const fetchedAt = new Date().toISOString()
    let hit = 0
    for (const id of explicitIds) {
      if (isUnextWork(id)) {
        console.log(`  ${id} … U-NEXTのIDなので飛ばします（配信APIのIDではありません）`)
        continue
      }
      const row = await source.fetchAvailabilityById(id)
      if (!row) {
        console.log(`  ${id} … APIに無し`)
        continue
      }
      hit++
      if (!has('dry-run')) ledger.works[id] = { fetchedAt, services: row.services }
      const subs = row.services.filter((s) => s.types.includes('subscription')).map((s) => s.service)
      console.log(`  ${id} … 見放題: ${subs.join(' / ') || '（なし）'}`)
    }
    await addUsage(source.requestCount, theme.utc_offset_minutes)
    if (!has('dry-run') && hit > 0) await saveAvailability(ledger)
    console.log(`
台帳に入れた: ${hit}件 / 指定 ${explicitIds.length}件  リクエスト: ${source.requestCount}`)
    return
  }

  const keyword = arg('keyword') ?? keywordFrom(ctx.items)
  if (!keyword) {
    console.log('検索キーワードが決まりません。**投げずに止めます**（1回の失敗が枠を1つ食うため）。')
    console.log('  先に  npm run write -- ... --emit  を走らせるか、')
    console.log('  原題を  --keyword "Harry Potter"  のように渡してください。')
    console.log('  ★ APIの題名は英語です。日本語の主題からは当たりません。')
    return
  }

  const ledger = await loadAvailability()
  const wanted = new Map<string, string>()
  for (const e of ctx.items ?? []) {
    const id = e.work?.id
    if (id == null) continue
    // ★ U-NEXT 由来は最初から対象外。IDの体系が違い、絶対に一致しない。
    if (isUnextWork(String(id))) continue
    wanted.set(String(id), e.work?.localizedTitle ?? e.work?.title ?? '')
  }

  /*
   * ★ すでに新しい在庫を持っている作品しか無いなら、叩かない。**枠を守る。**
   *
   * ★ **`--adopt` のときは短絡しない**（2026-09-07）。あちらの目的は
   *   **下書きに無い作品を見つけること**なので、「下書きは全部揃っている」は
   *   理由にならない。ここで止めると、`--match` を広げて取り直すこともできない。
   */
  const stale = [...wanted.keys()].filter((id) => !isFresh(ledger.works[id]))
  if (!has('adopt') && wanted.size > 0 && stale.length === 0) {
    console.log(`下書きの${wanted.size}作品はすべて新しい在庫を持っています。取得しません。`)
    console.log(`（${AVAILABILITY_PATH} / 有効期限は core/availability.ts の MAX_AGE_DAYS）`)
    return
  }

  /*
   * `--adopt`：下書きに無い作品も素材として取り込む。
   *
   * ★ 条件は3つとも満たすこと。1つでも緩めると台帳の意味が変わる。
   *   1. `--match` に当たる（無関係な作品を貯めない）
   *   2. **見放題（subscription）がある**（addon・レンタルは素材にしない）
   *   3. カタログに載っているサービス（未知のサービスIDを素材にしない）
   *
   * ★ **叩く前に検査する。** あとに置くと、`--match` の付け忘れで
   *   リクエストを消費してから止まる。
   */
  const adopt = has('adopt')
  const adoptRe = arg('match') ? new RegExp(arg('match')!, 'i') : undefined
  const catalogKeys = new Set(theme.catalogs.map((c) => c.key))
  if (adopt && !adoptRe) {
    console.log('--adopt には --match が要ります（絞らないと無関係な作品を台帳に入れます）。')
    return
  }
  const adopted: string[] = []
  /** 採用した作品そのもの。**あとで邦題を引き直すために持っておく。** */
  const adoptedWorks: Work[] = []
  /*
   * ★ **在庫が動いたことを履歴に積む**（2026-09-07 追加）。
   *   台帳は上書きなので、それまでは**前回どうだったかが毎回消えていた。**
   *   「Prime Video の見放題から外れた」「見放題に入った」は
   *   在庫を取り直したこの瞬間にしか観測できない（`core/history.ts` 冒頭）。
   */
  const history: StockChange[] = []
  const viaLabel = `availability${adopt ? ' --adopt' : ''} keyword=${keyword}`

  /** 変化ログが持っている作品ID。採用の可否はここで決まる（下の `adoptable`）。 */
  const inChangeLog = adopt
    ? new Set(readAllEventsSync().map((e) => String(e.work.id)))
    : new Set<string>()

  console.log(`キーワード: ${keyword}`)
  if (wanted.size > 0) console.log(`下書きの作品: ${wanted.size}件（うち要取得 ${stale.length}件）`)

  const source = new StreamingAvailabilitySource(apiKey, theme)
  /*
   * ★ `--adopt` は**見放題のカタログに絞って引く。**
   *   絞らないと応答がレンタル・購入で埋まり、見放題の作品が後ろのページへ
   *   押し出される（`fetchAvailability` の注記）。絞ると1リクエストで
   *   `hasMore=false` まで届くので、**安いうえに取りこぼさない。**
   *
   * ★ **注釈だけのとき（`--adopt` 無し）は絞らない。** あちらは下書きの作品の
   *   取扱を知るのが目的で、レンタル・購入しか無い作品の情報も要る。
   */
  const found = await source.fetchAvailability(keyword, { subscriptionOnly: adopt })
  const fetchedAt = new Date().toISOString()

  console.log(`APIが返した作品: ${found.size}件  リクエスト: ${source.requestCount}`)
  console.log('')

  let hit = 0
  for (const [id, row] of found) {
    /*
     * ★ **邦題の補完を変化ログと同じ規則で当てる。**
     *   在庫検索の応答は `title` が英語・`originalTitle` が日本語で返る。
     *   ここを通さないと、在庫から拾った作品だけ英語の題で記事に出る
     *   （品質ゲートは「邦題が未確認なら原題のまま」と通してしまう）。
     */
    const w = withJapaneseWorkTitle(row.work)
    const subsAll = row.services
      .filter((s) => s.types.includes('subscription'))
      .map((s) => s.service)
      .filter((sv) => catalogKeys.has(sv))
    /*
     * ★ **原題（`originalTitle`）にも当てる。**
     *   `localizedTitle` は「原題にかなが含まれるとき」だけ入る
     *   （`withJapaneseWorkTitle`。中国語の題を邦題と誤認しないための判定）。
     *   **漢字だけの邦題はそこを通らない**ので、原題を見ないと当たらない。
     *   実測: `風都探偵`（Prime Video の見放題）が
     *   `--match "仮面ライダー|風都探偵"` で拾えていなかった（2026-09-07）。
     */
    const names = [w.title, w.localizedTitle, w.originalTitle].filter(Boolean) as string[]
    /*
     * ★ 判定は「**変化ログが持っていない作品か**」。「下書きに無いか」ではない。
     *
     *   一度採用した作品は次の `--emit` から下書きに載る。そこで
     *   `!wanted.has(id)` を条件にすると **2回目の実行で採用対象から外れ**、
     *   `work` の付け直しも邦題の引き直しも起きなくなる（2026-09-07 に踏んだ）。
     *   変化ログを見れば、その作品が「在庫からしか来ていない」ことが1件ずつ分かる。
     */
    const adoptable =
      adopt && !inChangeLog.has(id) && subsAll.length > 0 && names.some((n) => adoptRe!.test(n))

    /*
     * 下書きがあるときは、その作品だけを台帳へ入れる。
     * キーワード検索は無関係な作品も返すので、記事に関係ないものまで貯めない。
     *
     * ★ `--adopt` のときは**下書きが無くても絞る**。あちらは `--match` を
     *   必ず持っているので、キーワードに引っかかっただけの作品を貯める理由が無い。
     */
    if (adopt ? !wanted.has(id) && !adoptable : wanted.size > 0 && !wanted.has(id)) continue
    hit++
    /*
     * ★ `work` を持たせるのは `--adopt` で拾ったものだけ。
     *   下書きの作品は変化ログ側が素材を持っているので、二重に持たない。
     *
     * ★ **すでに持っている `work` は消さない**（2026-09-07 に踏んだ）。
     *   一度採用した作品は、次の `--emit` 以降**下書きに載る**ので
     *   `adoptable` が false になる。そこで `work` を落とすと、
     *   **在庫由来の素材が2回目の実行で記事から消える。**
     *   採用は台帳に残す判断であって、1回きりの拾い上げではない。
     */
    const entry: WorkAvailability = { fetchedAt, services: row.services }
    const keptWork = adoptable ? w : ledger.works[id]?.work
    if (keptWork) entry.work = keptWork

    /*
     * 前回の在庫と突き合わせる。**見放題かどうかが変わった社だけ**を1行にする。
     *
     * ★ **前回が無いとき（初観測）は履歴に積まない。** 「無かったものが入った」と
     *   「まだ見ていなかった」は違う。積むと初回の全件が「配信開始」に化ける。
     */
    const before = ledger.works[id]
    if (before) {
      const was = new Set(subscriptionServices(before))
      const now = new Set(subscriptionServices(entry))
      const label = w.localizedTitle ?? w.title
      for (const sv of new Set([...was, ...now])) {
        if (was.has(sv) === now.has(sv)) continue
        history.push({
          observedAt: fetchedAt,
          service: sv,
          workId: id,
          title: label,
          field: 'subscription',
          from: was.has(sv) ? '見放題' : undefined,
          to: now.has(sv) ? '見放題' : undefined,
          via: viaLabel,
        })
      }
    }
    if (adoptable) {
      adopted.push(`${w.localizedTitle ?? w.title}（${subsAll.join(' / ')}）`)
      adoptedWorks.push(w)
    }
    if (!has('dry-run')) ledger.works[id] = entry
    const subs = row.services.filter((s) => s.types.includes('subscription')).map((s) => s.service)
    const paid = row.services.filter((s) => s.types.includes('rent') || s.types.includes('buy'))
    const addon = row.services.filter((s) => s.types.includes('addon')).map((s) => s.service)
    const label = wanted.get(id) || w.localizedTitle || w.title || id
    console.log(`  ${adoptable ? '＋' : '　'}${label.slice(0, 34).padEnd(34)}`)
    console.log(`     見放題: ${subs.join(' / ') || '（なし）'}`)
    if (paid.length) console.log(`     レンタル・購入: ${paid.map((s) => s.service).join(' / ')}`)
    // ★ addon は見放題ではない。**必ず別に出す**（core/availability.ts の「絶対に守ること」）
    if (addon.length) console.log(`     ★別料金チャンネル(addon): ${addon.join(' / ')}`)
  }

  /*
   * ★ **キーワードで取りこぼしたぶんを、IDで拾う。**
   *   検索は当たらないことがある（2026-09-06 の実測で「Transformers」は
   *   60作を返しながら、こちらの5作を1件も含んでいなかった）。
   *   **1作品1リクエスト**なので、下書きの作品数が多いときは打ち止めにする。
   */
  const stillMissing = [...wanted.keys()].filter((id) => !isFresh(ledger.works[id]) && !found.has(id))
  const byIdLimit = Number(arg('max-by-id') ?? 12)
  if (stillMissing.length > 0 && !has('no-by-id')) {
    const targets = stillMissing.slice(0, byIdLimit)
    if (stillMissing.length > targets.length) {
      console.log(
        `取りこぼし${stillMissing.length}件のうち${targets.length}件をIDで取ります` +
          `（1件1リクエスト。上限は --max-by-id）。`,
      )
    } else {
      console.log(`取りこぼし${targets.length}件をIDで取ります（1件1リクエスト）。`)
    }
    for (const id of targets) {
      const row = await source.fetchAvailabilityById(id)
      if (!row) continue
      hit++
      if (!has('dry-run')) ledger.works[id] = { fetchedAt, services: row.services }
      const subs = row.services.filter((s) => s.types.includes('subscription')).map((s) => s.service)
      console.log(`  ${(wanted.get(id) || id).slice(0, 34).padEnd(34)}`)
      console.log(`     見放題: ${subs.join(' / ') || '（なし）'}`)
    }
    console.log('')
  }

  /*
   * ★ **邦題を Wikidata から引く**（2026-09-07）。
   *
   *   `withJapaneseWorkTitle` の補完は「原題にかなが含まれるとき」だけで、
   *   **漢字だけの邦題は通らない**（中国語の題を邦題と誤認しないための判定）。
   *   実測: `風都探偵` が `Fuuto PI` のまま素材に入り、
   *   品質ゲートは「邦題が未確認」として**英題のまま**通してしまう。
   *
   *   変化ログ側は収集時に Wikidata で邦題を解決している（`cli/collect.ts`）。
   *   **在庫から拾う経路にも同じ解決を通す。**片方だけ英題になるのを防ぐ。
   *
   * ★ Wikidata はキー不要・無料。配信APIの枠は消費しない。
   * ★ 取れなければ英題のまま。**推測で邦題を作らない**（品質ゲートの前提）。
   */
  if (adoptedWorks.length > 0 && !has('dry-run')) {
    const cache = await loadTitleCache()
    // `meta` は `Record<string, unknown>`（テーマ固有の逃がし先）なので、
    // 文字列であることだけ確かめて渡す。
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const refs: TitleRef[] = adoptedWorks.map((w) => ({
      imdbId: str(w.meta.imdbId),
      tmdbId: str(w.meta.tmdbId),
    }))
    await resolveTitles(refs, theme.site_language, cache)
    await saveTitleCache(cache)
    let named = 0
    for (const [i, w] of adoptedWorks.entries()) {
      const key = titleCacheKey(refs[i]!)
      const title = key ? cache[key] : undefined
      if (title && title !== w.localizedTitle) {
        w.localizedTitle = title
        named++
      }
    }
    if (named > 0) console.log(`邦題を Wikidata から補いました: ${named}件`)
  }

  console.log('')
  if (adopted.length > 0) {
    console.log(`**在庫から素材にする作品: ${adopted.length}件**（変化ログに無く、在庫では見放題）`)
    for (const line of adopted) console.log(`  ＋ ${line}`)
    console.log('  ★ もう一度 --emit すると素材に入ります（終了日は分からないので「見放題配信中」）。')
    console.log('')
  } else if (adopt) {
    console.log('在庫から素材にする作品はありませんでした（--match に当たる見放題の在庫が、変化ログの外に無い）。')
    console.log('')
  }
  if (wanted.size > 0) {
    /*
     * ★ **「取れなかった」に、すでに新しい在庫を持っている作品を数えないこと。**
     *   キーワードを分けて2回叩くと（`Harry Potter` → `Fantastic Beasts`）、
     *   2回目の応答に1回目の作品は入らない。それを「取れなかった」と出すと
     *   **毎回7件の偽の警告**が出て、本当の取りこぼしが埋もれる。
     *   見るべきは「**この実行のあと台帳に無いもの**」。
     */
    /*
     * ★ **`--dry-run` では台帳に書いていない**ので、`ledger.works` を見ると
     *   毎回「全件取れなかった」になる（2026-09-07 に踏んだ。10件中10件が
     *   偽の警告で、すぐ上の一覧には7件が取れて表示されていた）。
     *   取れたかどうかは**この実行の応答**（`found`）でも見る。
     */
    const missed = [...wanted.keys()].filter(
      (id) => !isFresh(ledger.works[id]) && !found.has(id),
    )
    // ★ 下書きの充足は**下書きのIDだけ**で数える。`hit` には在庫から拾った
    //   作品も入っていて、しかもその一部は下書きにも載っている（重なる）。
    const forDraft = [...wanted.keys()].filter((id) => found.has(id)).length
    console.log(`台帳に入れた: ${hit}件（うち下書きのぶん ${forDraft}件 / 下書き ${wanted.size}件）`)
    const already = wanted.size - forDraft - missed.length
    if (already > 0) console.log(`（${already}件はすでに新しい在庫を持っていました）`)
    if (missed.length > 0) {
      console.log(`**取れなかった: ${missed.length}件** — ${missed.map((id) => wanted.get(id) || id).slice(0, 5).join(' / ')}`)
      console.log('  ★ これらは「在庫が無い」ではなく「分からない」。記事側もそう扱う。')
      console.log('  ★ 別のキーワードで取り直すなら --keyword を渡すこと。')
    }
  }

  if (has('dry-run')) {
    console.log('')
    console.log('--dry-run なので保存しませんでした（**リクエストは消費しています**）。')
    return
  }

  await saveAvailability(ledger)
  await appendHistory(history, theme.utc_offset_minutes)
  if (history.length > 0) {
    console.log(`在庫の履歴に ${history.length}件 追記しました（data/history/）。`)
  }
  await addUsage(source.requestCount, theme.utc_offset_minutes)
  console.log(`→ ${AVAILABILITY_PATH}`)
}

main().catch((e) => {
  console.error(String(e))
  process.exitCode = 1
})
