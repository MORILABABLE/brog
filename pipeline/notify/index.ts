/**
 * 通知先の選択。
 *
 * 通知先を増やすときに触るのはこのファイルの表と `channels/` の1ファイルだけ。
 * 本文の組み立て（`core/digest.ts`）も CLI も変えなくてよい。
 *
 * 例: Discord を足す場合
 *   1. channels/discord.ts に Channel を実装する（webhook に POST するだけ）
 *   2. 下の CHANNELS に 'discord' を足す
 *   3. NOTIFY_CHANNEL=discord で選ぶ（`github-issue,discord` と並べれば両方に送る）
 */
import type { Channel } from './types.ts'
import { ConsoleChannel } from './channels/console.ts'
import { GitHubIssueChannel } from './channels/github-issue.ts'

const CHANNELS: Record<string, () => Channel> = {
  console: () => new ConsoleChannel(),
  'github-issue': () => new GitHubIssueChannel(),
}

export const DEFAULT_CHANNEL = 'github-issue'

/**
 * 名前から通知先を作る。カンマ区切りで複数指定できる。
 * 既定は環境変数 `NOTIFY_CHANNEL`、それも無ければ GitHub Issue。
 */
export function createChannels(spec?: string): Channel[] {
  const names = (spec ?? process.env.NOTIFY_CHANNEL ?? DEFAULT_CHANNEL)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return names.map((name) => {
    const make = CHANNELS[name]
    if (!make) {
      throw new Error(`不明な通知先: ${name}（有効: ${Object.keys(CHANNELS).join(', ')}）`)
    }
    return make()
  })
}

export type { Channel, Notification } from './types.ts'
