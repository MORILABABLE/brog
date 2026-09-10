/**
 * XMLサイトマップの `<lastmod>`。**astro.config.mjs の `sitemap({ serialize })` から使う。**
 *
 * ■ なぜ要るか（2026-08-30 に追加）
 * それまで XMLサイトマップは `<loc>` だけで、`lastmod` を1件も持っていなかった。
 * **鮮度がこのサイトの売りなのに、いつ変わったのかを伝える手段が無い**状態だった。
 * `/leaving/<サービス>` は毎日中身が入れ替わるので、ここが効く。
 *
 * ■ **「全部いまの時刻」にしない**
 * 毎回すべてのURLが「たったいま更新」になっていると、
 * 検索エンジンはこの値を当てにしなくなる。無いほうがまし、という状態になる。
 * だから**分かるものだけ書き、分からないものは書かない**。
 *
 *   記事           … frontmatter の `updatedDate` ／ 無ければ `pubDate`
 *   **作品ページ**     … **その作品の最終観測日**（下の `workDates()`）
 *   データ由来のページ … **収集データの最終更新日**（人物・常設一覧・一覧ページ）
 *   固定ページ       … **書かない**（about / privacy / contact / guide）
 *
 * ■ 作品ページを1件ずつにした理由（2026-09-10）
 * それまで作品ページ616枚すべてに**収集全体の最終更新日**を書いていた。
 * 収集は毎日走るので、**中身が1文字も変わっていない616枚が毎日「更新」を名乗る**
 * 状態になっていた（731件中691件が同じ日付）。上に書いてある
 * 「全部いまの時刻にしない」を、ページ単位では守れていなかった。
 *
 * 作品ページは「配信情報は◯月◯日時点」を**作品ごとに**持っている
 * （works.ts の `dataAsOf`＝その作品の最も新しい `collectedAt`）。
 * 同じ値を lastmod にも使う。**画面に出ている日付と lastmod が一致する。**
 *
 * ★ Search Console の「検出 - インデックス未登録」に効かせるための変更。
 *   毎日616枚が更新を名乗ると、クローラは再訪しても差分を見つけられず、
 *   この値を当てにしなくなる。
 *
 * ★ ファイルの mtime を使わないこと。Cloudflare のビルドは毎回まっさらな
 *   チェックアウトなので、mtime は「ビルドした時刻」にしかならない。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 作品ページの対象になるサービス。
 *
 * ★ **lib/events-data.ts の `API_SERVICES` と同じ一覧**（U-NEXT は入らない）。
 *   ここで import しないのは、このファイルが astro.config.mjs から
 *   **Astro が立ち上がる前に**読まれるため。他の定義に依存させない
 *   （postDates / monthDates が記事を直接読んでいるのと同じ事情）。
 *   **向こうにサービスを足したら、ここにも足すこと。**
 */
const API_SERVICES = new Set(['netflix', 'prime-video', 'disney-plus', 'apple-tv'])

/**
 * リポジトリの根を探す。**実行時のカレントから上へ辿る。**
 * `site/` の中から走ることも、リポジトリの根から走ることもあるため
 * （events-data.ts / excluded.ts と同じ事情）。
 */
function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'data', 'events'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

/** 収集データの最終更新日（`YYYY-MM-DD`）。取れなければ undefined。 */
function dataUpdatedAt(): string | undefined {
  try {
    const dir = join(repoRoot(), 'data', 'events')
    let newest = ''
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const raw = readFileSync(join(dir, f), 'utf8')
      // ★ 行ごとに JSON.parse しない。2,000行を超えるので、日付だけを拾う。
      for (const m of raw.matchAll(/"collectedAt":"([0-9T:.Z-]+)"/g)) {
        if (m[1]! > newest) newest = m[1]!
      }
    }
    return newest ? newest.slice(0, 10) : undefined
  } catch {
    return undefined
  }
}

/**
 * 作品ID → その作品の最終観測日（`YYYY-MM-DD`）。
 *
 * ★ **works.ts の `build()` と同じ絞り込みにすること。**
 *   API由来のサービスだけ・`upcoming`（配信開始の告知）は除く。
 *   ここだけ広く取ると、作品ページが無いIDにも日付を作ってしまう
 *   （害は無いが、画面の「◯月◯日時点」とずれる）。
 *
 * ★ 行ごとに JSON.parse しない。2,000行を超えるので、要る4つだけを拾う。
 */
function workDates(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const dir = join(repoRoot(), 'data', 'events')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line) continue
        const service = line.match(/"service":"([^"]+)"/)?.[1]
        if (!service || !API_SERVICES.has(service)) continue
        if (/"kind":"upcoming"/.test(line)) continue
        // `"work":{"id":` が先頭。`meta` の中の id を拾わないよう位置で固定する
        const id = line.match(/"work":\{"id":"?([^",}]+)"?/)?.[1]
        const at = line.match(/"collectedAt":"([0-9T:.Z-]+)"/)?.[1]
        if (!id || !at) continue
        const day = at.slice(0, 10)
        if (day > (out.get(id) ?? '')) out.set(id, day)
      }
    }
  } catch {
    // 収集前でも落とさない
  }
  return out
}

/** 記事のスラッグ → 日付（`YYYY-MM-DD`） */
function postDates(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const dir = join(repoRoot(), 'site', 'src', 'content', 'posts')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const raw = readFileSync(join(dir, f), 'utf8')
      const updated = raw.match(/^updatedDate:\s*'?(\d{4}-\d{2}-\d{2})/m)?.[1]
      const pub = raw.match(/^pubDate:\s*'?(\d{4}-\d{2}-\d{2})/m)?.[1]
      const at = updated ?? pub
      if (at) out.set(f.replace(/\.md$/, ''), at)
    }
  } catch {
    // 記事が無くても落とさない
  }
  return out
}

/**
 * 月（`2026-09`）→ その月の記事のうち最も新しい日付。
 *
 * 月別まとめ（`/archive/…`）は**収集では変わらない。記事が増えたときだけ変わる。**
 * 収集日を書くと「毎日更新されている」という嘘になるので、その月の記事から採る。
 *
 * ★ 月は記事の `tags` にある `2026年9月` の形のタグから取る。
 *   読み方の正は src/lib/archive.ts の `monthOf()`。**書式を変えるなら両方直すこと。**
 *   ここは全文を JSON.parse せずに拾うので、クォートで囲まれた完全一致だけを見る
 *   （「2026年9月配信開始」のような期間の呼び名を月と取り違えないため）。
 */
function monthDates(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const dir = join(repoRoot(), 'site', 'src', 'content', 'posts')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const raw = readFileSync(join(dir, f), 'utf8')
      // 下書きはページに出ないので数に入れない（getCollection の絞り込みと合わせる）
      if (/^draft:\s*true\s*$/m.test(raw)) continue
      const tags = raw.match(/^tags:.*$/m)?.[0]
      const tag = tags?.match(/['"](\d{4})年(\d{1,2})月['"]/)
      if (!tag) continue
      const month = `${tag[1]}-${String(Number(tag[2])).padStart(2, '0')}`
      const at =
        raw.match(/^updatedDate:\s*'?(\d{4}-\d{2}-\d{2})/m)?.[1] ??
        raw.match(/^pubDate:\s*'?(\d{4}-\d{2}-\d{2})/m)?.[1]
      if (at && at > (out.get(month) ?? '')) out.set(month, at)
    }
  } catch {
    // 記事が無くても落とさない
  }
  return out
}

let cache: {
  data?: string
  posts: Map<string, string>
  months: Map<string, string>
  works: Map<string, string>
} | null = null

function load(): {
  data?: string
  posts: Map<string, string>
  months: Map<string, string>
  works: Map<string, string>
} {
  if (!cache) {
    cache = { data: dataUpdatedAt(), posts: postDates(), months: monthDates(), works: workDates() }
  }
  return cache
}

/**
 * そのURLの `lastmod`。**分からないページには付けない**（undefined を返す）。
 *
 * @param url `sitemap({ serialize })` が渡す絶対URL
 */
export function lastmodFor(url: string): string | undefined {
  const { data, posts, months, works } = load()
  const path = new URL(url).pathname.replace(/\/$/, '') || '/'

  const post = path.match(/^\/posts\/(.+)$/)
  if (post) return posts.get(post[1]!)

  /*
   * 作品ページ。**1件ずつ、その作品の最終観測日を書く**（上の workDates）。
   * ★ 収集日（`data`）に落とさないこと。落とすと616枚が毎日そろって
   *   「更新した」と名乗る、この変更で直したはずの状態に戻る。
   *   観測が拾えない作品は**書かない**（undefined）。
   */
  const work = path.match(/^\/works\/(.+)$/)
  if (work) return works.get(work[1]!)

  /*
   * 月別まとめ。**収集ではなく記事で決まる**（上の monthDates）。
   *   /archive/2026-09  /archive/2026-09/netflix → その月の最も新しい記事の日付
   *   /archive                                   → 全月のうち最も新しい日付
   */
  if (path === '/archive') return [...months.values()].sort().pop()
  const archive = path.match(/^\/archive\/(\d{4}-\d{2})(?:\/[^/]+)?$/)
  if (archive) return months.get(archive[1]!)

  /*
   * データから組み立てているページ。収集が動けば中身が変わりうる。
   * ★ 固定ページ（/about /privacy /contact /guide）はここに入れない。
   *   本文を手で直したときにしか変わらないので、収集日を書くと嘘になる。
   */
  const dataDriven =
    path === '/' ||
    path === '/stats' ||
    path === '/person' ||
    /^\/(person|leaving|arrivals|calendar|category|service|genre)\//.test(path)
  return dataDriven ? data : undefined
}
