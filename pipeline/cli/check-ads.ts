/**
 * 公開物（site/dist）を afb 広告主のガイドラインで検査する。
 *
 *   npm run check:ads                 site/dist の全HTMLを検査する
 *   npm run check:ads -- --dir <path>  別のディレクトリを見る
 *   npm run check:ads -- --list        広告が出ているページを全部並べる
 *
 * `npm run check:unext` は同じものを指す別名（前からある呼び方）。
 *
 * ■ 広告主は2社（2026-09-14 に Hulu を追加）
 *
 * | | 掲載NG | 出し方 |
 * |---|---|---|
 * | **U-NEXT** | TBS / 日テレ / FOD / HBO ＋名指しの37作品 | ジャンル別LP・カテゴリ別の文面 |
 * | **Hulu** | TBS / ディズニー ＋**配信終了タイトル** | LP1枚・**作品名を持たない文面** |
 *
 * ★ **同じ一覧を両方に当ててはいけない。** 日テレ作品は U-NEXT ではNGだが、
 *   Hulu は日本テレビ系なので**むしろ主力**。混ぜると Hulu にとって
 *   いちばん噛み合うページを自分で潰す（site/src/lib/hulu-ng.ts）。
 *
 * ★ Hulu の「配信終了タイトルは掲載NG」は一覧で守れない
 *   （当サイトは Hulu の配信状況を取得できない＝規約違反になる）。
 *   **広告の文言に作品名を入れない**ことで守っている。
 *   だからこの検査は「Huluの広告があるページに作品の断定が無いか」を見る。
 *
 * ■ なぜ「書いたもの」ではなく「出したもの」を見るか
 * 記事の品質ゲート（pipeline/core/verify.ts）は**書いた瞬間**を見るが、
 * ガイドライン違反は**組み上がったページ**で起きる。
 * 固定文言・コンポーネント・テンプレートのどれが崩れても同じ結果になるので、
 * 最後に出たHTMLを1枚ずつ読むのがいちばん確実で、いちばん安い。
 *
 * ■ 何を見るか（ガイドライン 2026年9月3日改訂）
 *   【4】誤認を招く表現（「無料で見放題」「全て見放題」「期間限定」「今なら」…）
 *   【8】リトライキャンペーンへの言及
 *   【9】月額プラン1490への言及
 *   【11】無料視聴訴求
 *   【12】アダルト（その他♡・ムフフ）訴求
 *   注意事項【2】総額表示（価格を出すなら税込と書く）
 *   注意事項【3】広告（PR）表記
 *   注意事項【4】記載必須の注意文言
 *   掲載NG権利元・作品（data/unext-ng.json）と広告の同居
 *
 * ■ 判定の強さ
 *   error … 公開してはいけない。**提携解除・成果全却下の対象になりうる**
 *   warn  … 直したほうがよい（計測が効かない・取りこぼしている）
 *
 * ★ 掲載NGの判定ロジックは site/src/lib/ng-match.ts にもある。
 *   サイトは独立した npm プロジェクトでこちらを読めないため二重になっている
 *   （search-links.ts と同じ事情）。**正規化の規則を変えるときは両方直すこと。**
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { AD_POLICY_BANNED } from '../core/ad-policy.ts'

const DEFAULT_DIR = resolve('site/dist')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

// --- 掲載NGの一覧 -------------------------------------------------------------

interface NgFile {
  guidelineRevision?: string
  titles?: { match: string; scope?: 'all' | 'sns' }[]
  rightsHolders?: { match: string; label?: string }[]
  works?: Record<string, string>
  /** メニュー（権利元）別の内訳。**Hulu は TBS だけを借りる** */
  worksByMenu?: Record<string, Record<string, string>>
  worksFetchedAt?: string
}

/** 正規表現のエスケープに使うバックスラッシュ。site/src/lib/unext-ng.ts と同じ書き方。 */
const BS = '\u005C'
const META = `.*+?^\${}()|[]/-${BS}`

function escapeRe(s: string): string {
  return [...s].map((c) => (META.includes(c) ? BS + c : c)).join('')
}

/** 比較のときに落とす記号。**site/src/lib/unext-ng.ts の DROPPED と同じもの。** */
const DROPPED = ` \t\n　・･ー‐‑‒–—―~〜:：/／,、.。!！?？"'“”‘’「」『』【】()（）[]*＊`
const DROP_RE = new RegExp(`[${escapeRe(DROPPED)}]`, 'g')

function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(DROP_RE, '')
}

/**
 * 短い英字の略称か（`TBS` `FOD` `HBO`）。**照合の仕方を変えるための判定。**
 *
 * 記号を落とした文字列に3文字の略称を部分一致で当てると、無関係な語に当たる。
 * 実例（2026-09-04）: 出演者「Răzvan Fodor」→ `razvanfodor` が `fod` を含み、
 * FOD作品と判定された。略称は**語の区切りで、大文字小文字を区別して**見る。
 * site/src/lib/unext-ng.ts の `isAbbrev` と同じもの。
 */
function isAbbrev(p: string): boolean {
  return /^[A-Za-z0-9]{1,4}$/.test(p)
}

/**
 * 題名の前後に来てよい文字。**site/src/lib/unext-ng.ts の OPEN / CLOSE と同じもの。**
 * 集めてきた題名は「題名として書かれているとき」だけ当てる（同ファイルの注意書き）。
 */
const OPEN = `|「『【（(><*\n\t`
const CLOSE = `|」』】）)<>*\n\t`

interface Ng {
  re: RegExp | null
  word: RegExp | null
  delimited: RegExp | null
  origin: Map<string, string>
  /** 集めてきた題名の件数（報告用） */
  workCount: number
}

const EMPTY_NG: Ng = { re: null, word: null, delimited: null, origin: new Map(), workCount: 0 }

function readNgFile(path: string): NgFile | null {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as NgFile
  } catch {
    return null
  }
}

/**
 * 照合器を組む。**広告主ごとに読むデータが違うだけで、当て方は同じ。**
 * ずれると「片方では止まるのにもう片方では素通りする」が起きる。
 */
function buildNg(file: Pick<NgFile, 'titles' | 'rightsHolders' | 'works'>): Ng {
  const origin = new Map<string, string>()
  const patterns: string[] = []
  const abbrevs: string[] = []
  const works: string[] = []
  const add = (raw: string, shown: string) => {
    if (isAbbrev(raw)) {
      if (origin.has(raw)) return
      origin.set(raw, shown)
      abbrevs.push(raw)
      return
    }
    const key = normalize(raw)
    if (!key || origin.has(key)) return
    origin.set(key, shown)
    patterns.push(key)
  }

  for (const t of file.titles ?? []) {
    if ((t.scope ?? 'all') !== 'all') continue // SNS限定の禁止はウェブページでは見ない
    add(t.match, `掲載NG作品「${t.match}」`)
  }
  for (const h of file.rightsHolders ?? []) {
    add(h.match, `掲載NG権利元「${h.label ?? h.match}」`)
  }
  // ★ 集めてきた題名は**区切りつきで**照合する。「秘密」「卒業」のような
  //   ふつうの語と同じ題名が並んでいるため（unext-ng.ts の buildDelimited）。
  for (const [id, title] of Object.entries(file.works ?? {})) {
    const key = title.normalize('NFKC').trim()
    if (!key || origin.has(key)) continue
    origin.set(key, `掲載NG作品「${title}」（${id}）`)
    works.push(key)
  }

  return {
    re: patterns.length > 0 ? new RegExp(patterns.map(escapeRe).join('|'), 'g') : null,
    word:
      abbrevs.length > 0
        ? new RegExp(`${BS}b(?:${abbrevs.map(escapeRe).join('|')})${BS}b`, 'g')
        : null,
    delimited:
      works.length > 0
        ? new RegExp(
            `(?:^|[${escapeRe(OPEN)}])[ ]*(${works.map(escapeRe).join('|')})[ ]*(?:$|[${escapeRe(CLOSE)}])`,
            'g',
          )
        : null,
    origin,
    workCount: works.length,
  }
}

/** そのページに当たった掲載NG。**何も持っていない照合器には当たらない。** */
function hitsOf(ng: Ng, norm: string, plain: string, lines: string): string[] {
  if (!ng.re && !ng.word && !ng.delimited) return []
  const hits: string[] = []
  if (ng.re) {
    ng.re.lastIndex = 0
    hits.push(...new Set([...norm.matchAll(ng.re)].map((m) => m[0])))
  }
  if (ng.word) {
    ng.word.lastIndex = 0
    hits.push(...new Set([...plain.matchAll(ng.word)].map((m) => m[0])))
  }
  if (ng.delimited) {
    ng.delimited.lastIndex = 0
    hits.push(...new Set([...lines.normalize('NFKC').matchAll(ng.delimited)].map((m) => m[1]!)))
  }
  return [...new Set(hits.map((h) => ng.origin.get(h) ?? h))]
}

/** U-NEXT の掲載NG。3メニュー（TBS / 日テレ / FOD）ぜんぶが対象。 */
function loadUnextNg(): { file: NgFile; ng: Ng } {
  const file = readNgFile('data/unext-ng.json')
  if (!file) {
    console.warn('data/unext-ng.json が読めませんでした。U-NEXT の掲載NG検査は行いません。')
    return { file: {}, ng: EMPTY_NG }
  }
  return { file, ng: buildNg(file) }
}

/**
 * Hulu の掲載NG。**TBS だけを U-NEXT の一覧から借りる。**
 *
 * ★ `worksByMenu.tbs` が無い古いファイルのときは `works` 全体に落ちる。
 *   日テレ・FOD まで止まるので Hulu にとっては止め過ぎだが、
 *   **取りこぼすより安い**ので安全側に倒してある（site/src/lib/hulu-ng.ts と同じ）。
 */
function loadHuluNg(unext: NgFile): { file: NgFile; ng: Ng; narrowed: boolean } {
  const file = readNgFile('data/hulu-ng.json')
  if (!file) {
    console.warn('data/hulu-ng.json が読めませんでした。Hulu の掲載NG検査は行いません。')
    return { file: {}, ng: EMPTY_NG, narrowed: false }
  }
  const tbs = unext.worksByMenu?.tbs
  const narrowed = Boolean(tbs && Object.keys(tbs).length > 0)
  const works = { ...(file.works ?? {}), ...(narrowed ? tbs! : (unext.works ?? {})) }
  return { file, ng: buildNg({ ...file, works }), narrowed }
}

// --- 禁止表現 -----------------------------------------------------------------

/**
 * ページに出てはいけない言い回し。**一覧は core/ad-policy.ts が持つ。**
 * 記事の品質ゲート（core/verify.ts）と同じものを見るためで、
 * ここに直接足さないこと（片方だけ直すと食い違う）。
 */
const BANNED = AD_POLICY_BANNED

/** 価格を書いたら税込と明示する（注意事項【2】総額表示） */
const PRICE = /[0-9０-９][0-9０-９,，]*\s*円/

// --- HTML ---------------------------------------------------------------------

function htmlFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.html')) out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * 読者に見える文字だけを取り出す。
 *
 * ★ タグを消してから見ること。消さずに検査すると、ビルドが付ける
 *   ハッシュ（`BaseLayout.B_bWj3Kb.css`）のような文字列が
 *   「TBS」「HBO」に化けて当たる。
 *
 * ★ **`<main>` の中だけを見る。** ヘッダーのメニューには全ページに
 *   U-NEXT へのリンクが並んでいるので、ページ全体を見ると
 *   711ページすべてが「U-NEXTを扱っている」ことになってしまう。
 *   見たいのは**そのページが何を扱っているか**で、それは本文にある。
 */
function textOf(html: string, separator = ' '): string {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const out = (main ? main[1]! : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, separator)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return separator === ' ' ? out.replace(/\s+/g, ' ') : out.replace(/[ \t]*\n[\s]*/g, '\n')
}

interface Issue {
  level: 'error' | 'warn'
  page: string
  message: string
}

function main(): void {
  const dir = resolve(arg('dir') ?? DEFAULT_DIR)
  let files: string[]
  try {
    files = htmlFiles(dir)
  } catch {
    console.error(`${dir} が読めません。先に site でビルドしてください（cd site && npm run build）。`)
    process.exitCode = 1
    return
  }

  const unext = loadUnextNg()
  const hulu = loadHuluNg(unext.file)
  const issues: Issue[] = []
  const withAd: string[] = []
  const withHuluAd: string[] = []
  const blocked: { page: string; hit: string }[] = []
  let unextPages = 0

  for (const f of files) {
    const page = relative(dir, f).replace(/\\/g, '/')
    const html = readFileSync(f, 'utf8')
    const text = textOf(html)
    const norm = normalize(text)
    /*
     * 題名の照合だけは**タグの切れ目を改行にした**文字列を使う。
     *
     * タグを空白に潰すと、表のセルに入っている題名が「前後が空白の語」に
     * なってしまい、区切り（`|` やかぎ括弧）で見分けられなくなる。
     * 改行にしておけば、記事の Markdown の表と同じ形で当てられる
     * （サイト側は Markdown をそのまま渡すので、区切りが元から残っている）。
     */
    const lines = textOf(html, '\n')

    const hasAd = html.includes('data-unext-ad')
    const hasHuluAd = html.includes('data-hulu-ad')
    // ★ `href` だけを見る。ページ全体から拾うと、<head> の vref.js
    //   （`t.afi-b.com/jslib/vref.js`）まで「id1 の無いリンク」として数えてしまう。
    const afbLinks = [...html.matchAll(/href="(https:\/\/t\.afi-b\.com\/[^"]+)"/g)].map(
      (m) => m[1]!,
    )
    const mentionsUnext = /U-?NEXT|ユーネクスト/i.test(text)
    if (mentionsUnext) unextPages++
    if (hasAd) withAd.push(page)
    if (hasHuluAd) withHuluAd.push(page)

    // ★ **1ページに afb の枠は1つだけ**（components/AfbCta.astro）。
    //   2つ出ていたら出し分けが壊れている。読者には PR枠が2つ並んで見える。
    if (hasAd && hasHuluAd) {
      issues.push({
        level: 'error',
        page,
        message: 'U-NEXT と Hulu の広告が同じページに出ています（枠は1ページに1つ）。',
      })
    }

    const err = (message: string) => issues.push({ level: 'error', page, message })
    const warn = (message: string) => issues.push({ level: 'warn', page, message })

    // --- 禁止表現 ---
    // **広告が出ているページは error**（その言い回しが広告と同居している）。
    // U-NEXT に触れているだけのページも error にする — ガイドラインが縛るのは
    // U-NEXT の訴求だが、他社の話で同じ言い回しを使っていると
    // 「サイトの書き方」として見られたときに説明が要る。それ以外は warn。
    for (const b of BANNED) {
      const m = text.match(b.pattern)
      if (!m) continue
      const around = text.slice(Math.max(0, text.indexOf(m[0]) - 20), text.indexOf(m[0]) + 30)
      const msg = `禁止表現「${m[0]}」… ${b.why}（…${around.trim()}…）`
      if (mentionsUnext || hasAd || hasHuluAd) err(msg)
      else warn(msg)
    }

    // --- 掲載NG作品・権利元と広告の同居 ---
    // 略称と題名は記号を落とさない文字列に当てる（全角対策に NFKC だけかける）
    const plain = text.normalize('NFKC')

    const unextHits = hitsOf(unext.ng, norm, plain, lines)
    if (unextHits.length > 0) {
      const shown = unextHits.slice(0, 3).join(' / ')
      if (hasAd) {
        err(`${shown} が載っているページに U-NEXT の広告が出ています。広告を外してください。`)
      } else if (mentionsUnext) {
        blocked.push({ page, hit: shown })
      }
    }

    /*
     * Hulu 側。**当てる一覧が違う**（TBS ＋ ディズニー。日テレは対象外）。
     * 広告が出ていないページは報告しない — Hulu は当サイトの主題ではないので、
     * 「Huluに触れているページ」を数えても運用の判断材料にならない。
     */
    const huluHits = hitsOf(hulu.ng, norm, plain, lines)
    if (huluHits.length > 0 && hasHuluAd) {
      err(
        `${huluHits.slice(0, 3).join(' / ')} が載っているページに Hulu の広告が出ています。` +
          '広告を外してください（Hulu１）TBS作品・ディズニー作品は掲載NG）。',
      )
    }

    if (!hasAd && !hasHuluAd && afbLinks.length === 0) continue

    /*
     * 🔴 **枠の外に afb のリンクがある。**
     *
     * 広告はビルド時に枠（components/AfbCta.astro）が出していて、そのときに
     * 掲載NG作品・権利元を見て出す / 出さないを決めている。
     * 枠の目印（`data-unext-ad` / `data-hulu-ad`）が無いのに afb のリンクが
     * あるページは、**記事本文に直接書かれた広告コード**である可能性が高い。
     * それは**掲載NGの判定を通らない**ので、翌月そのページにTBS作品が
     * 入っても消えない。記事側は品質ゲート（core/ad-policy.ts）が止めるが、
     * 固定文言やテンプレートから混ざる経路もあるので、出力側でも見る。
     */
    if (!hasAd && !hasHuluAd && afbLinks.length > 0) {
      err(
        `広告の枠が無いのに afb のリンクがあります（${afbLinks[0]!.slice(0, 60)}…）。` +
          '記事本文に直接書かれていませんか（掲載NGの判定を迂回します）。',
      )
    }

    // --- Hulu の広告があるページの必須要素 ---
    if (hasHuluAd) {
      /*
       * 🔴 **ページ冒頭の広告（PR）表記。**
       *
       * Hulu４）はステマ規制の遵守を求めていて、対応しない場合は提携解除。
       * **枠の中には「PR」を置いていない**（2026-09-14 に撤去）ので、
       * 要件を満たしているのは `AffiliateNotice`（記事・作品ページの冒頭）だけ。
       * **つまりここが唯一の砦。** 冒頭の表記が消えると、
       * この枠は無表示の広告になる。
       *
       * ★ 「PR」だけでは弱い。目次やタグの「PR」に当たりうるので、
       *   `AffiliateNotice` の実文（「アフィリエイト広告」）も一緒に見る。
       */
      if (!/\bPR\b/.test(text) || !/アフィリエイト広告/.test(text)) {
        err(
          '広告（PR）表記がありません（Hulu４）ステマ規制）。' +
            'ページ冒頭の AffiliateNotice が出ていない可能性があります。',
        )
      }
      if (afbLinks.length === 0) {
        err('Hulu の枠はあるのに afb のリンク（t.afi-b.com）がありません。')
      }
    }

    // --- 広告があるページの必須要素 ---
    if (hasAd) {
      if (!/最新の配信状況はU-NEXTサイトにてご確認ください/.test(text)) {
        err('記載必須の注意文言がありません（注意事項【4】）。')
      }
      if (!/本ページの情報は\d{4}年\d{1,2}月時点のものです/.test(text)) {
        err('「◯年◯月時点」の注記がありません（注意事項【4】）。')
      }
      if (!/\bPR\b|広告|プロモーション/.test(text)) {
        err('広告（PR）表記がありません（注意事項【3】）。')
      }
      if (PRICE.test(text) && !/税込/.test(text)) {
        err('価格を書いているのに税込表記がありません（注意事項【2】総額表示）。')
      }
      if (afbLinks.length === 0) {
        err('広告の枠はあるのに afb のリンク（t.afi-b.com）がありません。')
      }
    }

    // --- 計測 ---
    for (const link of afbLinks) {
      if (!link.includes('id1=')) {
        warn(`afb のリンクに id1（枠）が付いていません: ${link.slice(0, 60)}…`)
      }
    }
    if (afbLinks.length > 0 && !html.includes('t.afi-b.com/jslib/vref.js')) {
      warn('afb のリンクがあるのに vref.js が入っていません（成果のリンク元が取れません）。')
    }
  }

  // --- 報告 ---
  const errors = issues.filter((i) => i.level === 'error')
  const warns = issues.filter((i) => i.level === 'warn')

  console.log(`検査したページ: ${files.length}`)
  console.log(`  U-NEXT に触れているページ: ${unextPages}`)
  console.log(`  U-NEXT の広告が出ているページ: ${withAd.length}`)
  console.log(`  Hulu の広告が出ているページ: ${withHuluAd.length}`)
  // ★ 「広告枠を置いているページ」だけを数えているわけではない。
  //   一覧ページやサイトマップのように、もともと枠が無いページも入る。
  console.log(`  掲載NGに当たったページ（U-NEXTの広告なし）: ${blocked.length}`)
  console.log(
    `  U-NEXT 掲載NGの一覧: ${Object.keys(unext.file.works ?? {}).length}件` +
      (unext.file.worksFetchedAt
        ? `（${unext.file.worksFetchedAt.slice(0, 10)} 取得）`
        : '（未取得。npm run unext:ng）'),
  )
  console.log(`  Hulu 掲載NGの一覧: ${hulu.ng.workCount}件`)
  if (hulu.ng !== EMPTY_NG && !hulu.narrowed) {
    console.log(
      '  ⚠ Hulu の一覧が TBS に絞れていません（data/unext-ng.json に worksByMenu が無い）。',
    )
    console.log(
      '    日テレ・FOD の作品でも Hulu の広告が止まります。npm run unext:ng で取り直すと絞られます。',
    )
  }

  /*
   * 一覧の古さ。**取り直しは人が思い出さないと走らない**ので、ここで言う。
   *
   * 45日にしているのは「月1回で足りる」という運用（12-4）に対して、
   * 1回飛ばしたら気づける幅。権利元の入れ替わりは緩やかなので、
   * これを過ぎたからといって即座に危険になるわけではない。
   */
  const fetchedAt = unext.file.worksFetchedAt ? Date.parse(unext.file.worksFetchedAt) : NaN
  const staleDays = Number.isNaN(fetchedAt) ? Infinity : (Date.now() - fetchedAt) / 86_400_000
  if (staleDays > 45) {
    const how = Number.isFinite(staleDays) ? `${Math.floor(staleDays)}日前` : '未取得'
    console.log(`  ⚠ 掲載NGの一覧が古いです（${how}）。npm run unext:ng で取り直してください。`)
  }
  console.log('')

  if (blocked.length > 0) {
    console.log('掲載NGに当たったページ（U-NEXTの広告は出していない）')
    console.log('※ もともと広告枠の無いページ（一覧・サイトマップ）も含む')
    for (const b of blocked.slice(0, 20)) console.log(`  ${b.page}  ← ${b.hit}`)
    if (blocked.length > 20) console.log(`  …ほか ${blocked.length - 20}ページ`)
    console.log('')
  }

  if (has('list') && withAd.length + withHuluAd.length > 0) {
    console.log('広告が出ているページ')
    for (const p of withAd) console.log(`  [U-NEXT] ${p}`)
    for (const p of withHuluAd) console.log(`  [Hulu]   ${p}`)
    console.log('')
  }

  const show = (level: 'error' | 'warn', rows: Issue[]) => {
    if (rows.length === 0) return
    console.log(level === 'error' ? `違反 ${rows.length}件` : `注意 ${rows.length}件`)
    for (const i of rows.slice(0, 40)) console.log(`  [${i.page}] ${i.message}`)
    if (rows.length > 40) console.log(`  …ほか ${rows.length - 40}件`)
    console.log('')
  }
  show('error', errors)
  show('warn', warns)

  if (errors.length > 0) {
    console.log('違反があります。**この状態で U-NEXT の広告を公開しないこと。**')
    process.exitCode = 1
    return
  }
  console.log(warns.length > 0 ? '違反はありません（注意のみ）。' : '違反も注意もありません。')
}

main()
