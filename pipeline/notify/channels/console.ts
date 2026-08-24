/**
 * 標準出力に出すだけの通知先。
 *
 * `--dry-run` の実体であり、通知先を1つも設定していない状態でも
 * 本文の中身を確認できるようにするためのもの。
 * 新しい通知先を書くときの最短の実装例でもある。
 */
import type { Channel, Notification } from '../types.ts'

export class ConsoleChannel implements Channel {
  readonly name = 'console'

  async send(n: Notification): Promise<void> {
    console.log(`\n--- 件名 -------------------------------------------------`)
    console.log(n.subject)
    console.log(`--- 本文 -------------------------------------------------\n`)
    console.log(n.body)
    console.log(`\n----------------------------------------------------------`)
  }
}
