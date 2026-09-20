/**
 * 定期収集が「どこからどこまでを取るか」を決める。
 *
 * ■ なぜ要るか（2026-09-20 追加）
 * `collect` は `--days 7` 固定で走っていた。実行は火・金なので、
 * **毎回3〜4日ぶんを前回と重ねて取り直していた。**
 *
 *   火 → 金  実間隔3日なのに7日ぶんを要求
 *   金 → 火  実間隔4日なのに7日ぶんを要求
 *
 * 取り直したぶんは `dedupe()` が台帳で落とすので**記事には1件も増えない。**
 * 増えるのはリクエストだけ。`/changes` は1ページ25件なので、
 * 件数がそのままページ数＝リクエスト数になる。
 *
 * ■ 重複を削るだけではない。**取りこぼしも直る。**
 * `#pageChanges()` は8ページ（200件）で打ち切る。7日ぶんを要求すると
 * `new` はこの上限に届きうる（2026-09-10 の実測で重複除去後245件）。
 * **打ち切られたぶんは「無かった」ことになる。** 窓を実間隔まで詰めれば
 * 同じ上限の内側に収まり、打ち切りが起きにくくなる。
 *
 * ■ 安全側に倒す
 * 実間隔ちょうどではなく **+1日** を足す。定期実行が遅れた日・落ちた日に
 * 穴が空くのを避けるため。上限14日は「久しぶりに手で回したときに
 * 際限なく広がらない」ための蓋で、下限2日は「同じ日に二度走らせても
 * 窓が消えない」ための床。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const STATE_PATH = join('data', 'collect-state.json')

/** 前回からの実間隔に足す余裕（日）。遅延・失敗した回の穴を埋める */
const SAFETY_DAYS = 1

/** 窓の下限（日）。同じ日に二度走らせても0日にしない */
const MIN_DAYS = 2

/** 窓の上限（日）。間が空いた回に際限なく広げない */
const MAX_DAYS = 14

/** 記録が無いときの窓（日）。従来の既定値と同じ */
export const FALLBACK_DAYS = 7

export interface CollectState {
  /** 最後に `collect` が走った時刻（成否を問わない。リクエストは消費済みのため） */
  lastCollectedAt?: string
  /** 最後に `upcoming` をAPIに問い合わせた年月（YYYY-MM） */
  lastUpcomingProbeMonth?: string
  /** 直近の `collect` が実際に投げた回数（新しいものが末尾）。予約枠の較正に使う */
  recentRequests?: number[]
  updatedAt?: string
}

/** 較正に使う直近の回数 */
const SAMPLE_SIZE = 5

/** 実測に足す余裕（回）。ページ数は取得件数で揺れるため */
const COST_MARGIN = 2

/** 実測から出す下限（回）。空振りの回を根拠に予約を削りすぎない */
const MIN_COST = 8

export function recordRequests(state: CollectState, count: number): void {
  const list = [...(state.recentRequests ?? []), count]
  state.recentRequests = list.slice(-SAMPLE_SIZE)
}

/**
 * `collect` 1回ぶんの見積もり。**実測があればそれを使う。**
 *
 * ■ なぜ定数をやめたか（2026-09-20）
 * `api-usage.ts` は 20回で予約していた。2026-09-20 に窓を詰めて `upcoming` を
 * 月1回にしたので実消費は下がるが、**定数のままだと下がったぶんが
 * 手作業に回らない。** かといって見込みで下げると、外したときに月末の収集が
 * 429 で落ちる（そちらのほうが取り返しがつかない）。
 *
 * そこで**実測を持ち回る**。平均ではなく直近の**最大**を採るのは、
 * 予約は「足りなくならない」ことが仕事だから。
 * 標本が2回に満たないうちは、従来どおり呼び出し側の定数に任せる。
 */
export function collectCostEstimate(state: CollectState): number | undefined {
  const s = state.recentRequests ?? []
  if (s.length < 2) return undefined
  return Math.max(MIN_COST, Math.max(...s) + COST_MARGIN)
}

export async function loadState(): Promise<CollectState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as CollectState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function saveState(state: CollectState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true })
  const body = { ...state, updatedAt: new Date().toISOString() }
  await writeFile(STATE_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

export interface Window {
  days: number
  /** ログに出す理由。なぜその窓になったかが分からないと調整できない */
  reason: string
}

/**
 * `new` / `removed` に使う窓を決める。
 * `--days` が明示されていればそれを使う（手で回すときの逃げ道を塞がない）。
 */
export function decideWindow(state: CollectState, now: Date, explicitDays?: number): Window {
  if (explicitDays != null && Number.isFinite(explicitDays)) {
    return { days: explicitDays, reason: '--days で指定' }
  }

  const last = state.lastCollectedAt ? Date.parse(state.lastCollectedAt) : NaN
  if (!Number.isFinite(last)) {
    return { days: FALLBACK_DAYS, reason: '前回の記録が無いため既定' }
  }

  const elapsed = (now.getTime() - last) / 86_400_000
  if (elapsed < 0) {
    // 時計が巻き戻っている（CIの時刻ずれ等）。広いほうに倒す。
    return { days: FALLBACK_DAYS, reason: '前回の記録が未来のため既定' }
  }

  const want = Math.ceil(elapsed) + SAFETY_DAYS
  const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, want))
  const capped =
    days !== want ? `（${want}日を${days}日に${days < want ? '圧縮' : '拡大'}）` : ''
  return {
    days,
    reason: `前回の収集から${elapsed.toFixed(1)}日 ＋余裕${SAFETY_DAYS}日${capped}`,
  }
}

/**
 * `upcoming` をこの回で問い合わせるか。
 *
 * ■ なぜ毎回やめるのか
 * **日本カタログでは一度も返ってきていない。** theme.yaml の実測（2026-08・6回）で
 * 4社とも0件、2026-09-20 に `data/events/` を数え直しても
 * APIの作品IDを持つ `upcoming` は**1件も無い**（記録上の177件は全部
 * 告知由来の `ann-` ID）。それでも毎回 movie / series で1回ずつ、
 * **月18回ぶんを空振りに使っていた。**
 *
 * ■ それでもやめきらない理由
 * API側が返し始めたときに気づけなくなる。**月に一度だけ様子を見る**（2回）。
 * 返り始めたらログに出るので、そこで毎回に戻せばよい。
 */
export function shouldProbeUpcoming(
  state: CollectState,
  now: Date,
  offsetMinutes: number,
): boolean {
  return state.lastUpcomingProbeMonth !== yearMonthOf(now, offsetMinutes)
}

/**
 * サイトの基準タイムゾーンでの `YYYY-MM`。
 * `core/datetime.ts` の `currentYearMonth()` と同じ数え方だが、
 * **任意の時刻**で問えるようにここに置く（引数の now で試験できる）。
 */
export function yearMonthOf(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 7)
}
