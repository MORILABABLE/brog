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
 * 月末までに定期実行が使う見込み。**残量の判断はこれと突き合わせる。**
 *
 * ★ 実測にもとづく概算（2026-09-07）。
 *   `collect.yml`  週2回（月・木 19:00 UTC）× 1回あたり約20回
 *   `announce.yml` 毎日。ただし**新しい告知が出た日だけ**取り込みが走る。
 *                  上限は60回（`max_lookups`）だが、**実測は1周で37回**
 *                  （2026-08-28 に36回、以降は1〜2回ずつ）。
 *                  ここでは上限側（60×3）で見ておく。
 *   `collect-unext.yml` は実ブラウザなので **APIを1回も使わない**。
 *   `images.yml` も `make-sections.mjs` を呼ぶだけで **0回**。
 *
 * ★ **`announce` 自身が呼ぶときは、`announce` のぶんを外すこと**
 *   （`opts.excludeAnnounce`）。入れたままだと**自分の枠を自分に予約する**ので、
 *   月末に近づくほど画像の取得が不必要に絞られる（2026-09-07 に気づいた）。
 */
export function scheduledRemaining(
  now: Date,
  offsetMinutes: number,
  opts: { excludeAnnounce?: boolean } = {},
): number {
  const local = new Date(now.getTime() + offsetMinutes * 60_000)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

  // collect.yml は UTC の月曜と木曜に走る
  let collects = 0
  for (let d = local.getUTCDate(); d <= lastDay; d++) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay()
    if (dow === 1 || dow === 4) collects++
  }
  const COLLECT_COST = 20
  // 告知の取り込みは月に3回ぶん見ておく（翌月ラインナップが出そろう時期）
  const ANNOUNCE_COST = opts.excludeAnnounce ? 0 : 60 * 3
  return collects * COLLECT_COST + ANNOUNCE_COST
}
