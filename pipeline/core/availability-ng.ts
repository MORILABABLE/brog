/**
 * **APIが「見放題」と言っているのに、実際にはそこに無い組み合わせ。**
 *
 * ■ なぜ要るのか（2026-09-09 に踏んだ）
 * `data/availability.json` は `/shows` の応答そのままで、
 * `type === 'subscription'` を**その時点の在庫の直接の根拠**として扱っている
 * （`core/availability.ts` の冒頭）。**その前提が崩れる場合がある。**
 *
 *   コナンの劇場版8作について、APIは Prime Video の `subscription` を返し続けている。
 *   運営者がAmazonの画面を目視したところ、**見放題には1本も無かった**（レンタル・購入だけ）。
 *   公開中の記事のリードが「Amazon Prime Videoでも一部タイトルが見放題で配信されています」
 *   と書き、表にも ○ が並んでいた。
 *
 * ■ なぜ機械で気づけないのか
 *   - `amazon.co.jp` は自動取得を受け付けない（docs/CROSS-SERVICE.md 9-3）。
 *     **突き合わせは人が目視する**という前提でこの仕組みは書かれている
 *   - 変化ログ（`/changes`）にも出ない。収集を始める前から在庫にある扱いなので
 *     `new` は流れず、消えたことも `removed` として流れてこない
 *
 * → **目視の結果を置く場所**がこれ。`data/availability-ng.json`。
 *
 * ■ 何をするのか
 * 当たった組み合わせから **`subscription` だけを取り下げる。**
 *
 *   ★ **レンタル・購入は残す。** 目視で確かめたのは「見放題に無い」ことだけで、
 *     Amazon にレンタルがあることは否定していない（表では ○ → △ になる）。
 *   ★ **「取り扱いなし（×）」にしない。** 記号の意味が違う
 *     （`site/src/lib/availability.ts` の「絶対に守ること」2）。
 *   ★ **台帳は書き換えない。** あれはAPIが何と言ったかの記録で、
 *     消すと**次に取り直したとき同じ嘘が戻る**うえ、食い違いの証拠も消える。
 *
 * ■ 判定がここと site の2か所にある
 * `site/src/lib/availability-ng.ts` に同じ規則を写してある。
 * **site は pipeline を import しない**という境界のため（`site/src/lib/availability.ts`
 * が同じ理由で判定を写しているのと同じ事情）。**どちらかを変えるときは両方変える。**
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const AVAILABILITY_NG_PATH = join('data', 'availability-ng.json')

/** 取り下げる組み合わせ1件。`ids` と `match` は**どちらかに当たれば**取り下げる。 */
export interface AvailabilityNgEntry {
  /** テーマのサービスキー（`prime-video` など）。**必須** */
  service: string
  /** 作品ID（配信APIの `show.id`）。完全一致 */
  ids?: string[]
  /** 題名。**部分一致**（原題・邦題・localizedTitle のどれかに当たればよい） */
  match?: string
  checkedAt?: string
  checkedBy?: string
  evidence?: string
  note?: string
}

interface NgFile {
  entries?: AvailabilityNgEntry[]
}

let cache: AvailabilityNgEntry[] | null = null

/**
 * 一覧を読む。**無くても落とさない。**
 * 目視で否認した組み合わせが1件も無い状態は異常ではない。
 */
export function loadAvailabilityNg(): AvailabilityNgEntry[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(AVAILABILITY_NG_PATH, 'utf8')) as NgFile
    cache = (raw.entries ?? []).filter((e) => e.service && (e.ids?.length || e.match))
  } catch {
    cache = []
  }
  return cache
}

/**
 * 作品が持ちうる題名を並べる。**原題も入れる。**
 * `localizedTitle` は原題にかなが含まれるときだけ入るので
 * （`withJapaneseWorkTitle`）、漢字だけの邦題はそこを通らない。
 */
export function titlesOf(
  work: { title?: string; localizedTitle?: string; originalTitle?: string } | undefined,
): string[] {
  if (!work) return []
  return [work.title, work.localizedTitle, work.originalTitle].filter(
    (t): t is string => !!t,
  )
}

/**
 * その（作品・サービス）の見放題を取り下げるか。
 *
 * ★ **呼び出し側が entries を直接読まないこと。** 判定を散らすと、
 *   いつか片方だけが取り下げて、地の文と表が食い違う。
 */
export function deniesSubscription(
  service: string,
  workId: string,
  titles: readonly string[] = [],
): boolean {
  return loadAvailabilityNg().some((e) => {
    if (e.service !== service) return false
    if (e.ids?.includes(workId)) return true
    return !!e.match && titles.some((t) => t.includes(e.match!))
  })
}
