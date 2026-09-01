/**
 * 公開済み記事と、手元の素材の突き合わせ。**記事を書いたあとの取りこぼしを見つける。**
 *
 * ■ なぜ要るか（2026-08-31 追加）
 * 品質ゲート（`verify.ts` の「取りこぼしチェック」）が見ているのは
 * **その1回の生成**だけで、「選んだ素材が、いま書いた本文に出ているか」を確かめている。
 * 記事を公開したあとに収集した素材は、そもそもその検査を通らない。
 *
 * 実際に起きた事故（2026-08）:
 *
 *   21:28  `2026-08-leaving`（Netflix・Prime Video 32本）を公開
 *   21:53  同じ日の `collect` が Netflix の 8月31日終了 **61本**を取り込む
 *          （うち29本が「名探偵コナン」劇場版）
 *   → 記事は書き直されず、61本は**どの月次記事にも載らないまま8月31日を迎えた**
 *
 * `--list` は「未作成 61件」と出していたが、同じ月・同じカテゴリの記事が
 * **別のスラッグで**既にあったため（サービス別に分ける前の `2026-08-leaving`）、
 * 運用者からは「もう書いた月」に見えていた。件数だけでは締切も分からない。
 *
 * ここが見るのは**公開済みの記事の本文**なので、
 *   - 記事を書いたあとに増えた素材
 *   - 記事タイプを分割してスラッグが変わり、宙に浮いた素材
 *   - Prime Video のように終了の11日前にしか出ない素材（HANDOVER.md の落とし穴）
 * のどれも同じ1つの網に掛かる。
 *
 * ■ 月をまたぐと網から落ちる（2026-09-01 に見つかった）
 * この網は**対象月の素材にしか掛からない**。月末に配信が始まった作品は
 * 翌月の収集で入るので、
 *   - 先月の記事はもう書き終えている（dataAsOf がその前）
 *   - 今月の記事は `isTargetMonth` が先月開始を外す
 * の両方に当たり、**どの記事にも載らないまま一覧からも消える。**
 *
 *   8/31 12:35  「機動戦士ガンダム 閃光のハサウェイ キルケーの魔女」が Prime Video で配信開始
 *   9/01 08:09  収集が拾う（8月の記事は 8/21・8/26 に公開済み）
 *   → 8月の記事にも9月の記事にも載らない。同じ形の取りこぼしが**29件**あった
 *
 * そこで `--list` は、対象月を明示しないかぎり**前月ぶんも別枠で数える**
 * （`write.ts` の `coverageGapsFor`）。締切のあるカテゴリ（leaving）は
 * 期限そのものが過ぎているので出さない。
 *
 * ■ この層が何を知らないか
 * **日本語の題名の付き方を知らない。** 同じ作品がサービスごとに違う題で入る
 * （`名探偵コナン ベイカー街の亡霊` / `劇場版 名探偵コナン ベイカー街（ストリート）の亡霊`）
 * ことは記事タイプだけが知っているので、判定は `ArticleType.mentions` を渡してもらう
 * （`verify.ts` の取りこぼしチェックと同じ関数を使う）。
 *
 * ■ サイトの常設ページは「載っている」と数えない
 * `/leaving/<サービス>` は `data/events` を直接読むので、記事に無い作品もそこには出る。
 * つまり**常設ページを根拠にすると取りこぼしが永久に0件になる**。
 * ここで数えるのは記事だけ。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeEvent } from '../sources/types.ts'

/** 公開済み記事1本ぶん。突き合わせに使うのは本文とカテゴリだけ。 */
export interface PublishedPost {
  slug: string
  /** frontmatter の `category`。取れなければ空文字 */
  category: string
  /** frontmatter の `tags`。記事タイプを見分ける唯一の手がかり（`series-candidates.ts`） */
  tags: string[]
  /** frontmatter を除いた本文 */
  body: string
  /** 下書き（`draft: true`）はまだ読者に届いていないので、載っていると数えない */
  draft: boolean
}

/**
 * その作品が本文に出ているか、の既定の判定。
 *
 * ★ `verify.ts` の取りこぼしチェックと**同じ既定**にしてあること。
 *   片方だけ変えると、公開を止める検査と公開後の検査が別々の答えを出す。
 */
export function mentionsByTitle(e: ChangeEvent, body: string): boolean {
  return body.includes(e.work.localizedTitle ?? e.work.title)
}

/** 記事タイプが差し替えられる判定（`ArticleType.mentions` と同じ形） */
export type MentionsFn = (item: ChangeEvent, body: string, items: ChangeEvent[]) => boolean

/**
 * 公開済み記事を読む。読めないときは空で返す（一覧表示を止めるほどのことではない）。
 */
export async function readPublishedPosts(dir: string): Promise<PublishedPost[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }

  const out: PublishedPost[] = []
  for (const f of files) {
    const raw = await readFile(join(dir, f), 'utf8').catch(() => '')
    if (!raw) continue
    // frontmatter は先頭の `---` から次の `---` まで。無ければ全部を本文として扱う。
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    const front = m?.[1] ?? ''
    out.push({
      slug: f.replace(/\.md$/, ''),
      category: front.match(/^category:\s*'([^']*)'/m)?.[1] ?? '',
      /*
       * `tags: ['U-NEXT', 'Netflix', '配信終了', 'シリーズ']` の1行から中身だけ取る。
       * ★ frontmatter を YAML として読まないのは、この層が
       *   「本文と突き合わせる」だけのために存在しているため（依存を増やさない）。
       *   1行で書かれていない frontmatter は空配列になる。**その場合に困るのは
       *   「もう書いた」の判定だけ**で、候補が1つ余計に出るほうへ倒れる。
       */
      tags: (front.match(/^tags:\s*\[([^\]]*)\]/m)?.[1] ?? '')
        .split(',')
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
      body: m?.[2] ?? raw,
      draft: /^draft:\s*true\s*$/m.test(front),
    })
  }
  return out
}

export interface CoverageGap {
  /** どの記事にも出ていない素材 */
  missing: ChangeEvent[]
  /** そのうち最も近い日付（ISO）。日付を持たない素材しか無ければ undefined */
  nearest?: string
}

/**
 * 素材のうち、公開済み記事のどこにも出ていないものを返す。
 *
 * @param items    記事タイプの `select()` が選んだ素材
 * @param posts    公開済み記事（`readPublishedPosts`）
 * @param category この素材を扱う記事のカテゴリ。**同じカテゴリの記事だけを見る。**
 *   配信開始の記事に名前が出ている作品を「終了予定も載っている」と数えないため。
 * @param mentions 記事タイプの判定（未実装なら `mentionsByTitle`）
 */
export function coverageGap(
  items: ChangeEvent[],
  posts: PublishedPost[],
  category: string,
  mentions: MentionsFn = mentionsByTitle,
): CoverageGap {
  const bodies = posts.filter((p) => !p.draft && p.category === category).map((p) => p.body)
  const missing = items.filter((e) => !bodies.some((b) => mentions(e, b, items)))
  const nearest = missing
    .map((e) => e.at)
    .filter((at): at is string => Boolean(at))
    .sort()[0]
  return { missing, nearest }
}
