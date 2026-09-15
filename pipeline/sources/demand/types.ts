/**
 * 需要側の信号の形。**在庫（ChangeEvent）とは別の世界の値**なので型を分けてある。
 *
 * ■ 在庫と需要の違い
 * `ChangeEvent` は「その作品に何が起きたか」を書いた観測で、**当サイトの事実**。
 * こちらは「世の中で何が検索・閲覧されているか」で、**当サイトの外の事実**。
 * 混ぜると、記事に載せてよい事実（自前の観測）と、
 * 主題を選ぶためだけの手がかり（他所の人気）の区別が付かなくなる。
 *
 * ★ **需要の数字は記事に書かない。** Wikipedia の閲覧数を
 *   「人気作品ランキング」として記事に載せると、当サイトの観測ではないものを
 *   当サイトの主張として出すことになる。使うのは**主題を選ぶところまで**。
 */

/** どこから拾った需要か */
export type DemandSource = 'wikipedia-pageviews' | 'google-trends'

/** 需要の観測1件（ある日・ある語・ある取得元） */
export interface DemandSignal {
  source: DemandSource
  /**
   * 需要側の語。
   *   Wikipedia … 記事名から曖昧さ回避の括弧を落としたもの（`オデュッセイア_(映画)` → `オデュッセイア`）
   *   Trends    … 検索語そのまま
   */
  word: string
  /** 落とす前の元の文字列。あとで記事名に戻せるように残す */
  raw: string
  /**
   * その数字が属する日（`YYYY-MM-DD`）。
   * ★ **Wikipedia の集計は UTC 日**。JST の日付と1日ずれることがある。
   *   ずらして直さないこと（取得元の日付をそのまま持つほうが、あとで照合できる）。
   */
  day: string
  /** 閲覧数（Wikipedia）／おおよその検索数（Trends。`20,000+` → 20000） */
  count: number
  /** その日の順位。Wikipedia の top は 1〜1000。Trends は並び順 */
  rank?: number
  /** 取得した時刻 */
  fetchedAt: string
}
