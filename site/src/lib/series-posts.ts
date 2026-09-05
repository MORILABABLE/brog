/**
 * シリーズ記事（保存版）の拾い方。**右の枠（SeriesRail.astro）と
 * 一覧ページ（pages/series.astro）が両方ここを読む。**
 *
 * ■ シリーズ記事とは
 * `theme-packs/streaming-jp/article-types/series.ts` が書く、
 * **月を名乗らない唯一の記事タイプ**。URLに月が入らず（`conan-movies`）、
 * 配信状況が変わるたびに同じURLを書き直す（docs/KEYWORDS.md 案1・docs/STOCK.md 2-2）。
 *
 * ■ なぜタグで拾うのか
 * 記事の frontmatter には「記事タイプ」が入らない。入っているのは
 * カテゴリ（leaving / ended / arrivals / ranking）とタグだけで、
 * **シリーズ記事のカテゴリは行き来する**（`series.ts` の `stanceOf()`）。
 *
 *   leaving  終了予定が1本でもある
 *   ended    全部終わっている
 *   arrivals 終了予定が無い。**見放題に復帰した作品**か、**いま配信中の作品**がある
 *
 * カテゴリでは拾えないので、記事タイプ側が必ず付けるタグ1つで拾う。
 *
 * ★ **`arrivals` の2つは別の枠に出す。** 復帰は終了日を持ちうるが、
 *   配信中は持たない。カテゴリでは区別できないので `STREAMING_TAG` で分ける。
 *
 * ★ `SERIES_TAG` は `series.ts` の `tags()` が入れる文字列と**完全に一致させること。**
 *   1文字でも違うと、記事はできているのに枠から消える（0件の枠は描画されない）。
 */
import type { CollectionEntry } from 'astro:content'
import type { CategorySlug } from '../config'

/** シリーズ記事の目印。`article-types/series.ts` の `tags()` と揃えること。 */
export const SERIES_TAG = 'シリーズ'

/**
 * **終了日がまだ分かっていない**シリーズ記事の目印（2026-09-05 追加）。
 *
 * ■ なぜカテゴリで分けられないのか
 * `series.ts` の `stanceOf()` は `streaming`（いま配信中）も
 * `returned`（見放題に復帰）も**同じ `arrivals` カテゴリ**にする。
 * どちらも読者に渡すのが「いま観られる」ことなので、それ自体は正しい。
 * だが枠を分けるには**締切があるかどうか**で区別する必要があり、
 * カテゴリにはその情報が無い。
 *
 * ★ `article-types/series.ts` の `tags()` が入れる文字列と**完全に一致させること。**
 *   1文字でも違うと、記事はできているのに「見放題配信中」の枠から消える。
 */
export const STREAMING_TAG = '見放題配信中'

export interface SeriesPost {
  /**
   * 元の記事そのもの。**一覧ページ（/series）が記事カードに渡す。**
   *
   * ★ 枠（SeriesRail）は使わない。あちらは幅17remに収める専用の見た目で、
   *   下の `label` / `heroImage` だけを使う。一覧ページのほうは
   *   他の一覧と**同じ記事カード**（PostCard.astro）で出したいので、
   *   加工前の記事が要る。片方のために作った形をもう片方へ持ち込まないこと。
   */
  entry: CollectionEntry<'posts'>
  href: string
  /** 枠に出す短い名前。タイトルから機械的に作る（下の `railLabel`） */
  label: string
  /** 元のタイトル。`title` 属性に出して、省略された部分を補えるようにする */
  fullTitle: string
  category: CategorySlug
  /**
   * 枠に出す絵。**記事の frontmatter の `heroImage` をそのまま渡すだけ。**
   *
   * ★ **この枠専用の画像は作らない。** 記事カード（PostCard）と追従枠の
   *   最新記事（FollowRail）が使っているのと**同じ1枚**で、部品も同じ
   *   （Thumb.astro）。増やすと「同じ記事なのに場所によって絵が違う」状態になり、
   *   取り直し（`npm run refresh:images`）の対象も増える。
   *
   * ★ **権利の扱いはヘッダー画像の決まりがそのまま効く**（docs/APPEARANCE.md 11-12節）。
   *   出どころは配信API（Movie of the Night）のポスターで、
   *   再ホストの許諾を取ってあるのはこの経路だけ。ここへ別の絵を
   *   引っぱってこないこと。
   *
   * ★ **署名付きURLが失効したら勝手に汎用画像になる。** ヘッダー画像は
   *   毎ビルド `npm run sections` が `/heroes/<スラッグ>.webp` を作り直していて、
   *   ポスターが取れなければ**ジャンル別の汎用画像**（自前の幾何学図形）を
   *   同じパスに書く。パスは変わらないので、**この枠は何もしなくてよい。**
   *
   * ★ 絵を差し替えたいときは記事の frontmatter を書き換える。
   *   自動処理は空か `/heroes/<スラッグ>.webp` のときしか触らないので、
   *   別のパスを書けばその記事だけ固定できる（docs/APPEARANCE.md 12節）。
   *
   * 未設定の記事はカテゴリ色のタイルになる（Thumb.astro）。枠は崩れない。
   */
  heroImage?: string
  /**
   * その記事が扱っている作品数。**並び順にだけ使う**（画面には出さない）。
   *
   * ■ なぜタイトルから取るのか
   * frontmatter に本数は入っていない。入れる手もあるが、
   * **読者が数えられる本数はタイトルに出ている数**（`series.ts` の `workCount()`）で、
   * 表の行数と一致させてある。別の場所に第2の本数を作ると、
   * 表示と並び順が別々の数字を見ることになる。
   *
   * ★ タイトルの形は `naming.md` が決めている（`…{動詞句}作品{本数}本…`）。
   *   本数の無いタイトルは品質ゲートが警告を出すので、ここでは 0 に落として
   *   同じ段のいちばん下に置くだけにする（枠から消さない）。
   */
  works: number
  /**
   * **終了日が1本も分かっていない記事か**（`STREAMING_TAG` が付いている）。
   *
   * `true` の記事は「いま観られる」ことだけを言っていて、締切を持たない。
   * 枠は締切のあるものと分けて出す（`seriesRails()`）。
   */
  streaming: boolean
}

/**
 * 枠に出すための2つの束。**「シリーズから探す」と「見放題配信中」。**
 *
 * ■ なぜ分けるのか（2026-09-05 追加）
 * 「シリーズから探す」の枠は、終了予定・終了済みのバッジが付くことで
 * **「何のシリーズが期限まで観られるか」を一目で伝える**ようになっている。
 * そこへ終了日を持たない記事を混ぜると、**同じ並びの中で締切の有無が割れて**
 * バッジの読み方が壊れる。
 *
 * 終了日が分かっていない記事は読者への用事が別（「いま観られる？」）なので、
 * 枠ごと分けて下に置く。**順番も意味を持つ**（締切のあるほうが先）。
 */
export interface SeriesRails {
  /** 終了日が分かっている記事（終了予定・復帰・終了済み） */
  dated: SeriesPost[]
  /** 終了日が分かっていない記事（いま見放題で配信中） */
  streaming: SeriesPost[]
}

/** `seriesPosts()` を2つの枠に振り分ける。並びはそれぞれの中で保たれる。 */
export function seriesRails(posts: CollectionEntry<'posts'>[]): SeriesRails {
  const all = seriesPosts(posts)
  return {
    dated: all.filter((p) => !p.streaming),
    streaming: all.filter((p) => p.streaming),
  }
}

/**
 * タイトルから作品数を取る。`作品32本` → 32。
 *
 * ★ `作品(\d+)本` を先に見る。見どころ（`｜` の後ろ）に
 *   「劇場版5本も終了」のような数字が入ることがあり、
 *   最初に見つかった `◯本` を拾うと**そちらを本数として並べてしまう**。
 */
function workCount(title: string): number {
  const m = /作品(\d+)本/.exec(title) ?? /(\d+)本/.exec(title)
  return m ? Number(m[1]) : 0
}

/**
 * 並びの「段」。**小さいほど上。**
 *
 * ■ なぜカテゴリで段に分けるのか
 * シリーズ記事のカテゴリは**読者にとっての急ぎ具合**そのもの
 * （`series.ts` の `stanceOf()`）。
 *
 *   leaving  まだ観られる／締切がある     → いちばん上
 *   arrivals 見放題に復帰した（締切は無い） → 次
 *   ended    もう観られない               → いちばん下
 *
 * ★ `arrivals`（復帰）を `leaving` に混ぜない。締切のある記事のほうが先で、
 *   混ぜると「急ぐ必要のある記事」が本数の少なさで下がることがある。
 * ★ `ranking` はシリーズ記事には付かないが、`CategorySlug` の値なので置いておく。
 */
const TIER: Record<CategorySlug, number> = { leaving: 0, arrivals: 1, ended: 2, ranking: 3 }

/**
 * 枠に出す名前を、記事タイトルから作る。
 *
 * 記事タイトルは「【保存版】{主題}の{動詞句}作品{本数}本｜{見どころ}」の形で、
 * 幅17remの枠には長すぎる。表示のためだけに2か所を落とす。
 *
 *   【保存版】「名探偵コナン」劇場版シリーズの見放題配信が終了予定の作品61本｜Netflixで8月31日まで
 *   → 「名探偵コナン」劇場版シリーズの見放題配信が終了予定の作品61本
 *
 * ★ **落とすのはこの2つだけ。** 主題も動詞句も本数も残す。
 *   - 先頭の【保存版】… 全行で同じ文字列なので、並べると情報量が0
 *   - ｜のあとの見どころ … 1行に収まらず、2行に折り返すと主題が押し出される
 *
 * ★ 主題そのものを切り出そうとしないこと。
 *   タイトルの決まり（naming.md）が求めているのは「主題と動詞句が入っていること」で、
 *   **並び順までは決めていない。** 「見放題配信が終了予定の『◯◯』5本」と書かれても
 *   検査は通るので、位置を前提に切ると記事によって別の場所が切れる。
 */
function railLabel(title: string): string {
  return title.replace(/^【[^】]*】/, '').split('｜')[0]!.trim()
}

/**
 * 公開中のシリーズ記事を、**まだ観られるものから**返す。
 *
 * ■ 並び（2026-09-02 変更。それまでは `pubDate` の降順だった）
 *
 *   1段目 `leaving`  まだ観られる … **本数の多い順**
 *   2段目 `arrivals` 見放題に復帰 … 同上
 *   3段目 `ended`    もう観られない … **本数の少ない順**
 *
 * ★ **なぜ「最近手を入れた順」をやめたか。**
 *   シリーズ記事は書き直すたびに `pubDate` が振り直される（`buildMarkdown` が
 *   `pubDate: now`）。つまり前の並びは「最後に書き直した順」で、
 *   **全作終了した記事を書き直した日に、その記事が枠のいちばん上に来ていた。**
 *   枠に載るのは5本だけなので、もう観られない記事が
 *   まだ観られる記事を押し出す形になっていた。
 *
 * ★ **終了済みだけ昇順**。もう観られない記事は下へ行くほど目に入らなくてよく、
 *   大きいシリーズほど下に置く。上2段とは逆向きなのが意図。
 *
 * ★ 同数のときだけ `pubDate` の降順に落とす。並びが実行のたびに揺れないように、
 *   最後は必ず決着する比較にしておくこと。
 */
export function seriesPosts(posts: CollectionEntry<'posts'>[]): SeriesPost[] {
  return posts
    .filter((p) => !p.data.draft && p.data.tags.includes(SERIES_TAG))
    .map((p) => ({
      entry: p,
      href: `/posts/${p.id}`,
      label: railLabel(p.data.title),
      fullTitle: p.data.title,
      category: p.data.category,
      heroImage: p.data.heroImage,
      works: workCount(p.data.title),
      streaming: p.data.tags.includes(STREAMING_TAG),
    }))
    .sort((a, b) => {
      const tier = TIER[a.category] - TIER[b.category]
      if (tier !== 0) return tier
      const byWorks = a.category === 'ended' ? a.works - b.works : b.works - a.works
      if (byWorks !== 0) return byWorks
      return b.entry.data.pubDate.valueOf() - a.entry.data.pubDate.valueOf()
    })
}
