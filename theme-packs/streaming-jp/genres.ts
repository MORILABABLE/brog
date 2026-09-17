/**
 * 作品をジャンル（アニメ / 洋画・海外ドラマ / 邦画・国内ドラマ）に振り分ける。
 *
 * ■ なぜテーマパック側にあるか
 * 「アニメ」という括りも「洋画」という括りも、日本の読者にとっての区分であって
 * パイプラインが知るべきことではない。配信APIは作品の出自を返さないので、
 * ここで Wikidata の原語と API の originalTitle から判定する。
 *
 * ■ 判定の材料と優先順位
 *   1. Wikidata の原語（P364）  … 最も確実。data/origins.json にキャッシュ済み
 *   2. API の originalTitle      … 日本作品は日本語表記で返るので、かなを含めば日本語作品
 * どちらでも決まらないものは undefined を返し、**記事に出さない**。
 * 誤って邦画記事に海外作品を混ぜるより、落とすほうが読者にとって害が小さい。
 *
 * ■ 海外アニメの扱い
 * 「アニメ」記事は日本のアニメを主軸にする。海外のアニメーション作品
 * （ヒックとドラゴン、パウ・パトロール等）は洋画記事に含める。
 */
import { readFileSync } from 'node:fs'
import { ORIGIN_CACHE_PATH, titleCacheKey, type OriginCache } from '../../pipeline/sources/wikidata.ts'
import type { ArticleVariant, GenreSummary } from '../../pipeline/core/article.ts'
import type { Work } from '../../pipeline/sources/types.ts'

export type GenreKey = 'anime' | 'western' | 'japanese'

/** 記事にできるジャンル。ここに並べた順が `--list` の並び順になる。 */
export const GENRES: readonly ArticleVariant[] = [
  { key: 'anime', label: 'アニメ' },
  { key: 'western', label: '洋画・海外ドラマ' },
  { key: 'japanese', label: '邦画・国内ドラマ' },
] as const

/** API が genres に入れてくるアニメーション作品の名前 */
const ANIMATION = 'Animation'

/** ひらがな・カタカナ。長音符「ー」と中黒「・」は他言語の表記にも出るので含めない。 */
const KANA = /[ぁ-ゖァ-ヺ]/
/** 漢字。日本語とは限らない（中国語圏の作品も該当する）。 */
const HAN = /[㐀-䶿一-鿿豈-﫿]/

let cache: OriginCache | undefined

/**
 * 原語キャッシュを読む。無ければ空で動く（＝Wikidata由来の判定が効かないだけ）。
 * `npm run enrich` で作られる。
 */
function origins(): OriginCache {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(ORIGIN_CACHE_PATH, 'utf8')) as OriginCache
    } catch {
      cache = {}
    }
  }
  return cache
}

/** テスト・再読込用 */
export function resetOriginCache(): void {
  cache = undefined
}

function originLanguages(work: Work): string[] | undefined {
  const key = titleCacheKey({
    imdbId: typeof work.meta.imdbId === 'string' ? work.meta.imdbId : undefined,
    tmdbId: typeof work.meta.tmdbId === 'string' ? work.meta.tmdbId : undefined,
  })
  const langs = key ? origins()[key] : undefined
  return langs?.length ? langs : undefined
}

/**
 * 日本語作品か。判定できなければ undefined。
 *
 * originalTitle が漢字だけの場合に undefined を返すのは、
 * 中国語圏の作品（例: 三城記）と漢字だけの邦題（例: 敵）を区別できないため。
 * ここで当て推量すると、邦画記事に中国映画が混ざる。
 */
function isJapanese(work: Work): boolean | undefined {
  const langs = originLanguages(work)
  if (langs) {
    /*
     * ★ **日本語を含むだけでは日本の作品と言えない**（2026-08-28 に修正）。
     *   「インセプション」の P364 は French / English / Japanese で、
     *   これを「日本語を含む＝邦画」と読むと**ノーラン作品が邦画記事に載る**。
     *
     *   かといって「含むけれど単独ではない＝海外作品」と決めると、
     *   英語のせりふがある邦画が洋画記事に落ちる。どちらも誤りなので、
     *   **判定できないもの（undefined）として扱う。**
     *   その先は収集元が付けた区分（fromSourceGenres）が決め、
     *   それも無ければ記事に出さない。このファイルの方針どおり。
     */
    if (langs.length === 1) return langs[0] === 'Japanese'
    return langs.includes('Japanese') ? undefined : false
  }

  const original = work.originalTitle
  if (!original) return undefined
  if (KANA.test(original)) return true
  if (HAN.test(original)) return undefined
  return false
}

/**
 * 収集元が自分で付けているジャンル名 → このテーマの区分。
 *
 * ■ なぜ要るか（2026-08-26 追加）
 * U-NEXT は自前収集で、**`originalTitle` を1件も持っていない**（実測 723件中0件）。
 * Wikidata の原語も imdbId / tmdbId が無いので引けない。
 * つまり上の `isJapanese()` はU-NEXT作品に対して**必ず undefined を返す**。
 * その結果、8月の120件が丸ごとジャンル別記事から落ちていた。
 *
 * ところが U-NEXT は**自分の分類を持っている**（メニューのカテゴリ名）。
 * 推測ではなく提供元が付けた区分なので、これを使えば誤情報にならない。
 *
 * ★ **どちらとも取れる区分は入れないこと。**
 *   「キッズ」「音楽・ライブ」「バラエティ」「舞台・演劇」「ドキュメンタリー」は
 *   国内外のどちらもありうるので、意図的に対応表から外してある
 *   （振り分けを当て推量すると、邦画記事に海外作品が混ざる）。
 *   落ちた作品はサービス別記事（arrivals-service / leaving）で必ず拾われる。
 *
 * ★ 語彙が2種類ある。`work.genres` と `work.meta.mainGenreName` で
 *   表記が違う（「韓流・アジア」と「韓流・アジアドラマ」など）。**両方を入れる。**
 */
const SOURCE_GENRES: Record<string, GenreKey> = {
  洋画: 'western',
  海外ドラマ: 'western',
  '韓流・アジア': 'western',
  '韓流・アジアドラマ': 'western',
  邦画: 'japanese',
  国内ドラマ: 'japanese',
  アニメ: 'anime',
}

/**
 * 各社の告知が自分で付けている見出し → このテーマの区分。
 *
 * ■ なぜ要るか（2026-08-28 追加）
 * 告知から取り込んだ作品（`meta.source === 'announcement'`）は、
 * **配信APIで特定できたものにしかジャンルも原語も付かない**（実測 84件中37件）。
 * 残りは上の `isJapanese()` も `work.genres` も空振りし、ジャンル別記事から丸ごと落ちる。
 *
 * 告知には「映画（海外・韓国）」「テレビアニメ（日本）」のような見出しがあり、
 * これは**提供元が付けた区分**なので推測にならない。U-NEXT のカテゴリ名と同じ扱いにする。
 *
 * ★ 「バラエティー」「スポーツ」は意図的に対応させない。
 *   国内外のどちらもありうるうえ、ジャンル別記事の3区分のどれでもない。
 *   当て推量で邦画記事に入れるより、落とすほうが読者にとって害が小さい。
 */
function fromAnnouncementCategory(work: Work): GenreKey | undefined {
  if (work.meta.source !== 'announcement') return undefined
  const category = work.meta.category
  if (typeof category !== 'string') return undefined

  // ★ 見る順番に意味がある。「アニメ映画（日本）」は アニメ であって 邦画 ではない。
  if (/アニメ/.test(category)) return /日本/.test(category) ? 'anime' : 'western'
  if (/海外|韓国|中国|アジア/.test(category)) return 'western'
  if (/日本|国内/.test(category)) return 'japanese'
  return undefined
}

/**
 * 収集元のジャンル名から区分を引く。当たらなければ undefined。
 * `work.genres` を先に見る（作品ごとの値で、メニュー由来の
 * `mainGenreName` より作品に近い）。
 */
function fromSourceGenres(work: Work): GenreKey | undefined {
  const key = sourceGenreKey(work)
  // ★ **海外のアニメーションは洋画**（冒頭の「海外アニメの扱い」）。
  //   U-NEXT は「アニメ」の棚に海外作品も置くので、棚の名前だけで決めると
  //   リック・アンド・モーティやアドベンチャー・タイムがアニメ記事に載る
  //   （2026-09-17 実測で69作）。作品詳細の制作国（`meta.country`）で振り直す。
  //   日本を含む共同制作（「日本/中国」）は振り直さない。
  if (key === 'anime' && madeOnlyOverseas(work)) return 'western'
  return key
}

function sourceGenreKey(work: Work): GenreKey | undefined {
  for (const name of work.genres) {
    const hit = SOURCE_GENRES[name]
    if (hit) return hit
  }
  const main = work.meta.mainGenreName
  if (typeof main === 'string' && SOURCE_GENRES[main]) return SOURCE_GENRES[main]
  return fromAnnouncementCategory(work)
}

/**
 * 収集元が制作国を持っていて、そこに日本が無いか。制作国が無ければ false（決めない）。
 * ★ **アニメの振り直しにだけ使う。** 制作国の付いたドキュメンタリー等を洋画に入れるかは
 *   別の判断で、ここでは広げない（判定不能のまま記事に出さない、が冒頭の方針）。
 */
function madeOnlyOverseas(work: Work): boolean {
  const country = work.meta.country
  if (typeof country !== 'string' || !country.trim()) return false
  return !country.split('/').map((c) => c.trim()).includes('日本')
}

/** 作品のジャンル。判定できなければ undefined（記事に出さない）。 */
export function classify(work: Work): GenreKey | undefined {
  const japanese = isJapanese(work)
  if (japanese !== undefined) {
    return japanese ? (work.genres.includes(ANIMATION) ? 'anime' : 'japanese') : 'western'
  }
  // ★ 原語で決まらなかったときだけ、収集元の分類に頼る。
  //   Wikidata と originalTitle のほうが確度が高いので、順番を入れ替えないこと。
  return fromSourceGenres(work)
}

export function genreLabel(key: string): string {
  return GENRES.find((g) => g.key === key)?.label ?? key
}

// --- 記事1本ぶんの集計（バッジに出すジャンル） ---------------------------

/**
 * 詳細ジャンル（「洋画(SF)」の括弧の中）の語彙。
 * 配信APIが `work.genres` に入れてくる英語名 → 読者に見せる日本語。
 *
 * ■ なぜ英語名だけを引くか
 * `work.genres` には U-NEXT のカテゴリ名（「洋画」「国内ドラマ」など）も混ざるが、
 * あれは**基本ジャンルと同じ粒度**で、括弧に入れても「洋画(洋画)」にしかならない。
 * 詳細の手掛かりになるのは配信APIが付ける英語の区分だけなので、そちらだけを引く。
 *
 * ★ **ここに無い名前は詳細にしない。** 括弧に生の英語が出るより、
 *   基本ジャンルだけのほうが読者にとって害が小さい（genres.ts 全体の方針）。
 */
const DETAIL_LABELS: Record<string, string> = {
  Action: 'アクション',
  Adventure: 'アドベンチャー',
  'Science Fiction': 'SF',
  Fantasy: 'ファンタジー',
  Horror: 'ホラー',
  Mystery: 'ミステリー',
  Thriller: 'スリラー',
  Crime: 'クライム',
  Comedy: 'コメディ',
  Romance: 'ロマンス',
  Documentary: 'ドキュメンタリー',
  History: '歴史',
  Music: '音楽',
  War: '戦争',
  Western: '西部劇',
}

/*
 * ★ `Drama` `Animation` `Family` は**わざと入れていない。**
 *   実測で最も多い3つ（Drama 687件・Animation 413件・Family 114件）だが、
 *   Drama は「邦画(ドラマ)」のように基本ジャンルと同じことを二度言うだけで、
 *   Animation は「アニメ」そのもの、Family も作品を絞る手掛かりにならない。
 *   詳細は**その記事が何の話か**を1語で足せるときだけ出す。
 */

/*
 * ★ 返す形（`GenreSummary`）は**パイプライン側が決めている**
 *   （pipeline/core/article.ts）。テーマを差し替えても frontmatter の形が
 *   変わらないようにするため。ここが決めるのは中身だけ。
 */

/**
 * 基本ジャンルをバッジに出す下限。
 *
 * 「含まれるジャンルは全部出す」が原則だが、**1本だけ混ざった作品**まで
 * 拾うと事故が出る。63本の洋画記事に判定を誤った1本が混じっただけで
 * 「アニメ」のバッジが立ってしまう。
 * 2本以上あるか、全体の1割を占めていれば本物とみなす。
 * （どちらも満たさなくても、一番多いジャンルは必ず出す。全記事に付けるため）
 */
const MIN_WORKS = 2
const MIN_SHARE = 0.1

/**
 * 詳細ジャンルを名乗る下限。
 *
 * ★ **その記事の作品の6割以上**が同じ詳細を持つこと。
 *   「洋画(SF)」と書いた記事の中身が3割しかSFでないなら、読者への説明になっていない。
 * ★ **判定できた作品が5本以上あること。** 少ない本数で詳細まで名乗ると、
 *   たまたま当たった2〜3本の色がそのまま記事の看板になる
 *   （収集データと突き合わない古い記事で実際に起きる）。
 *   詳細は無くてよいもの（基本ジャンルだけで記事は成立する）なので、
 *   自信が無いときは付けない。
 */
const DETAIL_SHARE = 0.6
const DETAIL_MIN_WORKS = 5

/** 同じ作品を二度数えないための鍵。サービスをまたぐと `id` が変わるので題で見る。 */
function workKey(work: Work): string {
  return (work.localizedTitle ?? work.title ?? work.id).replace(/\s+/g, '').toLowerCase()
}

/**
 * 記事に入っている作品から、その記事が名乗るジャンルを決める。
 *
 * ■ なぜ「軸」ではなく中身で決めるのか（2026-09-15）
 * 以前はジャンル軸の記事だけが `genre` を1つ名乗り、サービス軸の記事は
 * 何も名乗らなかった（1つに絞ると嘘になるため）。結果として**32本中29本が
 * ジャンルのバッジを持たない**状態になり、読者は一覧で「何を観る話か」を
 * タイトルから読み取るしかなかった。
 *
 * 1つに絞るのをやめて、**入っているものを全部名乗る**形にすれば嘘にならない。
 * 「配信終了予定｜アニメ｜洋画｜邦画」は、その記事の中身をそのまま表している。
 *
 * ★ 返す並びは**本数の多い順**。先頭が主なジャンルになる。
 * ★ 判定できない作品（genres.ts の方針で undefined になるもの）は数えない。
 *   全部が undefined の記事では空が返る。呼び出し側が扱いを決めること。
 */
export function summarizeGenres(works: readonly Work[]): GenreSummary {
  const seen = new Map<string, Work>()
  for (const w of works) {
    const key = workKey(w)
    if (!seen.has(key)) seen.set(key, w)
  }

  const counts = new Map<GenreKey, number>()
  const details = new Map<string, number>()
  let total = 0

  for (const work of seen.values()) {
    const key = classify(work)
    if (!key) continue
    total++
    counts.set(key, (counts.get(key) ?? 0) + 1)
    // 詳細は作品ごとに重複を除く（同じ作品が Action を2回持つことはないが、念のため）
    for (const name of new Set(work.genres)) {
      const label = DETAIL_LABELS[name]
      if (label) details.set(label, (details.get(label) ?? 0) + 1)
    }
  }

  if (total === 0) return { genres: [] }

  const order = GENRES.map((g) => g.key as GenreKey)
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]),
  )
  const genres = ranked
    .filter(([, n], i) => i === 0 || n >= MIN_WORKS || n / total >= MIN_SHARE)
    .map(([key]) => key)

  if (genres.length !== 1 || total < DETAIL_MIN_WORKS) return { genres }

  const top = [...details.entries()].sort((a, b) => b[1] - a[1])[0]
  return { genres, detail: top && top[1] / total >= DETAIL_SHARE ? top[0] : undefined }
}
