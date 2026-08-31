/**
 * **サービスを横断して終わる作品群を見つける。** シリーズ記事の主題の候補出し。
 *
 * ■ なぜ要るか
 * 記事の軸の決まり（`templates/naming.md`）で、**サービス軸の記事に他社を混ぜられない**。
 * 同じシリーズが Netflix と U-NEXT で同時に終わっても、
 * サービス別の月次記事では2本に割れ、読者の
 * 「◯◯シリーズ、いつまで観られる？」には**どちらの記事も答えていない**状態になる。
 * 横断してよいのは主題軸（`series` / `special`）だけなので、
 * **横断が起きていることに運用者が気づける**必要がある。
 *
 * 実際に起きた見落とし（2026-08。`coverage.ts` の事故と同じ日）:
 *
 *   Netflix の8月31日終了61本のうち**29本が「名探偵コナン」劇場版**、
 *   同じ日に U-NEXT でも劇場版32本が終了予定に入っていた。
 *   一覧表には「leaving --service netflix 61件」としか出ておらず、
 *   **1つのシリーズが2社で同時に終わっていることは数字に表れていなかった。**
 *
 * ■ 機械にできるのは候補出しまで
 * **シリーズの機械判定はできない**（docs/KEYWORDS.md 3-3）。
 * ここがやるのは「邦題の先頭が同じ作品が、複数社で同時に終わっている」を数えることだけ。
 * 主題の言い方（`--topic`）・URL（`--slug`）・絞り込み（`--match`）は**人が決める**。
 * 束の名前をそのまま記事の主題にしないこと。
 *
 *   束の名前   `ウルトラマ`（先頭6文字）
 *   記事の主題 `「ウルトラマン」シリーズ`   ← 人が付ける
 *
 * ■ 先頭6文字で束ねる理由
 * docs/KEYWORDS.md 9節の実測スクリプトと**同じ方法**にしてある。
 * 2026-08 の観測（2,228件）で、3件以上まとまる束が51個できた。
 * 短くすると無関係な作品が混ざり、長くすると副題で割れる。
 * **粗いのは承知のうえ**で、最終的な件数は `--dry-run` が正確に出す。
 */
import type { ChangeEvent } from '../sources/types.ts'
import { mentionsByTitle, type MentionsFn, type PublishedPost } from './coverage.ts'

/** 束ねるのに使う邦題の先頭文字数（docs/KEYWORDS.md 9節と同じ値） */
const PREFIX_LENGTH = 6

/**
 * 束として出す最小の作品数。
 * ★ シリーズ記事の `minItems` と揃えること。ここだけ緩めると、
 *   候補に出したのに `--emit` が「素材不足」で止まる。
 */
const MIN_WORKS = 3

/**
 * 出す条件のサービス数。**2社以上＝横断**。
 * ★ 1社で閉じている束は、そのサービスの月次記事が扱える。
 *   ここに出す意味があるのは、月次記事の形では扱えないものだけ。
 */
const MIN_SERVICES = 2

/** シリーズ記事の目印。`article-types/series.ts` の `tags()` と揃えること。 */
const SERIES_TAG = 'シリーズ'

export interface SeriesCandidate {
  /** 束の名前（邦題の先頭6文字）。**記事の主題ではない** */
  key: string
  /** `--match` にそのまま渡せる形にエスケープした束の名前 */
  match: string
  /** その束の素材（シリーズ記事の `select()` が返したもの） */
  items: ChangeEvent[]
  /** 作品数。同じ作品が複数社にあっても1と数える */
  works: number
  /** またがっているサービス（キー） */
  services: string[]
  /** いちばん近い終了日（ISO）。無ければ undefined */
  nearest?: string
  /** 既存のシリーズ記事にまだ出ていない作品数。0 なら「もう書いた束」 */
  uncovered: number
  /** 人が主題を決めるための手がかり。長い順に最大3件 */
  titles: string[]
}

/** 正規表現の特殊文字を打ち消す（束の名前をそのまま `--match` に渡すため） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 横断して終わるシリーズの候補を、大きい順に返す。
 *
 * @param events 収集済みの全イベント（`readAllEvents()`）
 * @param posts  公開済み記事（`readPublishedPosts()`）。**シリーズ記事だけを見る**
 * @param select 束の名前を `--match` に渡したときの素材。
 *   **シリーズ記事タイプの `select()` をそのまま渡すこと。**
 *   出さないと決めた作品の除外・ポイント専用作品の除外・
 *   サービスごとに最新の観測だけ残す、といった判断はすべてそちらが持っている。
 *   ここで真似をすると、候補の件数と `--dry-run` の件数がずれる。
 * @param mentions 作品が本文に出ているかの判定（シリーズ記事タイプの `mentions`）
 */
export function seriesCandidates(
  events: ChangeEvent[],
  posts: PublishedPost[],
  select: (match: string) => ChangeEvent[],
  mentions: MentionsFn = mentionsByTitle,
): SeriesCandidate[] {
  /*
   * まず粗く束ねる。ここは**作品の異なり**で数える（同じ作品が複数社にあっても1件）。
   * 数えるのは終了まわりの観測だけ。配信開始は「いつまで」に答えられない。
   */
  const buckets = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.kind !== 'expiring' && e.kind !== 'removed') continue
    const title = (e.work.localizedTitle ?? e.work.title ?? '').trim()
    // 3文字以下の題は先頭6文字で束ねる意味がない（題そのものになる）
    if (title.length <= PREFIX_LENGTH / 2) continue
    const key = title.slice(0, PREFIX_LENGTH)
    if (!buckets.has(key)) buckets.set(key, new Set())
    buckets.get(key)!.add(String(e.work.id))
  }

  // 既存のシリーズ記事の本文。**同じ束を2本書かないための唯一の歯止め**
  const seriesBodies = posts
    .filter((p) => !p.draft && p.tags.includes(SERIES_TAG))
    .map((p) => p.body)

  const out: SeriesCandidate[] = []
  for (const [key, ids] of buckets) {
    if (ids.size < MIN_WORKS) continue

    // ★ ここから先は記事タイプの判断に任せる（引数 `select` の説明）
    const match = escapeRegExp(key)
    /*
     * ★ **束の名前で始まる作品だけに絞り直す。**
     *   記事タイプの `select()` は原題と邦題の両方に `--match` を当てる。
     *   束は邦題の先頭で作っているので、絞り直さないと
     *   **原題がたまたま同じ文字で始まる別作品**が同じ束に入る。
     *
     *     束 `Black `（原題しか無い作品から作られた）
     *     → 原題 `Black Iron Submarine` の「名探偵コナン 黒鉄の魚影」が混ざる
     *
     *   人が `--match` を書き直せば拾える範囲なので、**候補の側は狭く出す。**
     *   広く出すと、無関係な作品が並んだ束を毎回読み飛ばすことになる。
     */
    const items = select(match).filter((e) =>
      (e.work.localizedTitle ?? e.work.title ?? '').startsWith(key),
    )
    if (items.length === 0) continue

    const services = [...new Set(items.map((e) => e.service))]
    if (services.length < MIN_SERVICES) continue

    const works = new Set(items.map((e) => String(e.work.id)))
    if (works.size < MIN_WORKS) continue

    const uncovered = items.filter((e) => !seriesBodies.some((b) => mentions(e, b, items))).length
    if (uncovered === 0) continue

    out.push({
      key,
      match,
      items,
      works: works.size,
      uncovered,
      services,
      nearest: items
        .map((e) => e.at)
        .filter((at): at is string => Boolean(at))
        .sort()[0],
      /*
       * 手がかりに出す題名。**長いものから**選ぶ。
       * 先頭6文字は全件で同じなので、短い題を出すと束の名前と変わらない行になる。
       */
      titles: [...new Map(items.map((e) => [String(e.work.id), e] as const)).values()]
        .map((e) => e.work.localizedTitle ?? e.work.title)
        .sort((a, b) => b.length - a.length)
        .slice(0, 3),
    })
  }

  // 大きい束が先。同じなら締切の近い順（書くかどうかを決める順序）
  return out.sort((a, b) => b.works - a.works || (a.nearest ?? '9999').localeCompare(b.nearest ?? '9999'))
}
