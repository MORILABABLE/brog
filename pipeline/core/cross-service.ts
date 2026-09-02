/**
 * **「終了しました」と書く前に、他社に生きている観測が無いかを見る。**
 *
 * ■ なぜ要るか（2026-09-02 追加）
 * シリーズ記事は「その主題の作品が、いつまで観られるか」に1本で答える記事で、
 * 全作が終われば `ended`（見放題配信が終了した）に切り替わる。
 * 判定の材料は**その記事が選んだ素材**だけなので、
 *
 *     名探偵コナン ベイカー街の亡霊
 *       Netflix   8月31日に終了（記事の素材に入る）
 *       Prime     7月10日に配信開始を観測（記事の素材に入らない）
 *
 * のような作品があると、**記事は「終了しました」と書き、
 * 手元のデータには他社で始まった観測が残ったまま**になる。
 * 読者から見れば「まだ他で観られるのに、終わったと言われた」に近い。
 *
 * ■ 何を言えて、何を言えないか（**ここが設計の境目**）
 * このサイトが持っているのは**変化の観測**であって**現在の在庫**ではない。
 * `new` を観測して `removed` を観測していないことは、
 * **いま観られることを意味しない**（`site/src/lib/works.ts` 冒頭の「絶対に守ること」）。
 * Disney+ と Apple TV+ は終了予定を返さず、`removed` も棚卸しの都合で遅れて出る。
 *
 * だからここが返すのは「**他社に生きている観測がある**」までで、
 * 「他社で配信中」ではない。呼び出し側も断定に使わないこと。
 * 検査は **warn**（公開を止めない）、通知は**確かめる材料**として出す。
 *
 * ■ 同じ作品かの判定
 * 既定は `work.id` の一致。**言い切れるときだけ立てたい**ので、
 * 復帰の判定（`series.ts` の `revivals()`）と同じ考え方にしてある。
 * 題名の正規化で当てたい記事タイプは `ArticleType.sameWork` を宣言する
 * （サービスごとに違う題で入っている作品を拾えるようになる）。
 */
import type { ChangeEvent } from '../sources/types.ts'

/** 他社に生きている観測が1件ある、という報せ1件ぶん */
export interface LiveElsewhere {
  /** 記事の素材のうち、終わったと書かれている観測 */
  ended: ChangeEvent
  /** 他社に残っている、生きている観測 */
  live: ChangeEvent
  /**
   * `live` が生きていると見なせる理由。
   *   `started`  … 配信開始を観測し、そのあと終了を観測していない
   *   `leaving`  … 終了予定だが、その日はまだ来ていない
   */
  kind: 'started' | 'leaving'
}

/** その観測が、いま「生きている」と読めるか */
function isLive(e: ChangeEvent, now: Date): 'started' | 'leaving' | undefined {
  if (e.kind === 'new') return 'started'
  if (e.kind === 'expiring' && e.at && Date.parse(e.at) >= now.getTime()) return 'leaving'
  return undefined
}

/** その観測が「終わった／期日を過ぎた」と読めるか */
function isOff(e: ChangeEvent, now: Date): boolean {
  if (e.kind === 'removed') return true
  return e.kind === 'expiring' && Boolean(e.at) && Date.parse(e.at!) < now.getTime()
}

/**
 * 記事が「終わった」と書いている作品のうち、**他社に生きている観測があるもの**を返す。
 *
 * @param items    記事の素材（記事タイプの `select()` が選んだもの）
 * @param all      収集済みの全イベント（`readAllEvents()` / `readAllEventsSync()`）
 * @param now      判定の基準時刻
 * @param sameWork 同じ作品かの判定。既定は `work.id` の一致（上の説明）
 */
export function liveElsewhere(
  items: ChangeEvent[],
  all: ChangeEvent[],
  now: Date,
  sameWork: (a: ChangeEvent, b: ChangeEvent) => boolean = (a, b) => a.work.id === b.work.id,
): LiveElsewhere[] {
  /*
   * ★ **サービスごとに最新の観測だけを見る。** 過去に `new` があっても、
   *   そのあと `removed` を観測していればもう生きていない。
   *   並べ替えの基準は `collectedAt`（**当サイトが把握した順**）。
   *   配信開始日・終了日は各社の申告で遡って埋まることがあるので、
   *   そちらで順序を決めると「終了を伝えたあとに始まった」が逆転する。
   */
  const latest = new Map<string, ChangeEvent>()
  for (const e of all) {
    const key = `${e.service}/${e.work.id}`
    const cur = latest.get(key)
    if (!cur || e.collectedAt > cur.collectedAt) latest.set(key, e)
  }

  const out: LiveElsewhere[] = []
  const seen = new Set<string>()

  for (const ended of items) {
    if (!isOff(ended, now)) continue
    for (const cand of latest.values()) {
      // 同じサービスの観測は見ない。ここが探しているのは**他社**の生き残り
      if (cand.service === ended.service) continue
      if (!sameWork(ended, cand)) continue
      const kind = isLive(cand, now)
      if (!kind) continue

      /*
       * ★ **その作品が、記事の中で他社でも終わっているなら報せない。**
       *   コナンのように Netflix と U-NEXT の両方が素材に入っていて
       *   両方終わっている場合、生きている観測ではないので当たらないが、
       *   同じ作品を2回報せないための重複よけはここで掛ける。
       */
      const key = `${ended.service}/${ended.work.id}/${cand.service}/${cand.work.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ended, live: cand, kind })
    }
  }
  return out
}
