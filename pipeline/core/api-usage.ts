/**
 * APIリクエストの消費量を月別に記録する。
 *
 * ■ なぜ要るか
 * Streaming Availability API の無料枠は 500リクエスト/月。
 * 枠を使い切ると 429 が返って収集が止まるが、**止まってから初めて気づく**。
 * 現状これを事前に知る手段がリポジトリ側に無いので、自分で数えておく。
 *
 * ■ あくまで概算
 * ここで数えるのは「このリポジトリから投げた回数」であって、提供元の
 * カウンタそのものではない。手元での `npm run probe` や `npm run catalogs`、
 * 失敗して記録されなかった実行の分はずれる。**正確な残量は提供元の
 * ダッシュボードで確認すること。** ここでの役割は「そろそろ危ない」に
 * 気づくための目安。
 *
 * 月の区切りはサイトの基準タイムゾーンで判定する（`data/events` と同じ理由）。
 * 提供元のリセット基準と厳密には一致しないが、目安としては十分。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { currentYearMonth } from './datetime.ts'
import { collectCostEstimate, loadState } from './collect-window.ts'

export const USAGE_PATH = join('data', 'api-usage.json')

/** Streaming Availability API の無料枠（リクエスト/月） */
export const FREE_TIER_LIMIT = 500

export interface ApiUsage {
  /** YYYY-MM -> その月に投げたリクエスト数 */
  months: Record<string, number>
  updatedAt: string
}

export interface UsageSnapshot {
  month: string
  used: number
  limit: number
  /**
   * その月の記録が存在するか。
   * 記録が無い月の 0 は「1件も投げていない」ではなく「数えていない」。
   * 両者を混ぜると、計測を始めた月に「消費0」という嘘の安心を出してしまう。
   */
  tracked: boolean
}

const EMPTY: ApiUsage = { months: {}, updatedAt: '' }

export async function loadUsage(): Promise<ApiUsage> {
  try {
    const raw = await readFile(USAGE_PATH, 'utf8')
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<ApiUsage>) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, months: {} }
    throw err
  }
}

/**
 * 今月の消費に加算して保存する。
 * 収集が途中で落ちても消費は発生しているので、呼び出し側は finally で呼ぶこと。
 */
export async function addUsage(count: number, offsetMinutes: number): Promise<UsageSnapshot> {
  const month = currentYearMonth(offsetMinutes)
  const usage = await loadUsage()
  usage.months[month] = (usage.months[month] ?? 0) + count
  usage.updatedAt = new Date().toISOString()

  await mkdir(dirname(USAGE_PATH), { recursive: true })
  await writeFile(USAGE_PATH, JSON.stringify(usage, null, 2) + '\n', 'utf8')

  return { month, used: usage.months[month]!, limit: FREE_TIER_LIMIT, tracked: true }
}

/** 今月の消費を読むだけ（加算しない）。通知が使う。 */
export async function readUsage(offsetMinutes: number): Promise<UsageSnapshot> {
  const month = currentYearMonth(offsetMinutes)
  const usage = await loadUsage()
  return {
    month,
    used: usage.months[month] ?? 0,
    limit: FREE_TIER_LIMIT,
    tracked: month in usage.months,
  }
}

/**
 * 残量が心細くなったら声を上げる。**止めはしない。**
 *
 * ■ なぜ止めないのか
 * 止める仕組みにすると、月末に収集が黙って落ちる。
 * **収集が止まるのは、枠を使い切るのと同じくらい困る**（その月の観測が欠ける）。
 * 判断は人がするものなので、ここは気づける形にするところまで。
 *
 * ■ なぜ要るのか
 * 2026-09-07 に、点検のために叩いた分で月の消費が一気に増えた。
 * **そのとき画面に出ていたのは実行1回ぶんの数字だけ**で、
 * 「今月あとどれだけ使えるか」はどこにも出ていなかった。
 */
export function warnIfLow(u: UsageSnapshot): void {
  const left = u.limit - u.used
  const pct = Math.round((u.used / u.limit) * 100)
  if (pct >= 90) {
    console.warn(`  ★ 今月の残りが ${left}回（${pct}%消費）。**定期収集を優先し、下見は控えること。**`)
  } else if (pct >= 70) {
    console.warn(`  ※ 今月の残りは ${left}回（${pct}%消費）。下見や点検の前に残量を確かめること。`)
  }
}

/**
 * collect 1回ぶん。実測 11 / 11 / 11 / 14 / 16 に上振れを見た値。
 *
 * ★ **2026-09-20 以降、これは「実測が貯まるまでの置き石」でしかない。**
 *   窓を実間隔まで詰め、`upcoming` を月1回にしたので実消費は下がるが、
 *   **見込みでは下げない。** 予約を小さくしすぎると手作業が定期収集ぶんまで食い、
 *   月末に収集が 429 で落ちる。予約が大きすぎる害（手作業が絞られる）より、
 *   小さすぎる害（観測が欠ける）のほうが取り返しがつかない。
 *   そこで `collect` が自分の消費を `data/collect-state.json` に積み、
 *   2回ぶん貯まったら `collectCostEstimate()` がこの定数を**置き換える**。
 *   手で直す必要は無い。
 */
const COLLECT_COST = 20

/**
 * 翌月ラインナップの取り込み1回ぶん。**1か月に一度しか起きない。**
 * 上限は announce.yml の `max_lookups`（既定60）と同じ。実測は 36〜37回。
 */
const ANNOUNCE_BATCH = 60

/** 告知が出ていない日の announce。実測 0〜1 に上振れを見た値 */
const ANNOUNCE_DAILY = 2

/**
 * 月末までに定期実行が使う見込み。**残量の判断はこれと突き合わせる。**
 *
 * ■ 実測（2026-08-24〜2026-09-09。`data/api-usage.json` のコミット履歴から）
 *
 *     定期実行  64回（19%）  collect 5回ぶんが 11 / 11 / 11 / 14 / 16
 *                            announce は記録上 1回だけ（告知が出た日以外は0）
 *     手で叩く 269回（81%）  うち 2026-09-07 12:53 の1回で **120回**
 *
 * **枠を食っているのは定期実行ではない。** ここで見積もるのは、その定期実行ぶんを
 * 手作業から守るための予約枠。
 *
 * ■ 内訳
 *   collect   月末までに残っている UTC 月曜・木曜の回数 × 20
 *   announce  ラインナップの取り込み1回（60）＋ 残り日数 × 2
 *
 * ★ **ラインナップぶんは月に1回だけ数える。** 前月末に出るものなので、
 *   月の前半に走らせても「今月ぶんはもう済んでいる」ことが多いが、
 *   **翌月ぶんが今月末に来る。** 数えないと月末に足りなくなる。
 *
 * ★ **2026-09-10 に較正した。** それまで announce を `60 × 3 = 180回` で
 *   見ていた。実測の3倍以上で、**月半ばに「余り0回」になり手作業が全部止まる**
 *   （9月10日時点で予約300回・残り-32回と出ていた）。
 *
 * ★ **`announce` 自身が呼ぶときは `excludeAnnounce`**（自分の枠を自分に予約しない。
 *   2026-09-07 に気づいた。入れたままだと月末ほど画像の取得が不必要に絞られる）。
 * ★ `collect-unext.yml` は実ブラウザなので **APIを1回も使わない。**
 *   `images.yml` も `make-sections.mjs` を呼ぶだけで **0回。**
 */
export function scheduledRemaining(
  now: Date,
  offsetMinutes: number,
  opts: { excludeAnnounce?: boolean; collectCost?: number } = {},
): number {
  // 実測が渡されていればそちらを使う（core/collect-window.ts の collectCostEstimate）。
  // 定数は「まだ実測が2回ぶん貯まっていない」ときの置き石。
  const perCollect = opts.collectCost ?? COLLECT_COST
  const local = new Date(now.getTime() + offsetMinutes * 60_000)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const today = local.getUTCDate()

  // collect.yml は UTC の月曜と木曜に走る
  let collects = 0
  for (let d = today; d <= lastDay; d++) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    if (dow === 1 || dow === 4) collects++
  }
  const collectCost = collects * perCollect
  if (opts.excludeAnnounce) return collectCost

  const daysLeft = lastDay - today + 1
  return collectCost + ANNOUNCE_BATCH + daysLeft * ANNOUNCE_DAILY
}

export interface MonthlyPlan extends UsageSnapshot {
  /** 月末までに定期実行が使う見込み */
  reserve: number
  /** 予約を引いたあとの、手作業に回せるぶん。0未満にはしない */
  spare: number
}

/**
 * 「いま何回まで自由に使えるか」を1か所で出す。
 *
 * ■ なぜ関数にしたか（2026-09-20）
 * `availability.ts` と `collect-announce.ts` が**同じ3行をそれぞれ書いていた**。
 * `refresh-images.ts` は**書いていなかった**ので、残り枠しか見ずに
 * 「残り124回・対象457件」でも `--limit` さえ下げれば通ってしまい、
 * **月末の定期収集ぶんを食い潰せる状態だった。**
 *
 * ★ 既存2か所はいまのところ手を入れていない（動いているものを触らない）。
 *   次にあのあたりを直すときに、こちらへ寄せること。
 */
export async function monthlyPlan(
  offsetMinutes: number,
  opts: { excludeAnnounce?: boolean; now?: Date } = {},
): Promise<MonthlyPlan> {
  const usage = await readUsage(offsetMinutes)
  // 予約は実測で較正する。定数のままだと、節約したぶんが手作業に回らない。
  const collectCost = collectCostEstimate(await loadState())
  const reserve = scheduledRemaining(opts.now ?? new Date(), offsetMinutes, {
    ...opts,
    collectCost,
  })
  return { ...usage, reserve, spare: Math.max(0, usage.limit - usage.used - reserve) }
}
