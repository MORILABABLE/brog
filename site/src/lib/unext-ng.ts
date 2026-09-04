/**
 * U-NEXT の広告を出してはいけないページを見分ける。
 *
 * ■ 何のためにあるか
 * U-NEXT のアフィリエイトガイドライン（2026年9月3日改訂）は、
 * **特定の権利元・特定の作品を「アフィリエイト広告で扱うこと」を禁止している。**
 * 違反すると提携解除と、過去分を含む**成果の全件却下**になる。
 *
 *   TBS作品・TBSオンデマンド / 日テレ作品 / FOD（フジテレビオンデマンド）
 *   HBO・HBO Max / ガイドラインが名指しする37作品
 *
 * 当サイトの記事は自動生成で、収集した作品をそのまま並べる。
 * **人が1本ずつ見て止めることはできない。** だから機械が止める。
 *
 * ■ 止め方は「広告を出さない」。作品を消すのではない
 * 記事は「見放題の配信が終わる」という事実を伝えるものなので、事実は残す。
 * 禁じられているのは**アフィリエイト広告で扱うこと**であって、
 * その作品に触れること自体ではない。よって
 * **該当作品が載っているページからは U-NEXT の広告だけを外す。**
 * Amazon の導線はそのまま残る（Amazonのガイドラインには当たらない）。
 *
 * ■ 取りこぼすより広く止める
 * 部分一致で見る。「三銃士」は別作品の題名にも当たるが、
 * **止め過ぎて失うのは広告1枠、取りこぼして失うのは提携そのもの**なので、
 * 迷ったら止める側に倒す。
 *
 * ■ データの出どころ
 *   data/unext-ng.json  … ガイドライン本文の書き写し（人が手で管理）
 *                          + `npm run unext:ng` が集めた該当作品の一覧
 *
 * ★ **判定ロジックが2か所にある。** ここ（サイト側・ビルド時）と
 *   `pipeline/cli/check-unext.ts`（公開物の検査）。
 *   サイトは独立した npm プロジェクトで pipeline を読めないため、
 *   `search-links.ts` と同じ事情でこうなっている。
 *   **正規化の規則を変えるときは必ず両方直すこと。**
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface NgHit {
  /** 何に当たったか。運用者向けの説明に使う */
  kind: 'title' | 'rights-holder' | 'work'
  /** 当たった文字列（データ側の表記） */
  match: string
  /** 人に見せる説明。権利元のときだけ入る */
  label?: string
}

interface NgTitle {
  match: string
  /** all = どこでも禁止 / sns = SNS投稿でのみ禁止（ウェブページでは止めない） */
  scope?: 'all' | 'sns'
  note?: string
}

interface NgFile {
  guidelineRevision?: string
  titles?: NgTitle[]
  rightsHolders?: { match: string; label?: string }[]
  works?: Record<string, string>
  worksFetchedAt?: string
}

/**
 * `data/unext-ng.json` を探す。
 *
 * ★ `import.meta.url` からの相対解決は使えない。Astro はビルド時にこのファイルを
 *   チャンクへバンドルするので、位置がソースと変わる（work-links.ts と同じ事情）。
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

let file: NgFile | null = null

function load(): NgFile {
  if (file) return file
  const path = findUp('data', 'unext-ng.json')
  if (!path) {
    // 無くてもビルドは通す。**ただし何も止まらない**ので、
    // 広告を出す前に必ずファイルがあることを確かめること（check-unext が見る）。
    file = {}
    return file
  }
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as NgFile
  } catch {
    file = {}
  }
  return file
}

/**
 * 正規表現に使うバックスラッシュ。
 * ソースに直接書かないのは、この文字がファイルを渡り歩くときに
 * いちばん壊れやすいため（エディタ・シェル・コピペのどれでも化ける）。
 */
const BS = '\u005C'

/** 正規表現で特別な意味を持つ文字。ここに載っているものだけを打ち消す。 */
const META = `.*+?^\${}()|[]/-${BS}`

/**
 * 正規表現に入れる前に、メタ文字を無害にする。
 *
 * ★ 何でもかんでもエスケープしない。日本語の1文字に BS を付けると
 *   `u` フラグ付きの正規表現では構文エラーになる書き方になる。
 */
function escapeRe(s: string): string {
  return [...s].map((c) => (META.includes(c) ? BS + c : c)).join('')
}

/**
 * 比較のときに落とす記号。**増やすほど当たりが広くなる**（安全側）。
 *
 * 正規表現リテラルに直接書くと `/` の扱いで環境差が出る（esbuild は
 * 文字クラスの中の `/` を嫌う）ので、文字の一覧として持ってから組み立てる。
 */
const DROPPED = ` \t\n　・･ー‐‑‒–—―~〜:：/／,、.。!！?？"'“”‘’「」『』【】()（）[]*＊`

const DROP_RE = new RegExp(`[${escapeRe(DROPPED)}]`, 'g')

/**
 * 比較用に文字列をならす。
 *
 * 記号と空白を落とし、英字は小文字に寄せる。ならした形どうしで比べるので、
 * 「ウォルト・ディズニー」と「ウォルトディズニー」はどちらでも当たる。
 *
 * ★ pipeline/cli/check-unext.ts の同名関数と揃えること。
 */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(DROP_RE, '')
}

/**
 * 短い英字の略称かどうか（`TBS` `FOD` `HBO` など）。
 *
 * ■ なぜ特別扱いが要るか
 * ふつうの照合は**記号と空白を落としてから**部分一致で見る。その方式で
 * 3文字の略称を探すと、**まったく関係のない文字列に当たる。**
 * 実例（2026-09-04）: 出演者「Răzvan **Fod**or」が
 * ならすと `razvanfodor` になり、`fod` を含むために FOD 作品と判定された。
 *
 * だから略称だけは**語の区切りで、大文字小文字を区別して**見る。
 * 権利元の略称はどれも大文字で書かれるので、これで取りこぼさない。
 */
function isAbbrev(p: string): boolean {
  return /^[A-Za-z0-9]{1,4}$/.test(p)
}

interface Matcher {
  /** 記号を落とした文字列に当てる正規表現（本体） */
  re: RegExp | null
  /** 略称用。**もとの文字列**に語の区切りつきで当てる */
  word: RegExp | null
  /** 題名用。**もとの文字列**に、題名としての区切りつきで当てる */
  delimited: RegExp | null
}

function buildMatcher(patterns: string[]): Matcher | null {
  const abbrev = patterns.filter(isAbbrev)
  const rest = patterns.filter((p) => !isAbbrev(p))

  const normalized = rest.map((p) => normalize(p)).filter((p) => p.length > 0)
  const re = normalized.length > 0 ? new RegExp(normalized.map(escapeRe).join('|'), 'g') : null
  // ★ 語の区切り（\b）を文字列から組む。正規表現リテラルに書かないのは
  //   バックスラッシュがファイルを渡り歩くときに化けるため（上の BS と同じ理由）。
  const word =
    abbrev.length > 0
      ? new RegExp(`${BS}b(?:${abbrev.map(escapeRe).join('|')})${BS}b`, 'g')
      : null

  return re || word ? { re, word, delimited: null } : null
}

/**
 * 題名の前後に来てよい文字。**表のセル・かぎ括弧・行の切れ目**を想定している。
 *
 *   | 9月30日 | 新参者 | 70/100 | U-NEXT |   ← 表のセル
 *   「新参者」は…                              ← 本文のかぎ括弧
 */
const OPEN = `|「『【（(><*\n\t`
const CLOSE = `|」』】）)<>*\n\t`

/**
 * 集めてきた題名（`npm run unext:ng` の結果）用の照合。
 *
 * ■ なぜ部分一致で見てはいけないか
 * TBSオンデマンドの一覧には「秘密」「卒業」「サキ」「C」のような
 * **ふつうの語と見分けが付かない題名**が並んでいる（実測 1,469件中に多数）。
 * これを部分一致で当てると「この作品の**秘密**は…」という文にも当たり、
 * 記事20本のうち10本が巻き添えになった（2026-09-04 に実測）。
 *
 * **止め過ぎは安全ではない。** 全ページから広告が消えるなら、
 * 提携が通っても1円も生まれない。だから題名は
 * **題名として書かれているときだけ**当てる。
 *
 * ★ 記号を落とした文字列ではなく、**もとの文字列**に当てること。
 *   区切り（かぎ括弧・表の `|`）は落とした後には残っていない。
 */
function buildDelimited(patterns: string[]): Matcher | null {
  const cleaned = [...new Set(patterns.map((p) => p.normalize('NFKC').trim()))].filter(Boolean)
  if (cleaned.length === 0) return null
  const body = cleaned.map(escapeRe).join('|')
  const open = `(?:^|[${escapeRe(OPEN)}])[ ]*`
  const close = `[ ]*(?:$|[${escapeRe(CLOSE)}])`
  return { re: null, word: null, delimited: new RegExp(`${open}(${body})${close}`, 'g') }
}

let titleMatcher: Matcher | null | undefined
let holderMatcher: Matcher | null | undefined
let workMatcher: Matcher | null | undefined

/** 当たった正規化パターン → 元の表記。報告に使う */
let originOf = new Map<string, { kind: NgHit['kind']; match: string; label?: string }>()

function matchers(): void {
  if (titleMatcher !== undefined) return
  const data = load()
  originOf = new Map()

  // SNS限定の禁止（DOWNTOWN+パック）はウェブページでは止めない。
  // ガイドラインが分けているものを、こちらで一緒くたにしない。
  const titles = (data.titles ?? []).filter((t) => (t.scope ?? 'all') === 'all')
  // ★ 先に入れたほうを残す（`set` で上書きしない）。「TBS」と「ＴＢＳ」のように
  //   ならすと同じになる表記が複数あるとき、報告に出るのが後ろの表記になってしまう。
  const remember = (key: string, v: { kind: NgHit['kind']; match: string; label?: string }) => {
    if (!originOf.has(key)) originOf.set(key, v)
  }

  // ★ 略称はもとの表記のまま覚える（照合もそのまま行うため）。
  const key = (p: string) => (isAbbrev(p) ? p : normalize(p))

  for (const t of titles) remember(key(t.match), { kind: 'title', match: t.match })
  titleMatcher = buildMatcher(titles.map((t) => t.match))

  const holders = data.rightsHolders ?? []
  for (const h of holders) {
    remember(key(h.match), { kind: 'rights-holder', match: h.match, label: h.label })
  }
  holderMatcher = buildMatcher(holders.map((h) => h.match))

  // ★ 集めてきた題名だけは照合の仕方が違う（buildDelimited の注意書き）。
  //   覚えるキーも「NFKC しただけの題名」。当たった文字列がそのまま返る。
  const works = Object.values(data.works ?? {})
  for (const w of works) remember(w.normalize('NFKC').trim(), { kind: 'work', match: w })
  workMatcher = buildDelimited(works)
}

/**
 * @param normalized 記号を落とした文字列（本体の照合に使う）
 * @param plain 全角を半角に直しただけの文字列（略称の照合に使う）
 */
function hitsFrom(m: Matcher | null | undefined, normalized: string, plain: string): NgHit[] {
  if (!m) return []
  const out: NgHit[] = []
  const seen = new Set<string>()
  const collect = (re: RegExp | null, text: string) => {
    if (!re) return
    re.lastIndex = 0
    for (const found of text.matchAll(re)) {
      // ★ 区切りつきの照合は括弧やセルの `|` まで拾うので、
      //   当たった題名そのもの（捕獲した部分）を優先して見る。
      const k = found[1] ?? found[0]
      if (seen.has(k)) continue
      seen.add(k)
      out.push(originOf.get(k) ?? { kind: 'title', match: k })
    }
  }
  collect(m.re, normalized)
  collect(m.word, plain)
  collect(m.delimited, plain)
  return out
}

/**
 * その文章に、U-NEXT の広告と同居させてはいけないものが含まれているか。
 *
 * 記事本文でも、表の作品名を並べた文字列でも、同じように渡してよい。
 * **1件でも返ってきたら、そのページに U-NEXT の広告を出さない。**
 *
 * @param text 記事本文（Markdown のままでよい）や作品名を並べた文字列
 */
export function ngHitsIn(text: string): NgHit[] {
  matchers()
  const t = normalize(text)
  // ★ 略称の照合には**記号を落とさない**文字列を渡す（語の区切りが要るため）。
  //   全角の「ＴＢＳ」を拾うために NFKC だけかける。
  const plain = text.normalize('NFKC')
  return [
    ...hitsFrom(titleMatcher, t, plain),
    ...hitsFrom(workMatcher, t, plain),
    ...hitsFrom(holderMatcher, t, plain),
  ]
}

/** テスト・再読込用 */
export function resetUnextNg(): void {
  file = null
  titleMatcher = undefined
  holderMatcher = undefined
  workMatcher = undefined
}
