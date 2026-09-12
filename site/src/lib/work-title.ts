/**
 * 邦題が取れていない作品に、原語表記（`originalTitle`）を充てる。
 *
 * ■ なぜ要るか
 * 邦題は Wikidata から引いているが、**新しい作品ほど項目がまだ無い。**
 * 配信APIの `originalTitle` は**日本の作品なら日本語表記のまま返る**ので、
 * 推測なしで埋められる。**かなを含むものだけ**に限るのは、漢字だけの題が
 * 中国語と区別できないため（規則の説明は pipeline/core/events.ts の冒頭）。
 *
 * ■ ★ サイト側の写しは**このファイル1か所だけ**にする
 * 規則の本体は `pipeline/core/events.ts` の `withJapaneseWorkTitle()`。
 * **site は pipeline を import しない**という境界のために写してある
 * （`availability.ts` が見放題の規則を写しているのと同じ事情）。
 * **pipeline 側を変えるときは、ここも変えること。**
 *
 * ■ ★ なぜ切り出したか（2026-09-12）
 * **`data/events` を読む経路がサイト側に2つあり、片方だけがこの規則を持っていた。**
 *
 *   events-data.ts … 常設ページ・作品ページ・変化ログ      → 規則あり
 *   work-links.ts  … **表の作品名のリンクとサムネイル**    → **規則が無かった**
 *
 * 記事の表には補完後の日本語題が出るのに、`work-links.ts` の索引には英題しか
 * 入っておらず、**完全一致で外れて、その行だけリンクもポスターも付かなかった**
 * （実測: 公開中30記事・1,892行のうち12行。`data/events` の3,623作品中44件が該当）。
 * 読者から見れば「この行だけ何も無い」＝不具合で、送り先が1つも無い以上
 * **アクセスの機会そのものが落ちている。**
 */

/**
 * ひらがな・カタカナ。**日本語にしか無い**ので、ここだけを条件にする。
 * ★ `pipeline/core/events.ts` の `KANA` と同じもの。
 */
const KANA = /[ぁ-んァ-ヶ]/

/** 題名を持つ作品の最小の形。収集データの `work` がこれを満たす。 */
export interface TitledWork {
  title?: string
  localizedTitle?: string
  originalTitle?: string
}

/**
 * 邦題が空で、原語表記がかなを含むなら、それを邦題として充てる。**その場で書き換える。**
 *
 * ★ 収集ログ（`data/events/*.jsonl`）は書き換えない。やるのは読み込み時の補完だけ。
 */
export function fillJapaneseTitle<T extends TitledWork>(work: T): T {
  if (!work.localizedTitle && work.originalTitle && KANA.test(work.originalTitle)) {
    /*
     * ★ 連続した半角スペースは1つに詰める。実測で
     *   「機動戦士ガンダム␣␣閃光のハサウェイ」のように2つ入って返る。
     *   全角スペースは題名の一部として使われることがあるので触らない。
     */
    work.localizedTitle = work.originalTitle.replace(/ {2,}/g, ' ').trim()
  }
  return work
}
