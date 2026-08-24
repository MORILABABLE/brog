/**
 * 通知先の抽象。
 *
 * LLM プロバイダやデータソースを差し替え可能にしたのと同じ形。
 * 本文を組み立てる側（`core/digest.ts`）は届け方を知らず、
 * 届ける側は中身を知らない。通知先を増やすときに触るのは
 * `channels/` に1ファイル足して `index.ts` の表に1行足すだけ。
 */

export interface Notification {
  /** 件名。メールの Subject / Issue のタイトルになる。 */
  subject: string
  /** 本文（Markdown）。Markdown を解さない通知先は各チャンネル側で落とす。 */
  body: string
}

export interface Channel {
  readonly name: string
  send(notification: Notification): Promise<void>
}
