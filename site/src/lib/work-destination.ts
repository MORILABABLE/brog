/**
 * 「表の作品名を押したら、どこへ行くか」を決める1か所。
 *
 * ■ work-links.ts との違い（**送り先は2層になった**・2026-08-29）
 *
 *   work-links.ts の resolveUrl … **サイトの外**のどこへ送るか
 *                                 （そのサービスの作品ページ / Amazonの検索）
 *   このファイル                 … **その前に、自分の作品ページへ寄せるか**
 *
 * 記事の表と常設ページの表は、押した瞬間に読者がサイトの外へ出ていた。
 * 作品ページ（`/works/<id>`）があるなら**まずそこへ送る**。
 * 外部リンクは作品ページの側にまとめてあるので、読者は
 * 「どのサービスで観られるか」を見比べてから出ていける
 * （docs/GROWTH.md 3-2 ／ docs/WORK-PAGES.md 7節 ／ docs/STOCK.md S-1）。
 *
 *   前:  記事の表 ──→ Netflix / Amazon（離脱）
 *   後:  記事の表 ──→ /works/<id> ──→ Netflix / Amazon / 他社で探す
 *                                  └→ 関連する作品（内部リンク）
 *
 * ■ 作品ページが無い作品は今までどおり
 * 掲載判定（works.ts の `isWorkPagePublishable`）を通らない作品や、
 * U-NEXT だけで観測した作品にはページが無い。**必ず `hasWorkPage` を通す**。
 * 通さずにリンクを組むと 404 になる。
 *
 * ■ アフィリエイトを内部リンクに付けないこと（重要）
 * `tag=` と `rel="sponsored"` は**外部リンクにだけ**付く印。
 * 自サイトへのリンクに付けるのは誤りで、記事本文は
 * `plugins/rehype-affiliate.ts` が `isExternal()` で弾いてくれるが、
 * **`.astro` 側は自分で分岐する**（rehype を通らないため）。
 * `internal` を見て、内部リンクには `rel` も `target` も付けない。
 *
 * ■ なぜ work-links.ts に直接書かないか
 * work-links.ts は works.ts から読まれている（`resolveUrl`）。
 * そこへ works.ts の `hasWorkPage` を持ち込むと循環参照になる。
 * **依存の向きを一方通行に保つ**ために、判断だけをこのファイルへ出した。
 *   work-destination.ts → works.ts → work-links.ts
 */
import { hasWorkPage } from './works'

export interface Destination {
  url: string
  /** 自サイト内か。**true のときは rel も target も付けないこと** */
  internal: boolean
}

/**
 * 表の作品名の行き先。
 *
 * @param workId 収集データの作品ID（`WorkLink.workId`）
 * @param externalUrl 作品ページが無いときの行き先（`work-links.ts` が決めたURL）
 */
export function tableDestination(workId: string, externalUrl: string): Destination {
  if (workId && hasWorkPage(workId)) {
    return { url: `/works/${workId}`, internal: true }
  }
  return { url: externalUrl, internal: false }
}
