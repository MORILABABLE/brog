/**
 * 「他のサービスで探す」の節を、**記事の表に出ている作品から機械的に組み直す。**
 *
 * ■ 何を直すためのものか（2026-09-13）
 * この節は本文の一部としてLLMが書いていて、**中身が記事ごとにばらばらだった。**
 *
 *     ハリー・ポッター          11作品ぜんぶ
 *     9月のNetflix終了          63作品のうち12だけ
 *     **9月のU-NEXT終了         0。サービスの検索トップへのリンク2本だけ**
 *
 * いちばん困るのは最後で、**サイトで最もCTRの高い記事（22%・2026-09 実測）に、
 * 作品単位の行き先が1つも無い。** 読者は「U-NEXTで終わったあとどこで観るのか」を
 * 知りたくて来ているのに、答えの手前で終わっている。
 *
 * ■ なぜ記事側ではなく build 時に組むのか
 * 記事を作り直すとLLMの実行が要り、**書き直すたびに揃ったり揃わなかったりする。**
 * 表の作品は `rehype-work-links.ts` が既に `<a class="work-link">` にしているので、
 * **その節に出すべき作品は、ビルド時に表から確定できる。**
 * リンクを記事に焼き込まない方針（docs/AFFILIATE.md）とも揃う。
 *
 * ■ Amazon を足す
 * それまでこの節に並ぶのは U-NEXT / Hulu / DMM TV の3社だけで、
 * **1本も成果にならなかった**（U-NEXT・Hulu は未提携、DMM TV は対象外）。
 * 表の中の「他で探す」チップ（`rehype-availability.ts` の `findChips`）は
 * 最初から Amazon を含んでいるので、**同じ構成に揃える**。
 *
 * ★ **並びは `search-links.ts` の定義順のまま、Amazon は最後。**
 *   `findChips` と同じ順で、**紹介料の順に並べ替えない**
 *   （docs/AFFILIATE.md 7節。プライバシーポリシーにも明記してある）。
 * ★ **その作品の行のサービスは出さない。** 「U-NEXTで終了」の行に
 *   U-NEXT の検索を出しても読者の役に立たない（`findChips` と同じ判断）。
 * ★ **「配信中」と言わない。** 出すのは検索リンクだけで、在庫は断定しない
 *   （`search-links.ts` 冒頭。記事側の※注記がその前提を読者に伝えている）。
 *
 * ■ 並び順（astro.config.mjs）
 * `rehypeWorkLinks` のあと（表の作品名が `<a class="work-link">` になっている必要がある）、
 * `rehypeAffiliate` の前（ここで作った `<a>` に tag= と rel= を付けてもらう）。
 */
import { SERVICE_BY_LABEL } from '../src/lib/work-links.ts'
import { amazonVideoLink, otherServiceLinks } from '../src/lib/search-links.ts'
import { topicForSlug } from '../src/lib/series-for-work.ts'
import { postBySlug } from '../src/lib/post-index.ts'

/** Markdown のファイル。slug を取るためだけに使う。 */
interface VFile {
  path?: string
  history?: string[]
}

/** HAST のノード。必要な形だけ（他のプラグインと同じ方針）。 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/**
 * この節の見出し。
 *
 * ⛔ **この節は 2026-09-19 のテンプレ改修で廃止した。**
 *   行き先は表の各行の下（`rehype-availability.ts` の在庫行と「他で探す」チップ）に移り、
 *   新しく書く記事にはこの見出しが出てこない。
 *
 * ★ **それでもこのプラグインを外さないこと。** 公開済みの記事にはまだ節が残っていて、
 *   書き直すまで本文にある。見出しが無ければ**何もしないで通す**ので、
 *   新しい記事に影響は出ない。全記事が新テンプレに移ったら消してよい。
 */
const HEADING = '他のサービスで探す'

/**
 * この節に並べる作品の上限。
 *
 * ★ **転送量が理由ではない。** URLの並びはよく圧縮され、実測で
 *   9月のU-NEXT記事は gzip 20KB → 28KB にしかならなかった（2026-09-13）。
 *   止めたいのは**DOMの量**で、199作品だと `<a>` が1ページに1,092本になる。
 *   スマホでその全部を組み立てさせる価値がこの節には無い。
 *
 * ★ **80 にした理由。** 超えるのは新着記事3本だけ（199 / 166 / 115件）で、
 *   終了系の月次記事は最大でも80件（＝この上限で全作品が載る）。
 *   **終了記事は期限がある**ので1作ずつ次の一手が要るが、
 *   新着記事は「そのサービスに今入った」話で、他社を探す動機がそもそも薄い。
 *   どこで切っても恣意的になるが、**切って困るのが新着記事だけ**になる線を選んだ。
 *
 * ★ 表の総覧は全作品を載せたままなので、**作品が消えるわけではない。**
 */
const MAX_WORKS = 80

const text = (v: string): Node => ({ type: 'text', value: v })

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function hasClass(node: Node, name: string): boolean {
  const cls = node.properties?.className
  return Array.isArray(cls) && cls.includes(name)
}

function find(node: Node, ok: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (ok(node)) out.push(node)
  for (const c of node.children ?? []) find(c, ok, out)
  return out
}

/** 表の1行ぶんの作品。**題名は `work-name`、サービスは「サービス」列の文字から。** */
interface RowWork {
  title: string
  /** その行が扱っているサービスの表示ラベル（`U-NEXT` など）。無いこともある */
  ownLabel?: string
}

/**
 * 記事の表に出ている作品を、**出てきた順**に重複なく集める。
 *
 * ★ 題名は `rehype-work-links.ts` が付けた `<span class="work-name">` から取る。
 *   セルの文字を総当たりで台帳に当てる（`rehype-availability.ts` の `workOf`）
 *   必要はここでは無い。**リンクになっている＝作品だと確定している行**だけを見る。
 *
 * ★ **同じ作品が複数の表に出る。** 月次記事は節ごとの表と全作品の総覧を持つので、
 *   9月のU-NEXT記事では80作品が160行になる。ここで潰さないと同じ行が2本並ぶ。
 */
function worksIn(tree: Node): RowWork[] {
  const seen = new Set<string>()
  const out: RowWork[] = []
  for (const row of find(tree, (n) => n.tagName === 'tr')) {
    const nameNode = find(row, (n) => hasClass(n, 'work-name'))[0]
    if (!nameNode) continue
    const title = textOf(nameNode).trim()
    if (!title || seen.has(title)) continue

    let ownLabel: string | undefined
    for (const cell of row.children ?? []) {
      if (cell.tagName !== 'td' && cell.tagName !== 'th') continue
      const label = textOf(cell).trim()
      if (SERVICE_BY_LABEL.has(label)) {
        ownLabel = label
        break
      }
    }
    seen.add(title)
    out.push({ title, ownLabel })
  }
  return out
}

/** 作品1本ぶんの `<li>`。 */
function lineFor(work: RowWork): Node {
  /*
   * ★ **Amazon は最後**（`findChips` と同じ）。紹介料の順に並べない。
   * ★ その行のサービスは落とす。ラベルで突き合わせるのは、
   *   `search-links.ts` も表の「サービス」列も同じ表示名を使うため。
   */
  const links = [...otherServiceLinks(work.title), amazonVideoLink(work.title)].filter(
    (l) => l.label !== work.ownLabel,
  )
  if (links.length === 0) return { type: 'element', tagName: 'li', children: [] }

  const children: Node[] = [
    {
      type: 'element',
      tagName: 'strong',
      properties: { className: ['find-work'] },
      children: [text(work.title)],
    },
  ]
  /*
   * ★ **区切り文字を入れない**（2026-09-14）。チップ（枠つきのピル）にしたので、
   *   間隔は CSS の `gap` が持つ。`/` を挟むと枠と枠の間に記号が浮く。
   */
  links.forEach((l) => {
    children.push({
      type: 'element',
      tagName: 'a',
      /*
       * ★ 枠名は `find`（`rehype-affiliate.ts` の `slotOf`）。
       *   表の中の「他で探す」チップと**同じ枠に数える**。押された意味が同じで、
       *   どちらも「答えが出せなかったときの逃げ先」だから
       *   （docs/FUNNEL.md 7-5 の枠分けの考え方）。
       */
      /*
       * ★ **`find-link` の名前を変えないこと。** `rehype-affiliate.ts` の
       *   `slotOf()` がこのクラス名で枠を決めている。見た目のために
       *   別名に替えると、**計測だけ黙って `body` 枠に落ちる。**
       */
      properties: { href: l.url, className: ['find-link'] },
      children: [text(l.label)],
    })
  })
  return { type: 'element', tagName: 'li', children }
}

/** Markdown のファイル名から slug を取る（`rehype-next-step.ts` と同じ取り方） */
function slugOf(file: VFile): string {
  const path = file.path ?? file.history?.[0] ?? ''
  return path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') ?? ''
}

/**
 * 節の見出しを**読者の問いの形**に組み直す（2026-09-15）。
 *
 * ■ なぜ変えるのか（実測・GSC 28日）
 * `/posts/harry-potter` が取れている語は「ハリーポッター 配信終了」**7.2位**だけで、
 * **「ハリーポッター 配信」は47位・「ハリーポッター サブスク」は101位**だった。
 * 需要のほうは消えていない（Wikipedia「ハリー・ポッターシリーズ」は
 * 1日1,400〜1,800回で横ばい）。取れていないのは**終了という出来事ではない、定常の語**。
 *
 * 記事の `<title>` と h1 は `templates/naming.md` の決まりがあって動かせない
 * （軸を1つだけ名乗る・略称を使わない）。**見出しなら決まりに触れずに足せる。**
 *
 *   終了予定・終了済みの記事 … 「「ハリー・ポッター」シリーズは終了後どこで観られるか」
 *   それ以外               … 「「ガンダム」シリーズはどこで観られるか」
 *   主題が控えに無い記事    … 「終了後、どこで観られるか」
 *
 * ★ **断定にしない。** 問いの形にしてあるのは、この節が出すのが検索リンクだけで、
 *   **在庫を断定しない**ため（`search-links.ts` 冒頭）。すぐ下の固定文言が
 *   「確認する場合はこちらから検索できます」と続けて、答えの範囲を読者に渡す。
 */
function headingText(slug: string): string {
  const topic = slug ? topicForSlug(slug) : undefined
  const category = slug ? postBySlug(slug)?.category : undefined
  const ended = category === 'leaving' || category === 'ended'
  if (!topic) return ended ? '終了後、どこで観られるか' : 'ほかのサービスで観られるか'
  return ended ? `${topic}は終了後どこで観られるか` : `${topic}はどこで観られるか`
}

export function rehypeFindLinks() {
  return (tree: Node, file: VFile): void => {
    try {
      const body = tree.children ?? []
      const at = body.findIndex(
        (n) => n.tagName === 'h2' && textOf(n).trim() === HEADING,
      )
      if (at < 0) return

      /*
       * ★ **見つけるのは固定文言、出すのは読者の問い**（上の `headingText`）。
       *   探すほうを変えると、記事側の `templates/fixed-phrases.md` と食い違って
       *   節そのものが見つからなくなる。**書き換えるのは中身だけ。**
       */
      const h2 = body[at]
      if (h2) h2.children = [text(headingText(slugOf(file)))]

      // 次の見出しまでがこの節。無ければ本文の終わりまで。
      let end = body.findIndex((n, i) => i > at && n.tagName === 'h2')
      if (end < 0) end = body.length

      /*
       * ★ **表の中で既に「他で探す」を渡した作品は、ここで繰り返さない**（2026-09-13）。
       *   `rehype-availability.ts` が行の下にチップを出した作品は、
       *   読者はもうその場で次の一手を受け取っている。ここにも並べると
       *   **同じ作品への同じリンクが1ページに2組**でき、リンクだけが増える。
       *
       *   ★ 突き合わせは**URLそのもの**でやる。どちらも `search-links.ts` の
       *     同じ関数で組んでいて、`tag=` が付くのは後段（`rehype-affiliate.ts`）なので、
       *     この時点では文字列が完全に一致する。題名の書式に依存しない。
       */
      const already = new Set(
        find(tree, (n) => hasClass(n, 'avail-find-link')).map((n) =>
          String(n.properties?.href ?? ''),
        ),
      )
      const works = worksIn(tree).filter((w) => !already.has(amazonVideoLink(w.title).url))
      if (works.length === 0) return

      /*
       * ★ **節の中の箇条書きは作り直す**（残して足さない）。
       *   LLM が書いた分を残すと、同じ作品が2回並ぶか、
       *   作品単位の行とサービス検索トップへの行が混ざる（実際にそうなっていた）。
       *   ※で始まる注記の段落には触らない — あれが「断定していない」ことの
       *   前提を読者に伝えている部分で、ここで消してはいけない。
       */
      const kept = body.slice(at, end).filter((n) => n.tagName !== 'ul' && n.tagName !== 'ol')
      const list: Node = {
        type: 'element',
        tagName: 'ul',
        properties: { className: ['find-list'] },
        children: works.slice(0, MAX_WORKS).map(lineFor),
      }

      /*
       * ★ **注記はリンクの後ろに置く**（2026-09-14・運用者の指定）。
       *
       *   この節に来た読者は「で、どこで探せるのか」を知りたい。
       *   ※で始まる2つの注記（把握している5サービス／掲載範囲の断り）は
       *   **読んだうえで効く前提**であって、**答えの前に立ちはだかる文章ではない。**
       *   先に置くと、作品80本ぶんのリンクが注記2段落の下に沈む。
       *
       *   ★ **注記は消さない。** 掲載範囲の断りは
       *     「この記事は抜けている」と読まれないための線で、
       *     この記事タイプの信用そのもの（`templates/series.md` 4節）。
       *   ★ **記事のMarkdownは書き換えない。** 並べ替えるのはここ（ビルド時）だけなので、
       *     既存の記事も次のビルドから新しい並びになる。
       */
      const heading = kept[0]
      const notes = kept.slice(1)
      tree.children = [...body.slice(0, at), heading, list, ...notes, ...body.slice(end)].filter(
        (n): n is Node => n !== undefined,
      )
    } catch {
      // 節の形が想定と違っても記事は出す。**リンクが増えないだけ。**
    }
  }
}
