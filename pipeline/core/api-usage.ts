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
