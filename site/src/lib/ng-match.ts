/**
 * 掲載NG（広告主が「扱うこと」を禁じている権利元・作品）の照合。
 *
 * ■ なぜ独立したファイルなのか
 * **広告主が2社になったから**（2026-09-14）。U-NEXT と Hulu は
 * 禁じている対象が違うのに、**照合の規則は同じでなければならない。**
 *
 *   U-NEXT … TBS / 日テレ / FOD / HBO ＋ 名指しの37作品
 *   Hulu   … TBS / ディズニー ＋ 配信終了タイトル
 *
 * 規則がずれると「U-NEXTでは止まるのに Hulu では素通りする」が起き、
 * しかも**素通りした側でしか事故にならない**ので気づけない。
 * だから当て方はここ1か所に置き、読むデータだけを差し替える。
 *
 * ■ 照合は3通りある。**同じ規則で当ててはいけない**
 * どちらも 2026-09-04 に実際に踏んだ失敗で、2つとも
 * 「安全側に倒したつもりが逆だった」もの。
 *
 * | 対象 | 当て方 | なぜ |
 * |---|---|---|
 * | 権利元の略称（`TBS` `FOD` `HBO`） | 語の区切り＋大文字小文字を区別 | 記号を落として部分一致にすると、出演者「Răzvan **Fod**or」が FOD 作品として当たった |
 * | 集めてきた題名（1,000件超） | **題名として書かれているときだけ** | 「秘密」「卒業」「サキ」「C」のようなふつうの語と同じ題名が並ぶ。部分一致にすると「この作品の**秘密**は…」に当たり、記事20本中10本が巻き添えになった |
 * | 名指しの作品・権利元の日本語表記 | 記号を落として部分一致（広め） | 数が少なく、どれも紛れにくい語。ここは広く取るのが安全側 |
 *
 * ★ **止め過ぎは安全ではない。** 全ページから広告が消えれば、提携が通っても
 *   1円も生まれない。「取りこぼすより広く止める」は**紛れにくい語にだけ**
 *   通用する考え方だった。
 *
 * ★ **同じ規則が pipeline/core/ng-match.ts にもある。**
 *   サイトは独立した npm プロジェクトで pipeline を読めないため
 *   （`search-links.ts` と同じ事情）。**正規化の規則を変えるときは両方直すこと。**
 */

export interface NgHit {
  /** 何に当たったか。運用者向けの説明に使う */
  kind: 'title' | 'rights-holder' | 'work'
  /** 当たった文字列（データ側の表記） */
  match: string
  /** 人に見せる説明。権利元のときだけ入る */
  label?: string
}

export interface NgTitle {
  match: string
  /** all = どこでも禁止 / sns = SNS投稿でのみ禁止（ウェブページでは止めない） */
  scope?: 'all' | 'sns'
  note?: string
}

export interface NgRightsHolder {
  match: string
  label?: string
}

/** 照合のもとになるデータ。広告主ごとのファイルがこの形を満たす。 */
export interface NgSource {
  /** 名指しの作品名。記号を落として部分一致（広め） */
  titles?: NgTitle[]
  /** 権利元。略称は語の区切りで、日本語表記は部分一致で当てる */
  rightsHolders?: NgRightsHolder[]
  /** 集めてきた題名（作品ID → 題名）。**題名として書かれているときだけ**当てる */
  works?: Record<string, string>
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
 * ★ pipeline 側の同名関数と揃えること。
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
    abbrev.length > 0 ? new RegExp(`${BS}b(?:${abbrev.map(escapeRe).join('|')})${BS}b`, 'g') : null

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
 * 集めてきた題名用の照合。
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

/**
 * @param normalized 記号を落とした文字列（本体の照合に使う）
 * @param plain 全角を半角に直しただけの文字列（略称・題名の照合に使う）
 */
function hitsFrom(
  m: Matcher | null,
  origin: Map<string, NgHit>,
  normalized: string,
  plain: string,
): NgHit[] {
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
      out.push(origin.get(k) ?? { kind: 'title', match: k })
    }
  }
  collect(m.re, normalized)
  collect(m.word, plain)
  collect(m.delimited, plain)
  return out
}

export interface NgIndex {
  /** その文章に、広告と同居させてはいけないものが含まれているか */
  hitsIn(text: string): NgHit[]
  /** 集めてきた題名の件数。報告に使う */
  workCount: number
}

/**
 * 照合器を組む。**データを読むのは呼び出し側の仕事**（サイト側と pipeline 側で
 * ファイルの探し方が違うため）。
 */
export function buildNgIndex(src: NgSource): NgIndex {
  /** 当たったパターン → 元の表記。報告に使う */
  const origin = new Map<string, NgHit>()

  // ★ 先に入れたほうを残す（`set` で上書きしない）。「TBS」と「ＴＢＳ」のように
  //   ならすと同じになる表記が複数あるとき、報告に出るのが後ろの表記になってしまう。
  const remember = (key: string, v: NgHit) => {
    if (!origin.has(key)) origin.set(key, v)
  }

  // ★ 略称はもとの表記のまま覚える（照合もそのまま行うため）。
  const key = (p: string) => (isAbbrev(p) ? p : normalize(p))

  // SNS限定の禁止はウェブページでは止めない。
  // ガイドラインが分けているものを、こちらで一緒くたにしない。
  const titles = (src.titles ?? []).filter((t) => (t.scope ?? 'all') === 'all')
  for (const t of titles) remember(key(t.match), { kind: 'title', match: t.match })
  const titleMatcher = buildMatcher(titles.map((t) => t.match))

  const holders = src.rightsHolders ?? []
  for (const h of holders) {
    remember(key(h.match), { kind: 'rights-holder', match: h.match, label: h.label })
  }
  const holderMatcher = buildMatcher(holders.map((h) => h.match))

  // ★ 集めてきた題名だけは照合の仕方が違う（buildDelimited の注意書き）。
  //   覚えるキーも「NFKC しただけの題名」。当たった文字列がそのまま返る。
  const works = Object.values(src.works ?? {})
  for (const w of works) remember(w.normalize('NFKC').trim(), { kind: 'work', match: w })
  const workMatcher = buildDelimited(works)

  return {
    workCount: works.length,
    hitsIn(text: string): NgHit[] {
      const t = normalize(text)
      // ★ 略称の照合には**記号を落とさない**文字列を渡す（語の区切りが要るため）。
      //   全角の「ＴＢＳ」を拾うために NFKC だけかける。
      const plain = text.normalize('NFKC')
      return [
        ...hitsFrom(titleMatcher, origin, t, plain),
        ...hitsFrom(workMatcher, origin, t, plain),
        ...hitsFrom(holderMatcher, origin, t, plain),
      ]
    },
  }
}
