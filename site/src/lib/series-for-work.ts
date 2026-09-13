/**
 * その作品を扱っている**シリーズ記事**を引く。
 *
 * ■ 何のためにあるか（2026-09-13）
 * **作品ページ同士が、シリーズ級の検索語で食い合っていた。**
 *
 *   実測（Search Console・2026-08-25〜09-12）
 *     「ハリーポッター ネトフリ いつまで」
 *        9.0位 /works/536 ・ 10.0位 /works/446 ・ 10.3位 /works/428 ・ 10.3位 /works/548
 *        → **表示13・クリック0。** CTR 10.2%・7.5位で戦える
 *          `/posts/harry-potter` はこの検索語に出ていない
 *
 * 作品ページ8枚が10位あたりに並び、どれも押されない。**分散している。**
 * 単作の検索語（「スリザー 配信」など・表示の大半）は作品ページが正しい受け皿なので、
 * **消すのではなく、シリーズ級の問いに答えられる記事へ道を作る。**
 *
 * ★ **canonical でも noindex でもない**（2026-09-13・運用者の判断）。
 *   どちらも単作の長尾を捨てることになる。まず内部リンクで様子を見る。
 *   効かなければ [FUNNEL.md](../../../docs/FUNNEL.md) に記録して次の手を考える。
 *
 * ■ 引き当ての元
 * `data/articles.json` の `flags.match`。**記事を書いたときに人が指定した
 * 作品名の正規表現**（`npm run write -- --match ハリー・ポッターと|ファンタスティック・ビースト`）で、
 * その記事がどの作品を集めたかの定義そのもの。
 * **ここで新しく判定条件を作らない** — 作れば記事の中身とずれる。
 *
 * ★ **`typeId: 'series'` だけを見る。** `special` も `match` を持つが、
 *   あちらは月を名乗る記事で**いずれ退役する**（docs/STOCK.md）。
 *   作品ページは残り続けるので、消える記事へ常設のリンクを張らない。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** シリーズ記事1本ぶんの引き当て条件。 */
export interface SeriesRef {
  /** 記事の slug（`/posts/<slug>`） */
  slug: string
  /** 「「ハリー・ポッター」シリーズ」。画面には出さないが、説明とデバッグに使う */
  topic: string
}

interface ArticleRecord {
  slug?: string
  typeId?: string
  flags?: Record<string, string>
}

/**
 * `data/articles.json` を探す。
 *
 * ★ `work-links.ts` / `availability.ts` と同じ理由で実行時のカレントから上へ辿る。
 *   Astro はビルド時にこのファイルをチャンクへバンドルするので、
 *   `import.meta.url` からの相対解決は位置が変わって当たらない。
 */
function findUp(...segments: string[]): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

let matchers: { ref: SeriesRef; re: RegExp }[] | null = null

function load(): { ref: SeriesRef; re: RegExp }[] {
  if (matchers) return matchers
  matchers = []
  const path = findUp('data', 'articles.json')
  if (!path) return matchers
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { articles?: ArticleRecord[] }
    for (const a of raw.articles ?? []) {
      if (a.typeId !== 'series') continue
      const slug = a.slug
      const pattern = a.flags?.match
      if (!slug || !pattern) continue
      try {
        /*
         * ★ **記事を書いたときの正規表現をそのまま使う。**
         *   `crayon-shin-chan` の `^(?!クレヨンしんちゃん$)...` のような
         *   否定先読みが入っているものもある。書き換えると集めた範囲とずれる。
         * ★ 壊れた正規表現は**その1本だけ落とす。** 全体を落とさない。
         */
        matchers.push({ ref: { slug, topic: a.flags?.topic ?? slug }, re: new RegExp(pattern) })
      } catch {
        // 読めない条件は無かったことにする（リンクが1本出ないだけ）
      }
    }
  } catch {
    // 台帳が無い・壊れているときはリンクを出さない
  }
  return matchers
}

/**
 * その題名を扱っているシリーズ記事。**当たらなければ `undefined`。**
 *
 * ★ **当たりが複数のときは出さない。** どれか1本を選ぶ根拠が無く、
 *   間違ったシリーズへ送るくらいならリンクを出さないほうがよい
 *   （`rehype-availability.ts` の `marksOf` と同じ考え方）。
 *   実際に起こりうる — 「仮面ライダー」と「ウルトラマン」の両方に
 *   当たる作品名が将来出ないとは言えない。
 */
export function seriesRefFor(title: string): SeriesRef | undefined {
  const hits = load().filter((m) => m.re.test(title))
  return hits.length === 1 ? hits[0]!.ref : undefined
}

/** テスト・再読込用。 */
export function resetSeriesRefs(): void {
  matchers = null
}
