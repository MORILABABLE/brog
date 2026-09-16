/**
 * 記事の表に「では、どこで観られるか」の行を足す rehype プラグイン。
 *
 * ■ なぜ表なのか（文章ではなく）
 * 読者の問いは「いつ終わるか」ではなく**「では、どこで観るのか」**。
 * 文章で答えても届かない — **実測でスクロール90%到達は22%**（docs/FUNNEL.md 5-3）。
 * 表は本文の最初の1画面に入るので、**そこに答えを置く**。
 *
 * ■ なぜ「列」ではなく「行」なのか（**一度列で作って、作り直した**）
 * サービスごとの列（Netflix ○ / Prime Video ○ …）を先に実装したが、
 * **スマホで収まらなかった。** 375px 幅の実測（playwright）で
 *
 *     表の内容 407px / 表示できる幅 336px  → 右端の列が画面外
 *
 * となり、**横スクロールしないと見えない ＝ 表に入れた意味が消える**。
 * 行にすれば幅を食わない。しかも**サービス名をそのまま書ける**ので、
 * 記号だけの列と違って凡例を読まなくても意味が通じる。
 *
 *     | 終了日  | 作品                      | 評価   |
 *     | 9月30日 | ハリー・ポッターと賢者の石 | 77/100 |
 *     |   Netflix ○　Amazon Prime Video ○　Apple TV+ △   |  ← 足す行
 *
 * ■ 何を根拠にするか
 * `data/availability.json`（`npm run availability` が書く在庫）。
 * **変化ログ（`/changes`）ではない。** 根拠が違うので台帳も別
 * （`pipeline/core/availability.ts` の冒頭）。
 *
 * ■ 実行順（astro.config.mjs）
 *   rehypeWorkLinks → **rehypeAvailability** → rehypeAffiliate
 *   - 前段が作品名を `<a>` にしたあとに読む（題名は `textOf` でそのまま取れる）
 *   - 後段が、ここで作った `<a>` に tag= と rel="sponsored" を付ける
 *   **どちらを逆にしても静かに壊れる。**
 *
 * ■ 絶対に守ること
 *   - **その行が扱っているサービスも含めて出す**（2026-09-15・運用者の指定）。
 *     以前は外していたが、**記事が主題にしているサービスの配信状況が表に出ない**
 *     という逆の穴が開いていた（「Prime Videoで見放題配信中」の記事の行が
 *     「× Netflix × Disney+ △ Apple TV+」だけになり、ラベルまで赤い「取り扱いなし」になる）。
 *     終わるのか観られるのかは**状態列が言っている**ので、印は在庫台帳のまま出す。
 *   - **4社ぶんを ○ △ × で揃えて全部出す。**
 *     ×を省くと「調べたうえで無い」と「調べていない」の区別が付かない
 *   - **台帳に無い作品は — （未確認）。× にしない。**
 *     行そのものを出さないと、読者には「表示されていない」としか見えない
 *   - **Hulu / DMM TV を出さない。** 在庫データを持っていない
 *     （docs/CROSS-SERVICE.md 9-3）。`SERVICES` に入れないことで担保している
 *   - **U-NEXT は ○ だけ出す**（2026-09-16 に方針が変わった）。
 *     `npm run unext:catalog` が**歩き終えたジャンル**については在庫を持つように
 *     なったため（docs/OWN-LEDGER.md 6-3）。ただし歩いていないジャンルの作品は
 *     あっても引けないので、**× も —（未確認）も出さない。**
 *     規律は `src/lib/unext-stock.ts` と、下の `UNEXT_SERVICE` にある
 *   - **並びを紹介料の高い順にしない**（docs/AFFILIATE.md 7節。ポリシーにも明記）
 *
 * ■ 落ちないこと
 * 台帳が空でも、作品が引けなくても、**何もしないで通す**。
 * 在庫を取っていない記事は今までどおりの表で出る。
 *
 * ■ ★ 手元では反映されない（落とし穴）
 * **記事の描画結果がキャッシュされる。** `.md` が変わらないかぎり
 * 再描画されないので、**このファイルを直しても、`data/availability.json` を
 * 更新しても、手元の `npm run dev` / `npm run build` には出ない。**
 *
 *   cd site && npm run dev:fresh      （= キャッシュを消してから dev）
 *   cd site && npm run build:fresh
 *
 * 2026-09-06 に実際に踏んだ。**新しく起動した dev だけが古い表を出し、
 * 前日から動いていた dev のほうが正しい表を出す**、という形で現れた
 * （動いている dev は HMR で作り直されるが、起動時はキャッシュを読むため）。
 * plugins/rehype-work-links.ts の冒頭にも同じ注意書きがある。
 *
 * Cloudflare のビルドは毎回まっさらなので、**公開されるものは常に最新**。
 */
import {
  workLinkByTitle,
  workIdsForTitle,
  availabilityUrl,
  SERVICE_BY_LABEL,
} from '../src/lib/work-links.ts'
import {
  marksFor,
  ledgerIdsForTitle,
  MARK_SYMBOL,
  MARK_LABEL,
  type Mark,
  type WorkMarks,
} from '../src/lib/availability.ts'
import { amazonVideoLink, otherServiceLinks } from '../src/lib/search-links.ts'
import { unextStockFor, type UnextStock } from '../src/lib/unext-stock.ts'

/** HAST のノード。必要な形だけ（rehype-work-links と同じ方針）。 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/**
 * 行に出してよいサービスと表示名。**在庫データを持つ4社だけ。**
 * 並びはテーマの定義順で固定（紹介料で並べ替えない）。
 */
const SERVICES: { key: string; label: string }[] = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'prime-video', label: 'Amazon Prime Video' },
  { key: 'disney-plus', label: 'Disney+' },
  { key: 'apple-tv', label: 'Apple TV+' },
]

/**
 * **5社目の U-NEXT**（2026-09-16 追加）。上の4社とは根拠も規律も違うので分けてある。
 *
 * ■ 何が変わったか
 * 冒頭の「絶対に守ること」にあった **「U-NEXT を出さない。在庫データを持っていない」**
 * は、`npm run unext:catalog` が**歩き終えたジャンルについては成り立たなくなった。**
 * 索引の読み方と、そこで守る5つの決まりは `src/lib/unext-stock.ts` にある。
 *
 * ■ ★ 4社と違うところ（混ぜて考えないこと）
 *
 *   1. **○ しか出ない。** × も △ も —（未確認）も出さない。
 *      歩いていないジャンルの作品は「あっても引けない」ので、
 *      **不在を言えるだけの根拠が無い**（`unext-stock.ts` 冒頭の 1・2）。
 *      4社は `?? 'none'` で × に落ちるが、**ここを同じにしないこと。**
 *   2. **ポイント作品は ○ にしない**（ガイドライン【4】）。索引側で落としている。
 *   3. **並びは定義順のいちばん最後**（`i` に `SERVICES.length` を渡す）。
 *      印の強さで先に来ることはあるが、それは読者の行動で決まる順であって
 *      紹介料の順ではない（docs/AFFILIATE.md 7節）。
 *
 * ■ ★ 出すのは記事だけ
 * 作品ページ・常設ページには出さない（docs/GROWTH.md 2-3・2026-09-16 に運用者へ確認）。
 * このプラグインは記事の本文しか通らないので、**ここに置くこと自体が担保**になっている。
 */
const UNEXT_SERVICE = { key: 'u-next', label: 'U-NEXT' }

/** ○ の送り先。**afb のLPではなく作品名の検索**（`findChips` と同じ考え方）。 */
function unextSearchUrl(title: string): string | undefined {
  return otherServiceLinks(title).find((l) => l.label === 'U-NEXT')?.url
}

const text = (v: string): Node => ({ type: 'text', value: v })

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function cellsOf(row: Node): Node[] {
  return (row.children ?? []).filter((c) => c.tagName === 'td' || c.tagName === 'th')
}

/**
 * その行の作品IDと、**その行が扱っているサービス**。
 *
 * ★ サービスも返すのは、**送り先を決めるため**（`workLinkByTitle` の第2引数と、
 *   「他で探す」のリンクから自社を外す `findChips`）。
 *   ○ △ × の印からは外さない — 記事が扱う社こそ読者が見たい列だから
 *   （2026-09-15 変更。冒頭の「絶対に守ること」）。
 */
function workOf(row: Node): { ids: string[]; title: string; service?: string } | undefined {
  let service: string | undefined
  for (const cell of cellsOf(row)) {
    const hit = SERVICE_BY_LABEL.get(textOf(cell).trim())
    if (hit) {
      service = hit
      break
    }
  }
  for (const cell of cellsOf(row)) {
    const title = textOf(cell).trim()
    if (!title || SERVICE_BY_LABEL.has(title)) continue
    const work = workLinkByTitle(title, service)
    if (!work) {
      /*
       * ★ **変化ログに無い作品は、在庫台帳から引く**（2026-09-10 追加）。
       *
       *   `work-links.ts` の索引は `data/events` だけから作られているので、
       *   **在庫から採用した作品（`availability -- --adopt`）は1件も引けない。**
       *   そこで諦めると、その行だけ印が出ずに**不具合に見える**
       *   （実測: クレヨンしんちゃんは32行中26行、仮面ライダーは15行中10行）。
       *
       * ★ 引き当ては**題名の完全一致だけ**（`ledgerIdsForTitle`）。
       *   当たらなければ今までどおり次のセルへ送る。
       * ★ ここで返すのは**印のためのID**であって、送り先ではない。
       *   作品ページへのリンクは `rehype-work-links.ts` の担当で、
       *   あちらは変化ログしか見ない（作品ページが無い作品へ飛ばさないため）。
       */
      const fromLedger = ledgerIdsForTitle(title)
      if (fromLedger.length === 0) continue
      return { ids: fromLedger, title, service }
    }
    /*
     * ★ **IDを1つに決めない。**
     *   同じ映画が配信元ごとに別のIDで台帳に入っている（`workIdsForTitle` の説明）。
     *   U-NEXT の題で引くと SID… が返り、在庫台帳には無いので**印が出ない。**
     *   読者からは「調べたうえで取り扱いなし（×）」と区別が付かず、不具合に見える。
     *
     * ★ **在庫台帳のIDも必ず混ぜる**（2026-09-13）。
     *   上の `if (!work)` は「変化ログに1件も無い作品」の受け皿で、
     *   **変化ログに当たった作品は台帳を見ないまま返していた。**
     *   U-NEXT の記事はここに入る — 変化ログには SID… があるので `work` は取れるが、
     *   台帳（在庫API側）にあるのは同じ作品の**数値ID**で、混ぜないと永久に届かない。
     *   すぐ上の注意書きが言っている穴が、まさにこの経路で開いたままだった。
     *
     *   ★ **候補を増やすだけで、印を選ぶのは `marksOf`。**
     *     題名が同じ別作品を巻き込んだ場合は印が割れて `undefined` になり、
     *     **嘘の印を出すのではなく黙る**（`marksOf` の注意書き）。
     */
    const ids = [...workIdsForTitle(title), ...ledgerIdsForTitle(title)]
    const uniq = [...new Set(ids.includes(work.workId) ? ids : [work.workId, ...ids])]
    // ★ 題名も返す。**目視で否認した見放題を落とす**のに要る（`marksOf`）。
    return { ids: uniq, title, service }
  }
  return undefined
}

/**
 * 候補のIDから在庫の印を1つ選ぶ。
 *
 * ★ **当たりが割れたら出さない。** 表記ゆれを潰した突き合わせ（`workIdsForTitle`）は
 *   別作品を巻き込みうる。**違う印が返ってきたということは、当てた相手が違う**
 *   ということなので、どちらかを選ばずに黙る（行が出ないだけ）。
 *   嘘の印を出すより、印が無いほうがましという判断。
 */
function marksOf(ids: string[], title: string): WorkMarks | undefined {
  /*
   * ★ **印が割れたら、サービスごとに強いほうを採る**（2026-09-15 変更）。
   *
   *   それまでは「1つでも食い違ったら `undefined`（＝行ごと出さない）」にしていた。
   *   別作品を巻き込んだときに嘘の印を出さないための安全策だったが、
   *   **同じ題名の別の版**で日常的に割れることが分かった。
   *
   *     実測（2026-09-15・「ガンダム」）
   *       機動戦士ガンダム  id 10206（テレビ版）  netflix: 見放題
   *                         id 61679（劇場版I）   netflix: 見放題 ＋ apple-tv: 購入
   *       → 印が食い違うので黙り、**その行だけ「— 未確認」**になっていた
   *
   *   読者の問いは「**この題名の作品はどこで観られるか**」なので、
   *   版が違っても答えは足し合わせてよい。見放題 > レンタル・購入 > 取り扱いなし の順に強い。
   *
   * ★ **題名を渡す。** 否認の一覧（`data/availability-ng.json`）は
   *   作品IDだけでなく題名の部分一致でも当たる。**シリーズまるごと**を
   *   否認した場合、あとから台帳に入った別IDの作品もここで落ちる
   *   （`src/lib/availability-ng.ts`）。
   * ★ 否認された「—（未確認）」は**いちばん弱い**ので、他の版が印を持っていれば
   *   そちらが残る。逆に全部が未確認なら未確認のまま（嘘を足さない）。
   */
  const RANK: Record<Mark, number> = { subscription: 3, paid: 2, none: 1, unknown: 0 }
  const marks = new Map<string, Mark>()
  const links = new Map<string, string>()
  let fetchedAt: Date | undefined
  for (const id of ids) {
    const m = marksFor(id, [title])
    if (!m) continue
    for (const [svc, mark] of m.marks) {
      const cur = marks.get(svc)
      if (cur !== undefined && RANK[cur] >= RANK[mark]) continue
      marks.set(svc, mark)
      const link = m.links.get(svc)
      // ★ リンクは**採った印と同じ版のもの**にする。混ぜると別の版へ送ってしまう
      if (link) links.set(svc, link)
      else links.delete(svc)
    }
    // ★ 「◯月◯日時点」は**いちばん古い観測**に合わせる（言い過ぎない）
    if (!fetchedAt || m.fetchedAt < fetchedAt) fetchedAt = m.fetchedAt
  }
  return fetchedAt ? { marks, links, fetchedAt } : undefined
}

/** 見出し名で列を探して落とす（中身は見ない）。 */
function dropColumn(headRow: Node, bodyRows: Node[], head: string): void {
  const idx = cellsOf(headRow).findIndex((c) => textOf(c).trim() === head)
  if (idx < 0) return
  for (const row of [headRow, ...bodyRows]) {
    const cell = cellsOf(row)[idx]
    if (cell) row.children = (row.children ?? []).filter((c) => c !== cell)
  }
}

/**
 * 見出し名で列を探し、**全行の中身が同じなら列ごと落とす。**
 * 1行でも違えば何もしない。
 */
function dropConstantColumn(headRow: Node, bodyRows: Node[], head: string): void {
  const idx = cellsOf(headRow).findIndex((c) => textOf(c).trim() === head)
  if (idx < 0 || bodyRows.length < 2) return
  const values = bodyRows.map((r) => {
    const cell = cellsOf(r)[idx]
    return cell ? textOf(cell).trim() : ''
  })
  if (values.some((v) => !v || v !== values[0])) return
  dropColumn(headRow, bodyRows, head)
}

/**
 * 行の頭のラベル（「配信中」）の状態。**その行に並ぶ印だけで機械的に決まる。**
 *
 *     live     ○ が1つでもある     いま見放題で観られる先がある
 *     paid     ○ が無く △ がある   金を払えば観られる（見放題は無い）
 *     none     × だけ              この4社では取り扱いが無い
 *     unknown  印が無い（—）        調べていない
 *
 * ★ **色は言い換えでしかない。** 状態はラベルの文字（`LABEL_TEXT`）と
 *   同じ行に並ぶ ○ △ × が言っているので、色が届かない読者
 *   （色覚特性・印刷・モノクロ）でも意味は1つも落ちない。
 *   これは global.css の「色だけに意味を持たせないこと」の決まりそのもの。
 * ★ **判定をここ以外に置かないこと。** 記事は作成も書き直しも同じ
 *   ビルド（この rehype プラグイン）を通るので、ここ1か所で全記事に効く。
 */
type LabelState = 'live' | 'paid' | 'none' | 'unknown'

function labelStateOf(marks: Mark[]): LabelState {
  if (marks.includes('subscription')) return 'live'
  if (marks.includes('paid')) return 'paid'
  if (marks.length > 0 && marks.every((m) => m === 'none')) return 'none'
  return 'unknown'
}

/** 状態ごとの補足。**色は読み上げに乗らない**ので、言葉でも渡す。 */
const LABEL_TITLE: Record<LabelState, string> = {
  live: '見放題で観られるサービスがあります',
  paid: 'レンタル・購入なら観られます（見放題はありません）',
  none: 'この4サービスでは取り扱いがありません',
  unknown: '配信状況を取得できていません',
}

/**
 * ラベルの文字。**状態ごとに変える**（2026-09-09・運用者の判断）。
 *
 * ★ **全部を「配信中」にしてはいけない。** 一度そうしていて、
 *   ×だけの行が**「赤い枠の『配信中』」**になった。色は正しくても、
 *   **文字だけ読むと逆の意味に取れる。**
 *   色は補助（下の `labelStateOf` の注意書き）なので、
 *   **文字のほうが単体で正しくないといけない。**
 *
 * ★ 「配信中」と書けるのは**在庫レスポンスを根拠にしている面だけ**
 *   （下の `availLabel` の説明）。ここを他の記事へ広げないこと。
 */
const LABEL_TEXT: Record<LabelState, string> = {
  live: '配信中',
  paid: '有料で配信中',
  none: '取り扱いなし',
  /*
   * ★ 「未確認」にしない。**右隣のチップが既に「— 未確認」**なので、
   *   同じ言葉が2つ並ぶ。ここは**その行が何の行か**を言うだけにする。
   */
  unknown: '配信状況',
}

/**
 * 行の頭のラベル。**この行が何なのかを1語で言う。**
 * 記号だけの行が表に紛れると、読者は何の行か分からないまま飛ばす。
 *
 * ★ **「配信中」と書いてよい面。** `works.ts` 冒頭の
 *   「配信中と書かない」は**変化ログ（/changes）を根拠にするな**という意味で、
 *   この行は**在庫レスポンス**を根拠にしている（docs/CROSS-SERVICE.md 4-2）。
 *   根拠が違うので射程外。**ただし取得時点を凡例に必ず出すこと**が条件。
 *
 * ★ **枠と色は CSS が `data-state` を見て付ける**（global.css `.avail-label`）。
 *   ここは状態を宣言するだけで、色の値は持たない。
 *   色を足す・変えるときは global.css 側だけを直すこと。
 */
function availLabel(state: LabelState): Node {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['avail-label'],
      'data-state': state,
      title: LABEL_TITLE[state],
    },
    /*
     * ★ **箱は内側の `span` が描く。** 外側は並びのための入れ物。
     *   スマホでは外側だけが1行を占める（global.css のメディアクエリ）ので、
     *   1枚にすると**画面幅いっぱいの色帯**になってしまう。
     */
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['avail-label-box'] },
        children: [text(LABEL_TEXT[state])],
      },
    ],
  }
}

/**
 * 「他で探す」。**その行に押せる先が1つも無いときだけ**足す（2026-09-12 追加）。
 *
 * ■ なぜ足すのか
 * ×だけの行（「取り扱いなし」）と「— 未確認」の行は、
 * **行の中にリンクが1本も無い。** 実測で公開中の記事の在庫行 260行のうち
 * **100行がこれ**で、読者はそこで行き止まりになる。
 * 在庫を持つ4社に無いことは分かっているのに、**次の一手を渡していない。**
 *
 * ■ なぜ検索リンクなのか（「配信中」と書かない）
 * U-NEXT / Hulu / DMM TV の在庫は取れない（docs/CROSS-SERVICE.md 9-3）。
 * **だから断定せず、検索へ渡すだけにする。** 誤情報にならず、読者は1クリックで確かめられる。
 * 送り先の組み立ては `src/lib/search-links.ts` の1か所
 * （常設ページの表 `components/WorkTable.astro` と**同じ関数・同じ並び**）。
 *
 * ■ 守っていること
 *   - **並びは紹介料の順にしない**（docs/AFFILIATE.md 7節）。`search-links.ts` の定義順のまま
 *   - **その行のサービスは出さない。** 「U-NEXTで終了予定」の行に
 *     「U-NEXTで探す」を出すと、行の主題と矛盾する（4社の印と同じ決まり）
 *   - **Amazon は行のサービスが Prime Video でも残す。** あちらは見放題の話で、
 *     こちらは**レンタル・購入**という別の答えだから（`search-links.ts` の説明）
 *   - `tag=` と rel は後段（`rehype-affiliate.ts`）が付ける。ここでは組まない
 *
 * ★ 枠名は `find`。**作品ページの「他のサービスで探す」と同じ枠**にしてある
 *   （docs/FUNNEL.md 7-5）。○ / △ の `avail` 枠とは混ぜない —
 *   あちらは「表に答えを入れた施策が効いたか」の唯一の証拠なので。
 *
 * ★ 見た目は**印のチップと同じ枠つきのピル**（`global.css` の `.avail-find-link`）。
 *   **記号（○ △ ×）は付けない。** 付けると「印」になり、
 *   **調べていない先を調べたことにしてしまう。**
 */
function findChips(title: string, own: string | undefined): Node[] {
  const links = [...otherServiceLinks(title), amazonVideoLink(title)].filter(
    (l) => !(own === 'u-next' && l.label === 'U-NEXT'),
  )
  const items: Node[] = [
    {
      type: 'element',
      tagName: 'span',
      properties: { className: ['avail-find-label'] },
      children: [text('他で探す')],
    },
  ]
  for (const l of links) {
    /*
     * ★ **「Amazon（レンタル・購入）」を「Amazon」に縮めない**（2026-09-12）。
     *   同じ行には **`× Amazon Prime Video`** が並んでいる。そこへ青い「Amazon」を
     *   出すと、**取り扱いなしと言いながら押せる**という矛盾に読める。
     *   「レンタル・購入」まで書いて初めて、**見放題ではない別の答え**だと分かる。
     *   常設ページの表（`WorkTable.astro`）も同じ文字で出している。
     */
    items.push({
      type: 'element',
      tagName: 'a',
      properties: {
        href: l.url,
        className: ['avail-find-link'],
        title: `${l.label}で「${title}」を検索する（配信の有無は確かめていません）`,
      },
      children: [text(l.label)],
    })
  }
  return [
    {
      type: 'element',
      tagName: 'span',
      properties: { className: ['avail-find'] },
      children: items,
    },
  ]
}

/**
 * U-NEXT の ○ を1枚だけ描く（4社の印が1つも引けなかった行で使う）。
 *
 * ★ **見た目は4社の印とまったく同じ**（`avail-item` / `data-mark`）。
 *   根拠が違うことは凡例の「◯月◯日時点」が引き受けるので、
 *   ここで別の見た目を作らないこと。読者にとっては同じ「○ 見放題」でよい。
 */
function unextChip(title: string, _stock: UnextStock): Node {
  const url = unextSearchUrl(title)
  const inner: Node[] = [
    {
      type: 'element',
      tagName: 'span',
      properties: { className: ['avail-mark'], 'aria-hidden': 'true' },
      children: [text(MARK_SYMBOL.subscription)],
    },
    text(UNEXT_SERVICE.label),
  ]
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['avail-item'],
      'data-mark': 'subscription',
      title: `${UNEXT_SERVICE.label}（${MARK_LABEL.subscription}）`,
    },
    children: [
      url
        ? {
            type: 'element',
            tagName: 'a',
            properties: { href: url, className: ['avail-link'] },
            children: inner,
          }
        : { type: 'element', tagName: 'span', properties: {}, children: inner },
    ],
  }
}

/**
 * 1作品ぶんの「どこで観られるか」の行。**元の行の直下に足す。**
 *
 * ★ `colspan` は列を落としたあとの列数に合わせること。ずれると行が崩れる。
 * ★ **観られる先だけを出す。** ×（取り扱いなし）は並べない。
 */
function availRow(
  marks: WorkMarks | undefined,
  colspan: number,
  own: string | undefined,
  title: string,
  unext: UnextStock | undefined,
): Node {
  /*
   * ★ **台帳に無い作品は、印を4つ並べずに「— 未確認」1つで済ませる。**
   *
   *   ここで `— Netflix　— Amazon Prime Video　…` と4つ並べても、
   *   **読者が得るものが1つも無い**（どこも「分からない」としか言っていない）。
   *   長い行が並ぶぶん、印のある行のほうが読みにくくなる。
   *
   *   それでも**行そのものは出す。** 行が無いと、読者には
   *   「この作品だけサービス先が表示されていない」＝不具合に見える
   *   （2026-09-06・運用者の指摘）。**分からないことを、分かると同じ形で言う。**
   *
   *   ★ **× にしない。** × は「調べたうえで取り扱いなし」で意味が違う
   *     （src/lib/availability.ts の「絶対に守ること」2）。
   */
  if (!marks) {
    /*
     * ★ **4社が分からなくても、U-NEXT が引けたなら答えはある**（2026-09-16 追加）。
     *
     *   ここへ来る行は、それまで **「— 未確認」＋「他で探す」**だけだった。
     *   U-NEXT の月次記事がまるごとこれで、実測160行すべてが行き止まり
     *   （`findOnlyRow` の説明）。索引が答えを持っているなら、
     *   **「分からない」ではなく答えを出す。**
     *
     *   ★ **4社ぶんの「—」は並べない。** 分からないことに変わりはないが、
     *     答えが1つ出ている行に「—」を4つ足しても読者が得るものは無い
     *     （下の「台帳に無い作品は…」と同じ理屈）。
     *   ★ **「他で探す」も足さない。** ○ が1つでもあるなら答えは行の中にある、
     *     という `findChips` の決まりをそのまま通す。
     */
    if (unext) {
      return availCell(
        [availLabel('live'), unextChip(title, unext)],
        colspan,
      )
    }
    const items: Node[] = [availLabel('unknown')]
    items.push({
      type: 'element',
      tagName: 'span',
      properties: {
        className: ['avail-item'],
        'data-mark': 'unknown',
        title: '配信状況を取得できていない作品です',
      },
      children: [
        {
          type: 'element',
          tagName: 'span',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['avail-mark'], 'aria-hidden': 'true' },
              children: [text(MARK_SYMBOL.unknown)],
            },
            text('未確認'),
          ],
        },
      ],
    })
    /*
     * ★ **「分からない」で終わらせない。** 印が1つも無い行は、
     *   読者にとって行き止まりそのものなので、探せる先を渡す。
     */
    items.push(...findChips(title, own))
    return availCell(items, colspan)
  }

  /*
   * 並び順。**○（見放題）→ △（レンタル・購入）→ ×（取り扱いなし）**。
   * 読者が最初に見たいのは「いま見放題で観られる先」なので、そこを先頭に置く。
   *
   * ★ **同じ印どうしの順は SERVICES の定義順のまま**（機械的な順）。
   *   ここを崩して「収益になる順」に並べ替えないこと。
   *   docs/AFFILIATE.md 7節で「紹介料の高いサービスを優先して掲載しない」と決め、
   *   プライバシーポリシーにも明記してある。
   *   **印での並べ替えは読者の行動で決まる順**なので、その方針には反しない。
   */
  const RANK: Record<Mark, number> = { subscription: 0, paid: 1, none: 2, unknown: 3 }
  /*
   * ★ **その行のサービスも出す**（2026-09-15 変更。それまでは外していた）。
   *
   *   外していた理由は「『Netflixで9月30日に終了』の行に Netflix ○ を出すと、
   *   終わるのか観られるのか読者に判別できない」だった。だが**判別は状態列がしている。**
   *   外すほうの損が大きいと分かったのでやめた。
   *
   *   ✕ 外していたとき
   *       「Amazon Prime Videoで見放題配信中」の記事なのに、
   *       行の印が「× Netflix  × Disney+  △ Apple TV+」だけになり、
   *       **記事が主題にしているサービスの配信状況が表に出ない。**
   *       ラベルまで「取り扱いなし」と赤くなり、**見放題で観られる作品の行が
   *       観られないように見えた。**
   *
   *   ○ いま
   *       「● Amazon Prime Video  × Netflix  × Disney+  △ Apple TV+」
   *       記事が扱う社を含めた4社ぶんが揃い、ラベルも「配信中」になる。
   *
   * ★ 印の根拠は**在庫台帳そのまま**（`marks`）。状態列から作り直さない。
   *   終了予定の行は終了日まで見放題なので ●、終了済みの行は台帳が見放題を
   *   返さなくなるので自然に △ か × に落ちる（2026-09-15・運用者の指定）。
   */
  /*
   * ★ **U-NEXT は5社目として混ぜるが、`?? 'none'` には落とさない**（2026-09-16）。
   *   引けなかったら**行に出さない**（`UNEXT_SERVICE` の説明の 1）。
   *   4社と同じ `.map()` に入れると × が付いてしまうので、足すのは引けたときだけ。
   */
  const shown = [
    ...SERVICES.map((svc, i) => ({
      svc,
      i,
      mark: (marks.marks.get(svc.key) ?? 'none') as Mark,
    })),
    ...(unext
      ? [{ svc: UNEXT_SERVICE, i: SERVICES.length, mark: 'subscription' as Mark }]
      : []),
  ].sort((a, b) => RANK[a.mark] - RANK[b.mark] || a.i - b.i)

  /*
   * ★ ラベルの色は**その行に実際に並ぶ印**から決める（`shown`）。
   *   4社ぶんが揃うようになったので、**読者が見ているものと一致する**。
   */
  const state = labelStateOf(shown.map((s) => s.mark))
  const items: Node[] = [availLabel(state)]

  for (const { svc, mark } of shown) {
    // ★ ×（取り扱いなし）も出す。**4社ぶんを揃えて見せる**ことで、
    //   「調べたうえで無い」と「調べていない」の区別が読者に付く。
    /*
     * ★ **台帳のリンクをそのまま href にしないこと**（2026-09-13）。
     *   Prime Video の `app.primevideo.com/…` は tag= が乗らず0円になる。
     *   落とし先の規則は `work-links.ts` の `availabilityUrl` に1か所で置いた。
     *   ここで host を見て分岐を足さないこと（規則が2つに割れる）。
     */
    /*
     * ★ **U-NEXT だけ送り先が違う。** 在庫台帳（配信API）に無い社なので
     *   `marks.links` も `availabilityUrl` も持っていない。作品名の検索へ渡す
     *   （`unextSearchUrl`）。
     */
    const url =
      svc.key === UNEXT_SERVICE.key
        ? unextSearchUrl(title)
        : mark === 'subscription' || mark === 'paid'
          ? availabilityUrl(svc.key, marks.links.get(svc.key), title)
          : undefined
    const inner: Node[] = [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['avail-mark'], 'aria-hidden': 'true' },
        children: [text(MARK_SYMBOL[mark])],
      },
      text(svc.label),
    ]
    items.push({
      type: 'element',
      tagName: 'span',
      properties: {
        className: ['avail-item'],
        'data-mark': mark,
        // 記号だけでは意味が乗らない。読み上げにも hover にも言葉を出す
        title: `${svc.label}（${MARK_LABEL[mark]}）`,
      },
      children: [
        url
          ? {
              type: 'element',
              tagName: 'a',
              properties: { href: url, className: ['avail-link'] },
              children: inner,
            }
          : { type: 'element', tagName: 'span', properties: {}, children: inner },
      ],
    })
  }

  /*
   * ★ **×だけの行にも行き先を渡す**（2026-09-12 追加。`findChips` の説明）。
   *   ○ や △ が1つでもあるなら、答えはもう行の中にある。**そこには足さない。**
   *   足すと「では、どこで観るのか」の答えが他社検索に埋もれる。
   */
  if (state === 'none') items.push(...findChips(title, own))

  return availCell(items, colspan)
}

/**
 * 中身を `<tr>` にする。
 *
 * ★ **チップを1枚の箱で包む。**
 *   `colspan` のセルは**表のスクロール幅いっぱい**に広がるので、
 *   直接並べるとチップが右へ伸びて画面外に出る（スマホで実際に切れた）。
 *   包んだ箱を `position: sticky; left: 0` で左端に留め、
 *   **見えている幅の中で折り返させる**（styles/global.css）。
 */
function availCell(items: Node[], colspan: number): Node {
  return {
    type: 'element',
    tagName: 'tr',
    properties: { className: ['avail-row'] },
    children: [
      {
        type: 'element',
        tagName: 'td',
        properties: { className: ['avail-cell'], colSpan: colspan },
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: { className: ['avail-inner'] },
            children: items,
          },
        ],
      },
    ],
  }
}

/**
 * 表の直後に置く凡例。
 *
 * ★ **取得日を持たせる。** 表だけ見て離れる読者がいる以上、
 *   「いつ時点か」を本文に書かせて済ませない。
 * ★ **△（レンタル・購入）は説明する。** しないと見放題と読まれる。
 */
function legendNode(asOf: Date | undefined, hasUnknown: boolean, hasUnext = false): Node {
  const stamp = asOf ? `${asOf.getMonth() + 1}月${asOf.getDate()}日時点・` : ''
  // ★ — が1つも出ていないなら凡例にも出さない。読まなくていいものを増やさない
  const unknown = hasUnknown ? `　${MARK_SYMBOL.unknown} 未確認` : ''
  /*
   * ★ **社数は実際に出た印に合わせる**（2026-09-16）。
   *   U-NEXT の ○ が出た表だけ「5サービス分」。出ていない表で5と書くと、
   *   **調べていない社を調べたことにしてしまう**（`unext-stock.ts` 冒頭の 1）。
   *
   * ★ **「時点」は4社とU-NEXTのうち、いちばん古い観測**（`planTable` の `oldest`）。
   *   U-NEXT の索引は1ジャンル歩き切るのに4〜5週間かかるので、
   *   たいていこちらが古い。**言い過ぎないほうへ倒す**という既存の決まりのまま。
   */
  const count = hasUnext ? '5' : '4'
  return {
    type: 'element',
    tagName: 'p',
    properties: { className: ['avail-legend'] },
    children: [
      text(
        `${MARK_SYMBOL.subscription} 見放題　${MARK_SYMBOL.paid} レンタル・購入　` +
          `${MARK_SYMBOL.none} 取り扱いなし${unknown}` +
          `（${stamp}${count}サービス分。各社の都合で変わります）`,
      ),
    ],
  }
}

/** 表 → その直後に入れる凡例。差し込むのは `walk` の親側。 */
const pendingLegends = new Map<Node, Node>()

/** そのノードを子に持つ親を探す。`<tbody>` があってもなくても動く。 */
function findParent(root: Node, target: Node): Node | undefined {
  for (const child of root.children ?? []) {
    if (child === target) return root
    const hit = findParent(child, target)
    if (hit) return hit
  }
  return undefined
}

/** 1つの表について「どの行に何を足すか」を決めた結果。**まだ書き換えない。** */
interface TablePlan {
  table: Node
  /** 元の行 → 足す内容。`marks` も `unext` も無い行が「未確認（—）」になる */
  found: Map<Node, { marks?: WorkMarks; own?: string; title: string; unext?: UnextStock }>
  /** そのうち**答えを1つ以上出せた**行の数（4社の印 or U-NEXT の ○） */
  resolved: number
  /** 引けた在庫のうち、いちばん古い取得日（凡例に出す） */
  oldest?: Date
  /** U-NEXT の ○ が1つでも出るか。**凡例の社数が変わる** */
  hasUnext: boolean
}

/**
 * 表を1つ読んで、足す行を決める。**書き換えはしない**（`applyPlan` が行う）。
 *
 * ★ **決めるのと書くのを分けてあるのは、記事全体を見てから決めるため。**
 *   1つの表だけを見て「1件も引けないから何もしない」と決めると、
 *   同じ記事の中に**印のある表と無い表**が並ぶ（2026-09-06 にウルトラマンで踏んだ。
 *   Prime Video の表には印が出て、U-NEXT の表には1つも出なかった）。
 *   読者から見れば同じ記事の同じ形の表なので、**そこだけ壊れて見える。**
 */
function planTable(table: Node): TablePlan | undefined {
  const rows: Node[] = []
  const collect = (n: Node): void => {
    if (n.tagName === 'tr') rows.push(n)
    for (const c of n.children ?? []) collect(c)
  }
  collect(table)
  if (rows.length < 2) return undefined

  /*
   * ★ **作品として引けた行には、必ず行を足す**（2026-09-06・運用者の指摘）。
   *
   *   途中の行だけ抜けていると、読者には
   *   **「この作品はサービス先が表示されていない」＝不具合**に見える。
   *   在庫が無い作品は × を並べ、**在庫を調べられていない作品は — を並べる。**
   *   画面の上で「調べたうえで無い」と「調べていない」が分かれる。
   *
   *   取りこぼしは `npm run availability -- --ids <作品ID>` で埋める。
   *   **書き直しの表は前の版の行を落とさない**ので、素材から外れた作品が残る
   *   （そこが — になる。pipeline/cli/availability.ts の `--ids` の説明）。
   */
  const found = new Map<
    Node,
    { marks?: WorkMarks; own?: string; title: string; unext?: UnextStock }
  >()
  let oldest: Date | undefined
  let resolved = 0
  let hasUnext = false
  for (const row of rows.slice(1)) {
    const w = workOf(row)
    if (!w) continue
    const m = marksOf(w.ids, w.title)
    /*
     * ★ **U-NEXT は題名だけで引く**（2026-09-16 追加）。
     *   4社の印は作品ID（`w.ids`）で引くが、U-NEXT の索引は配信APIの作品IDを
     *   1つも持っていない（別の体系。docs/HANDOVER.md の「D. U-NEXT記事の ○/△」）。
     *   結び付けられるのは**題名だけ**なので、突き合わせの厳しさも
     *   `unext-stock.ts` 側に閉じてある（完全一致・割れたら黙る）。
     */
    const unext = unextStockFor(w.title)
    if (unext) hasUnext = true
    // ★ 題名も持たせる。**「他で探す」の検索リンクを組むのに要る**（`findChips`）
    found.set(row, { marks: m, own: w.service, title: w.title, unext })
    /*
     * ★ **U-NEXT だけで引けた行も「答えのある行」に数える**（2026-09-16）。
     *   `resolved` は下の歯止め（`resolved * 3 < rows`）が読む数で、意味は
     *   **「読者に答えを渡せた行がどれだけあるか」**。根拠が4社かU-NEXTかは
     *   読者には関係が無い。数えないと、答えが出ている記事まで
     *   「他で探す」だけに落ちる。
     */
    if (m && (!oldest || m.fetchedAt < oldest)) oldest = m.fetchedAt
    if (unext && (!oldest || unext.sweptAt < oldest)) oldest = unext.sweptAt
    if (m || unext) resolved++
  }
  if (found.size === 0) return undefined
  return { table, found, resolved, oldest, hasUnext }
}

/**
 * 決めたとおりに行を差し込む。
 *
 * @param chipsOnly 印を1つも出せない記事のとき。**「他で探す」だけの行**にする
 *   （`findOnlyRow`）。凡例も出さない — 照らし合わせる記号が表に無いため。
 */
function applyPlan(
  plan: TablePlan,
  count: { tables: number; rows: number },
  chipsOnly = false,
): void {
  const { table, found } = plan
  const headRow: Node | undefined = (() => {
    const rows: Node[] = []
    const collect = (n: Node): void => {
      if (n.tagName === 'tr') rows.push(n)
      for (const c of n.children ?? []) collect(c)
    }
    collect(table)
    return rows[0]
  })()
  if (!headRow) return

  /*
   * ★ **元の列は1つも落とさない**（2026-09-06・運用者の判断）。
   *   「サービス」列も「状態」列もそのまま残す。表が横に伸びて
   *   スクロールが要るのは構わない、という判断。
   *   足す行は colspan で全幅を使うので、**スクロールしなくても読める。**
   *
   *   ★ 幅のために列を落とす実装を一度入れて、外した。
   *     戻すときは `dropColumn` / `dropConstantColumn` を呼ぶだけでよい
   *     （関数は残してある）。
   */
  const colspan = cellsOf(headRow).length

  for (const [row, hit] of found) {
    const parent = findParent(table, row)
    if (!parent?.children) continue
    const idx = parent.children.indexOf(row)
    if (idx < 0) continue
    /*
     * ★ `chipsOnly` でも、**印を引けた行はちゃんと印を出す。**
     *   落とすのは「— 未確認」だけ。答えを持っている行まで
     *   「他で探す」に落とすと、○ の直リンク（成果の出る唯一のリンク）が消える。
     */
    parent.children.splice(
      idx + 1,
      0,
      chipsOnly && !hit.marks && !hit.unext
        ? findOnlyRow(hit.title, hit.own, colspan)
        : availRow(hit.marks, colspan, hit.own, hit.title, hit.unext),
    )
    // 元の行に印。CSSで下の罫線を消して2行を1組に見せる
    const props = (row.properties ??= {})
    const prev = Array.isArray(props.className) ? (props.className as string[]) : []
    props.className = [...prev, 'has-avail']
    count.rows++
  }

  count.tables++
  /*
   * ★ **1件も引けなかった表には凡例を出さない。**
   *   ○ も △ も × も出ていない表の下に「○ 見放題　△ …」と並べても、
   *   **どの記号も表に無い**ので読者は照らし合わせられない。
   *   その表に出ているのは「— 未確認」だけで、それは記号だけで意味が通る。
   */
  /*
   * ★ `chipsOnly` でも、印が1つでも出ている表には凡例を出す。
   *   出ている記号を説明しないほうが不親切で、条件（`resolved > 0`）は同じでよい。
   * ★ ただし「— 未確認」は**この表に無い**（未確認の行は「他で探す」になっている）ので、
   *   凡例からも落とす。無い記号を説明すると読者が探しに行く。
   */
  if (plan.resolved > 0) {
    pendingLegends.set(
      table,
      legendNode(plan.oldest, !chipsOnly && plan.resolved < found.size, plan.hasUnext),
    )
  }
}

/**
 * **印を1つも出せない記事の表**に足す、「他で探す」だけの行（2026-09-13）。
 *
 * ■ なぜ要るか
 * 在庫が1件も引けない記事では、下の歯止め（`resolved * 3 < rows`）が働いて
 * **行を1本も足さない。** そこは正しいのだが、結果として
 * **表の中に次の一手が1つも無い記事**ができる。
 *
 *   実測（2026-09-13・9月のU-NEXT終了記事）
 *     160行すべてに答えが無く、行き先は U-NEXT の作品ページ（未提携＝0円）だけ
 *     サイトで最もCTRの高い記事（22%）で、読者はそこで行き止まりになっていた
 *
 * ■ 「— 未確認」は出さない
 * 歯止めが止めていたのは**「分からない」が延々と並ぶこと**で、それは今も出さない。
 * 出すのは**答えの代わりになるもの**（`findChips`）だけ。
 * 2026-09-12 に閾値を 1/2 → 1/3 に緩めたときの理屈
 * （「未確認の行は『何も言っていない行』ではなくなった」）を、
 * **印が0件の記事にも通した**形になる。
 *
 * ★ **記号（○ △ ×）は付けない。** 調べていない先を調べたことにしないため
 *   （`findChips` の注意書きと同じ）。ラベルの枠も出さない —
 *   あれは「この行の答えは何色か」を言うもので、答えが無いここでは嘘になる。
 */
function findOnlyRow(title: string, own: string | undefined, colspan: number): Node {
  return availCell(findChips(title, own), colspan)
}

/** 記事の中の `<table>` を出てくる順に集める。 */
function collectTables(node: Node, out: Node[]): void {
  for (const child of node.children ?? []) {
    if (child.type === 'element' && child.tagName === 'table') out.push(child)
    else collectTables(child, out)
  }
}

/** 決まった凡例を、表の**兄弟**として差し込んで回る。 */
function insertLegends(node: Node): void {
  const children = node.children ?? []
  if (children.length === 0) return
  const out: Node[] = []
  for (const child of children) {
    if (child.type === 'element' && child.tagName === 'table') {
      out.push(child)
      /*
       * ★ 凡例は**表の兄弟**として入れる。表の中に入れると
       *   `<table>` の直下に `<p>` が来て、HTMLとして不正になる。
       */
      const legend = pendingLegends.get(child)
      if (legend) {
        out.push(legend)
        pendingLegends.delete(child)
      }
      continue
    }
    insertLegends(child)
    out.push(child)
  }
  node.children = out
}

/**
 * 「他で探す」だけの行を出してよい記事の種類。
 *
 * ★ **期限がある記事にだけ出す。** `leaving`（終了予定）と `ended`（終了済み）は
 *   「ここでは観られなくなる／観られない」が主題なので、
 *   **1作ずつ次の一手が要る。**
 *
 * ★ **`arrivals` には出さない。** 「そのサービスに今入った」話で、
 *   読者が他社を探す動機がそもそも薄い。出すと実測で
 *   **1ページに229行・Amazonリンク406本**まで膨らみ（2026-09-13・8月の新着記事）、
 *   読者の役に立たないまま「主目的がアフィリエイトリンク」に近づく
 *   （docs/AFFILIATE.md の審査の項）。
 */
const CHIPS_ONLY_CATEGORIES = ['leaving', 'ended']

/** Astro が渡す vfile。frontmatter だけ使う。 */
interface VFile {
  data?: { astro?: { frontmatter?: Record<string, unknown> } }
}

export function rehypeAvailability() {
  return (tree: Node, file?: VFile): void => {
    try {
      const tables: Node[] = []
      collectTables(tree, tables)
      const plans = tables
        .map((t) => planTable(t))
        .filter((p): p is TablePlan => p !== undefined)

      /*
       * ★ **未確認が、印のある行の2倍を超える記事では、行を1つも足さない。**
       *   （＝答えられるのが全体の 1/3 に満たない記事。**2026-09-12 に 1/2 から緩めた**）
       *
       *   月次記事は在庫を取っていない（`npm run availability` は
       *   シリーズ記事のために回している）ので、閾値なしにすると
       *   **199行の「未確認」**が並ぶ。実際にそうなって入れた歯止め（2026-09-06）。
       *
       *   ★ **なぜ 1/2 から 1/3 へ緩めたか**（2026-09-12・運用者の指摘）
       *     「仮面ライダー」が **38行中15行（39%）** で、**在庫行がまるごと消えていた。**
       *     読者から見れば、**在庫の答えを持っている15行ぶんも道連れ**になっている。
       *     加えて、未確認の行にも「他で探す」が付くようになった（`findChips`）ので、
       *     **未確認の行は「何も言っていない行」ではなくなった。**
       *
       *   ★ **比率で持つ意味。** 1/3 にすると「未確認は印のある行の2倍まで」と
       *     同じことになり、**記事が大きくなるほど必要な印の数も増える**。
       *     231行の新着記事が通るには77行ぶんの在庫が要る。
       *     そこまで揃っていれば、もう「壊れて見える表」ではない。
       *
       *   実測（2026-09-12・公開中の30記事）:
       *     コナン           34行中31行（91%） → 出す
       *     **仮面ライダー   38行中15行（39%） → 出す**（前は出なかった）
       *     9月のNetflix終了 108行中36行（33%）→ 出す
       *     ウルトラマン     12行中3行（25%） → **出さない**
       *     8月の新着記事    201行中7行（3%） → **出さない**
       *
       *   ★ **判断は記事単位。表ごとにしない。** 表ごとにすると、同じ記事の中に
       *     答えのある表と無い表が並ぶ（`planTable` の注意書き）。
       *   ★ 在庫が増えれば自動で出るようになる。**記事側を直す必要はない。**
       *     取りこぼしは `npm run availability -- --ids <作品ID>` で埋める。
       */
      /*
       * ★ **閾値を割った記事は、「他で探す」だけを出す**（2026-09-13 変更）。
       *   それまでは `return` して**行を1本も足さなかった**。止めたかったのは
       *   「— 未確認」が延々と並ぶことで、それは今も出さない
       *   （`chipsOnly` の行は `findOnlyRow`）。
       *
       *   ★ **印を引けた行はそのまま印を出す。** 落ちるのは未確認の行だけ。
       *
       *   実測（2026-09-13・9月のU-NEXT終了記事）
       *     160行すべてが行き止まりで、外に出る道は U-NEXT（未提携＝0円）だけだった
       */
      const resolved = plans.reduce((n, p) => n + p.resolved, 0)
      const rows = plans.reduce((n, p) => n + p.found.size, 0)
      const category = file?.data?.astro?.frontmatter?.category
      const chipsOnly = resolved * 3 < rows
      // ★ 出してよい種類でなければ、今までどおり**行を1本も足さない。**
      if (chipsOnly && !CHIPS_ONLY_CATEGORIES.includes(String(category))) return

      const count = { tables: 0, rows: 0 }
      for (const plan of plans) applyPlan(plan, count, chipsOnly)
      insertLegends(tree)
    } catch {
      // 表の形が想定と違っても記事は出す。**行が足りないだけ。**
    }
  }
}
