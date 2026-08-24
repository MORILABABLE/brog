/**
 * 「どこまで通知したか」の記録。
 *
 * ■ なぜ台帳(`data/ledger.json`)を使い回さないか
 * 台帳の `seen` は**収集した時点で**書かれる。通知が走るころには
 * 全イベントが既に「既出」になっているので、通知の未読管理には使えない。
 * 収集済みかどうかと、人に伝えたかどうかは別の状態なので、別に持つ。
 *
 * ■ 何を持つか
 * 最後に通知した収集の時刻だけ。`ChangeEvent.collectedAt` は1回の収集で
 * 全件に同じ値が入るので、これより後の収集ぶんを選べば差分になる。
 * 通知が落ちた回があっても、次回にまとめて拾える（時刻を進めるのは送信成功後）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const NOTIFY_STATE_PATH = join('data', 'notify-state.json')

export interface NotifyState {
  /** 最後に通知した収集の `collectedAt`。未通知なら空文字。 */
  lastCollectedAt: string
  updatedAt: string
}

const EMPTY: NotifyState = { lastCollectedAt: '', updatedAt: '' }

export async function loadNotifyState(): Promise<NotifyState> {
  try {
    const raw = await readFile(NOTIFY_STATE_PATH, 'utf8')
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<NotifyState>) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY }
    throw err
  }
}

export async function saveNotifyState(lastCollectedAt: string): Promise<void> {
  const body: NotifyState = { lastCollectedAt, updatedAt: new Date().toISOString() }
  await mkdir(dirname(NOTIFY_STATE_PATH), { recursive: true })
  await writeFile(NOTIFY_STATE_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}
