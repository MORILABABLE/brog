/**
 * 記事のセクション（`## ○月○日：…`）ごとに、本文へ挟む画像を生成する。
 *
 *   npm run sections            画像だけ作る（prebuild が自動で呼ぶ）
 *   npm run sections -- --write 記事の Markdown に画像の参照も挿し込む
 *   npm run sections -- --refresh    ポスターのキャッシュを無視して取り直す
 *   npm run sections -- --no-posters ポスターを使わず文字だけの版を作る
 *
 * ■ 出力は2種類ある
 *
 *   ポスターが揃った節 … `public/sections/posters/<節>-1.webp` … **絵だけ**。
 *                        枠も日付も見出しも描かない。導線リンクで包んで挿す
 *   ポスターが無い節   … `public/sections/tiles/<節>-1.webp` … **自前で描く生成ポスター**。
 *                        ジャンルの色と絵柄に作品名を組んだもの。下記
 *   どちらも作れない節 … `public/sections/<節>.jpg` … 従来の枠つきカード
 *
 * **絵に文字を描かないのは、すぐ上の小見出しと重複するから**（2026-08-25 の変更）。
 * 日付も主題も作品名も見出しに書いてある。画像にも入れると同じ文字が2回出る。
 * 文字情報は代替テキストと、すぐ下の表に残してある。
 *
 * ■ 配置は「小見出しの直後」
 * 見出し → 画像 → 表 → 地の文 の順。読者が節に入った瞬間に絵が目に入る。
 * 旧位置（表の直後）に残っている画像は `--write` が消してから入れ直す。
 *
 * ■ 作品ポスターについて
 * 配信API(Movie of the Night)の返すポスターを**ビルド時に取得**し、
 * 自分のドメインから配信している。再ホストは提供元に照会して許諾済み。
 * 経緯・取り直しの手順は posters.mjs の冒頭と docs/APPEARANCE.md の10〜11節。
 *
 * **作中キャプチャ（本編の場面写真）は使えない。** 著作権があり、
 * 広告のある当サイトでは引用の要件を満たさない。APIが返すのもポスターと
 * キーアートだけで、本編の画像は含まれない。
 *
 * ■ 生成ポスター（tiles）— ポスターが無い作品のための版
 *
 * **U-NEXT 由来の作品には画像が付いてこない**（収集がメニュー経由のため。実測で
 * 台帳776件すべて）。そこが従来は「文字だけのカード」に落ちていて、
 * 絵が1枚も無いうえに**導線リンクにもなっていなかった**。
 *
 * かわりに、ジャンルの色と絵柄（scripts/genre-art.mjs）に作品名を組んだ
 * 1枚をその場で描く。**第三者の権利が一切絡まない**ので、許諾も出典表記も
 * URLの失効も無く、どの作品にも必ず1枚用意できる。
 *
 * ★ **作品ポスターと同じ 480×720・同じレイアウト・同じ導線リンク**にしてある。
 *   記事の見た目が配信元によって食い違わない。CSSも共有する
 *   （styles/global.css の `/sections/posters/` と `/sections/tiles/`）。
 *
 * ★ **タイルには作品名を描く。** ポスターは絵柄で作品が分かるが、
 *   ジャンルの絵だけでは何のリンクか分からない。リンクである以上、
 *   押す前に行き先が分かる必要がある。「絵に文字を描かない」原則より
 *   こちらを優先した。**日付と節の主題は描かない**（見出しと重複するため）。
 *
 * ★ **どの外部データベースを使っても3割は必ずここに落ちる。** U-NEXT 台帳の
 *   実測で 音楽・ライブ111 + 舞台・演劇57 + 報道45 = 213件（27%）は、
 *   映画データベースに存在しない種類の作品。生成ポスターは代替ではなく土台。
 *
 * ■ 画像が取れなくても記事は崩れない
 * 署名付きURLの失効・CDN障害・オフラインで取得は必ず失敗しうる。
 * その節は**文字だけのカード**になる。作品の選定ロジックは共通なので、
 * 絵の有無で読者が受け取る情報は変わらない。
 *
 * ■ この画像が「表の焼き直し」にならないようにしていること
 * 節の全作品を並べると、すぐ上の表と同じものが二度出て情報が過密になる。
 * そこで**その節の地の文が実際に取り上げた作品**を先頭から1〜2本だけ大きく出し、
 * 残りは「ほかN作」に畳む。読者が読む直前の文章と画像の中身が一致する。
 *
 * ■ 文字はすべてパスに変換している
 * 理由と実測結果は make-cards.mjs の冒頭を参照。フォントも同じものを使う。
 *
 * ■ 画像名が位置ではなく見出しのハッシュなのは
 * 節を並べ替えても参照が壊れないようにするため。
 */
import sharp from 'sharp'
import opentype from 'opentype.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  PosterCache,
  isPlaceholder,
  loadManifest,
  loadWorkImages,
  posterLink,
  saveManifest,
} from './posters.mjs'
import { FALLBACK_GENRE, genreKeyOf, genreMotif, genreSvg } from './genre-art.mjs'
import { createSafeText, missingReport } from './font-safe.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')
const postsDir = join(root, 'src', 'content', 'posts')
/** 文字だけの版（枠つきのカード画像） */
const outDir = join(root, 'public', 'sections')
/**
 * ポスターの版。**別ディレクトリなのは CSS で区別するため。**
 * 枠つきのカードは幅いっぱい＋輪郭線、ポスターは絵だけで枠なし、と扱いが逆になる。
 * styles/global.css の `img[src^='/sections/posters/']` を参照。
 */
const posterDir = join(outDir, 'posters')
/**
 * 生成ポスターの版。**ポスターと分けてあるのは出どころが違うため。**
 * `posters/` は提供元から取得した第三者の画像、`tiles/` は自前で描いた絵。
 * CSS の扱いは同じ（どちらも枠なしの 2:3）だが、混ぜると
 * 「契約を終えたら消すもの」と「消さなくてよいもの」の区別が付かなくなる。
 */
const tileDir = join(outDir, 'tiles')
/**
 * 記事ごとのヘッダー画像。frontmatter の `heroImage` から参照される。
 * 記事一覧のカードの左サムネイルと、記事ページの見出し上に出る。
 */
const heroDir = join(root, 'public', 'heroes')

const W = 1200
/**
 * 文字だけの版の高さ。
 * **見出しを描かなくなったぶん低い**（2026-08-25 に 460 → 350）。
 * すぐ上に小見出しがあるので、画像にまで主題を書くと同じ文字が2回出る。
 * 描くのは「日付」と「取り上げた作品」だけにしてある。
 */
const H = 350
const WRITE = process.argv.includes('--write')
const REFRESH = process.argv.includes('--refresh')
const NO_POSTERS = process.argv.includes('--no-posters')
/** 生成ポスターも使わず、文字だけのカードまで落とす（従来の版の確認用） */
const NO_TILES = process.argv.includes('--no-tiles')

/**
 * 作品行の組版（**ポスターが無いときの版**）。カードの内側に必ず収まる値にすること。
 *   1行目 ROW_TOP、以降 ROW_STEP ずつ下がり、最後に「ほかN作」が1行入る。
 *   カード下端は H - 32 なので、ROW_TOP + MAX_HIGHLIGHT * ROW_STEP < H - 44 を守る。
 */
const ROW_TOP = 196
const ROW_STEP = 54

/** 日付バッジと作品行を分ける罫線の位置 */
const DIVIDER_Y = 140

/** 白いカードの位置。両方の版で共通 */
const CARD = { x: 40, y: 32, w: W - 80, h: H - 64 }
const PAD_X = CARD.x + 48

/**
 * 書き出すポスター1枚の大きさ。
 *
 * APIから来る元画像が 480×720（2:3）なので、同じ値にして拡大も切り取りも起こさない。
 * 表示側は CSS で高さを抑える（`max-height`）。画面上は約280px高になるので、
 * 高解像度ディスプレイでも粗くならない。
 */
const POSTER = { w: 480, h: 720 }

/**
 * 生成ポスター1枚の組版。**大きさはポスターと同じ**（レイアウトを共有するため）。
 *
 * ★ 表示は `max-height: 280px`。480幅の絵が画面上では約187px幅になるので、
 *   **ここの文字サイズは実寸の 0.39 倍で読まれる**。46px は約18px。
 *   これより小さくすると、長い題名の作品が読めなくなる。
 */
const TILE = {
  pad: 44,
  titleSize: 46,
  titleStep: 60,
  titleTop: 168,
  titleLines: 6,
  yearSize: 30,
  yearY: 648,
}

/** make-cards.mjs と同じ同梱フォント（SIL OFL 1.1 / scripts/fonts/OFL.txt） */
const font = {
  bold: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Bold.ttf')).buffer),
  regular: opentype.parse(readFileSync(join(here, 'fonts', 'ZenKakuGothicNew-Regular.ttf')).buffer),
}
/**
 * 同梱フォントに無い文字を、描ける文字に置き換える。
 * **測るときと描くときの両方に掛けている**（片方だけだと幅がずれて枠からはみ出す）。
 * 理由と実測は scripts/font-safe.mjs の冒頭。
 */
const safeText = createSafeText(font)


/**
 * 記事のヘッダー画像（frontmatter の `heroImage`）に使う作品を選ぶときの、
 * 記事タイトルとの一致とみなす最短の文字数。
 *
 * 短くしすぎると事故る。「日常」（2文字）のような作品名は、
 * 記事タイトルの地の文にたまたま出てくる。4文字あれば実データでは誤爆しない。
 *
 * ★ ただし**これ未満でも、区切りに挟まれて題名まるごとが出ていれば認める**
 *   （`isNamedWhole`）。「｜告白・来るとディア・ファミリー」の「告白」「来る」が
 *   これに当たる。2026-08-28 まではここで弾いていたため、
 *   **タイトルの先頭に置いた短い題名が候補にすら入らず**、
 *   後ろに書いた長い題名（ディア・ファミリー）の絵が選ばれていた。
 */
const HERO_MATCH_MIN = 4

/**
 * 短い題名を「記事タイトルが名指しした」と認めてよい区切り文字。
 *
 * 地の文に紛れ込んだ偶然の一致（「日常系アニメ」の中の「日常」）を落とし、
 * 作品名を並べた部分（「｜告白・来るとディア・ファミリー」）だけを拾うための境目。
 * 前後がこのどれか、または文字列の端であれば名指しとみなす。
 *
 * ★ 「と」も区切りに入れてある。タイトルの作品名は
 *   「A・BとC」の形で並べるため、これが無いと最後の1つ手前が拾えない。
 */
const HERO_NAME_EDGE = '｜|・、，,。．.／/「」『』（）()【】〔〕〜~と　 '

/**
 * 画像で大きく見せる作品数。
 *
 * 節の全作品を並べると、すぐ上の表と同じものが二度出るうえに情報が過密になる。
 * **その節の地の文が実際に取り上げた作品**を先頭から拾い、この数だけ見せる。
 * 残りは「ほかN作」に畳む。
 */
const MAX_HIGHLIGHT = 2

const NO_LINE_START = '、。，．・：；！？」』）］｝〉》”’ー〜%％'

/**
 * 見出しの先頭に付く日付。**複数日にまたがる見出しもある**
 * （例:「8月6日・8月10日：」「8月25日〜8月29日：」）。
 * ここで全部を掴んでおかないと、バッジに片方しか出ず、
 * 残りが見出し本文に居座って同じ日付が2回出る。
 */
const DATE_PREFIX = /^\d{1,2}月\d{1,2}日(?:\s*[・、,／/〜～―—-]\s*(?:\d{1,2}月)?\d{1,2}日)*/

function textPath(weight, text, x, y, size) {
  const f = font[weight]
  const path = new opentype.Path()
  let cx = x
  for (const ch of [...safeText(text)]) {
    const g = f.charToGlyph(ch)
    path.extend(g.getPath(cx, y, size))
    cx += (g.advanceWidth / f.unitsPerEm) * size
  }
  roundCommands(path)
  return { d: path.toPathData(2), width: cx - x }
}

/**
 * 座標を小数2桁に丸めてから toPathData() に渡す。**外すと文字が黒い塊になる。**
 * 理由は make-cards.mjs の同名関数に書いてある（opentype.js 2.0.0 の roundDecimal が
 * 小数部を指数表記の文字列にしてしまい NaN を返す）。直すときは両方直すこと。
 */
function roundCommands(path) {
  for (const c of path.commands) {
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (k in c) c[k] = Math.round(c[k] * 100) / 100
    }
  }
}

function textWidth(weight, text, size) {
  const f = font[weight]
  let w = 0
  for (const ch of [...safeText(text)]) w += (f.charToGlyph(ch).advanceWidth / f.unitsPerEm) * size
  return w
}

/**
 * 英数字。**この連なりの途中では改行しない。**
 *
 * 1文字ずつ折ると「モーニング娘｡ コンサートツアー200 / 6春」のように
 * 数字が割れる（実測）。日本語は1文字で折ってよいが、英数字は語として読むので、
 * 割れると読み手が一度つまずく。
 */
const WORD_CHAR = /[0-9A-Za-z]/

function wrap(weight, text, size, maxWidth, maxLines) {
  /*
   * ★ **ここで一度だけ置き換える。** 折り返しの判定に NO_LINE_START を使うので、
   *   行頭に来てはいけない記号（`〜` など）を**置き換えた後の姿で**見る必要がある。
   *   置き換え前の `～`(U+FF5E) のまま判定すると、行頭に来てしまう。
   */
  text = safeText(text)
  const lines = []
  let line = ''
  for (const ch of [...text]) {
    if (line !== '' && textWidth(weight, line + ch, size) > maxWidth && !NO_LINE_START.includes(ch)) {
      let head = line
      let carry = ch
      /*
       * 行末が英数字の連なりで、次の文字も英数字なら、**連なりごと次の行へ送る。**
       * ただし送り先でも収まらない長さ（長い英字列）なら送っても解決しないので
       * そのまま折る。行の全部が連なりのときも折る
       * （送ると行が空になり、先へ進めなくなる）。
       */
      if (WORD_CHAR.test(ch)) {
        const run = /[0-9A-Za-z]+$/.exec(head)?.[0]
        if (run && run.length < head.length && textWidth(weight, run + ch, size) <= maxWidth) {
          head = head.slice(0, -run.length)
          carry = run + ch
        }
      }
      lines.push(head)
      line = carry
      if (lines.length === maxLines) return lines
    } else {
      line += ch
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines
}

function ellipsize(weight, text, size, maxWidth) {
  if (textWidth(weight, text, size) <= maxWidth) return text
  let s = text
  while (s.length > 1 && textWidth(weight, s + '…', size) > maxWidth) s = s.slice(0, -1)
  return s + '…'
}

// --- 収集データ（公開年とジャンルを引くため） -----------------------------

/**
 * 収集ログから、作品名 → 公開年 / ジャンル を引けるようにする。
 *
 * **2つを別の Map にしているのは、揃っている率が違うから。**
 * 公開年は空のことがある（実測: U-NEXT の記事に出る160作のうち1作）が、
 * ジャンルは U-NEXT が公式のものを付けてくるので必ず入る。
 * 年が無くても生成ポスターは作れるように、片方だけで判断できる形にしてある。
 */
function loadWorkMeta() {
  const dir = join(repo, 'data', 'events')
  const years = new Map()
  const genres = new Map()
  if (!existsSync(dir)) return { years, genres }
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n')) {
      if (!line) continue
      const e = JSON.parse(line)
      const title = e.work.localizedTitle ?? e.work.title
      if (!title) continue
      if (e.work.year && !years.has(title)) years.set(title, e.work.year)
      if (e.work.genres?.length && !genres.has(title)) genres.set(title, e.work.genres)
    }
  }
  return { years, genres }
}

// --- 記事の解析 -----------------------------------------------------------

/**
 * 画像の行か。`![…](…)` と、リンクで包んだ `[![…](…)](…)` の両方を拾う。
 * ポスターにはアフィリエイトの導線を付けているので後者の形になる。
 */
function isImageLine(line) {
  return typeof line === 'string' && (line.startsWith('![') || line.startsWith('[!['))
}

/** `| a | b | c |` を列の配列にする */
function cells(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/**
 * 画像を挟む対象の「小段落」を取り出す。
 *
 * 単位は**見出しではなく表**。記事によって
 *   - 日付見出しの直下に表が1つ（配信開始・配信終了済み）
 *   - 日付見出しの下に ### の小見出しがあり、その下に表（配信終了予定）
 * と構造が違うため、表を起点にして直近の見出しを主題として使う。
 *
 * 列の並びも記事によって違う（4列「終了日/作品/評価/サービス」と
 * 3列「作品/公開年/評価」）ので、**見出し行から「作品」列を探す**。
 *
 * 対象は日付の `##` 見出しの配下だけ。全作品リストやまとめには入れない。
 *
 * ■ 行番号を3つ返している理由
 * 画像の挿し込み位置を「表の直後」から「**見出しの直後**」に移した（2026-08-25）。
 * 過去に書いた記事には旧位置の画像が残っているので、
 *   headingLine  … いま入れる場所
 *   imageLine    … 新位置に既にある画像（差し替える）
 *   staleImageLine … 旧位置に残っている画像（消す）
 * の3つを持って、再実行しても同じ結果になるようにしている。
 */
/**
 * 記事の**すべての表**から作品行を拾う。見出しの形を問わない。
 *
 * `parseBlocks` が「`## ◯月◯日…` の節」しか見ないのに対して、こちらは
 * 「作品」列を持つ表を上から順に集めるだけ。**ヘッダー画像を選ぶためだけに使う。**
 * 本文にセクション画像を挿す判断には使わない（挿す位置は節が決めるため）。
 *
 * 返す形は `parseBlocks` と同じ `{ rows }` の配列にしてある。
 * `heroCandidates` / `articleGenreKeys` が両方をそのまま受け取れるようにするため。
 */
function workTables(md) {
  const lines = md.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue
    const start = i
    let j = i
    while (j < lines.length && lines[j].startsWith('|')) j++
    i = j - 1

    const header = cells(lines[start])
    const titleCol = header.findIndex((c) => c === '作品')
    if (titleCol < 0) continue
    const ratingCol = header.findIndex((c) => c.includes('評価'))

    const rows = []
    for (const l of lines.slice(start + 2, j)) {
      const c = cells(l)
      const title = c[titleCol]
      if (title) rows.push({ title, rating: ratingCol >= 0 ? (c[ratingCol] ?? '') : '' })
    }
    // ★ `prose` を空で持たせる。`pickHighlights` が地の文を見るので、
    //   無いと落ちる。空なら評価の高い順に落ちるだけで、候補として十分。
    if (rows.length > 0) out.push({ rows, prose: '' })
  }
  return out
}

function parseBlocks(md) {
  const lines = md.split('\n')
  const out = []
  let dateHeading = null // 直近の `## ○月○日…`
  let dateHeadingLine = -1
  let subHeading = null // その下の `### …`
  let subHeadingLine = -1

  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^## +(.*)$/)
    if (h2) {
      const t = h2[1].trim()
      dateHeading = /^\d{1,2}月\d{1,2}日/.test(t) ? t : null
      dateHeadingLine = i
      subHeading = null
      subHeadingLine = -1
      continue
    }
    const h3 = lines[i].match(/^### +(.*)$/)
    if (h3) {
      subHeading = h3[1].trim()
      subHeadingLine = i
      continue
    }
    if (!lines[i].startsWith('|') || !dateHeading) continue

    // 表の範囲
    const tableStart = i
    let j = i
    while (j < lines.length && lines[j].startsWith('|')) j++
    const tableEnd = j - 1
    i = tableEnd

    const header = cells(lines[tableStart])
    const titleCol = header.findIndex((c) => c === '作品')
    if (titleCol < 0) continue
    const ratingCol = header.findIndex((c) => c.includes('評価'))

    const rows = []
    // 1行目は見出し、2行目は区切り
    for (const l of lines.slice(tableStart + 2, tableEnd + 1)) {
      const c = cells(l)
      const title = c[titleCol]
      if (title) rows.push({ title, rating: ratingCol >= 0 ? (c[ratingCol] ?? '') : '' })
    }
    if (rows.length === 0) continue

    const headingLine = subHeadingLine >= 0 ? subHeadingLine : dateHeadingLine

    // 旧位置（表の直後）に残っている画像。見つけたら消す。
    let k = tableEnd + 1
    while (k < lines.length && lines[k].trim() === '') k++
    const staleImageLine = isImageLine(lines[k]) ? k : -1

    // 新位置（見出しの直後）に既にある画像。あれば差し替える。
    let h = headingLine + 1
    while (h < lines.length && lines[h].trim() === '') h++
    const imageLine = isImageLine(lines[h]) ? h : -1

    // 表のあとから次の見出し／次の表までが、その小段落の地の文
    let p = staleImageLine >= 0 ? staleImageLine + 1 : tableEnd + 1
    const prose = []
    while (p < lines.length && !/^#{2,3} /.test(lines[p]) && !lines[p].startsWith('|')) {
      if (lines[p].trim()) prose.push(lines[p])
      p++
    }

    out.push({
      dateLabel: DATE_PREFIX.exec(dateHeading)[0],
      heading: subHeading ?? dateHeading,
      headingLine,
      imageLine,
      staleImageLine,
      tableEnd,
      rows,
      prose: prose.join('\n'),
    })
    subHeading = null
    subHeadingLine = -1
  }
  return out
}

/**
 * 画像で大きく見せる作品を選ぶ。
 *
 * 地の文が触れた作品を**登場順に**拾う。読者が読む直前の文章と、
 * 画像に出る作品が一致するのが狙い。
 * 地の文がどれにも触れていない節（表だけの節）は評価の高い順で代替する。
 */
function pickHighlights(section) {
  const mentioned = section.rows
    .map((r) => ({ ...r, at: section.prose.indexOf(r.title) }))
    .filter((r) => r.at >= 0)
    .sort((a, b) => a.at - b.at)

  if (mentioned.length > 0) return mentioned.slice(0, MAX_HIGHLIGHT)

  return [...section.rows]
    .sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0))
    .slice(0, MAX_HIGHLIGHT)
}

// --- 画像 -----------------------------------------------------------------

/**
 * 文字だけの版の SVG を組む。**ポスターが取れなかった節だけがこれになる。**
 *
 * ポスターがある節は絵をそのまま置くので、この関数を通らない。
 * 契約を終えたときはサイト全体がこの版に戻るので、**消さないこと。**
 */
function buildSvg(section, years) {
  const dateLabel = section.dateLabel

  // 地の文が取り上げた作品を大きく見せる。残りは件数だけ添える。
  const shown = pickHighlights(section).map((r) => ({ ...r, year: years.get(r.title) }))
  const rest = section.rows.length - shown.length

  const padX = PAD_X
  const innerW = CARD.w - 96

  const parts = []
  parts.push(`<rect width="${W}" height="${H}" fill="#1b3a6e"/>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#dots)"/>`)
  parts.push(
    `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="20" fill="#ffffff"/>`,
  )

  // 日付バッジ
  if (dateLabel) {
    const t = textPath('bold', dateLabel, 0, 0, 24)
    parts.push(`<rect x="${padX}" y="66" width="${(t.width + 36).toFixed(1)}" height="42" rx="21" fill="#e8f0fe"/>`)
    parts.push(`<path d="${textPath('bold', dateLabel, padX + 18, 95, 24).d}" fill="#1a5fd0"/>`)
  }

  /*
   * ★ 節の主題（見出し）は**描かない**。
   *   この画像は小見出しの直後に入るので、同じ文字がすぐ上に出ている。
   *   ここに描くのは、見出しに必ずしも書かれていない
   *   「取り上げた作品と公開年」だけにする（2026-08-25 の変更）。
   *   見出しを含む説明は代替テキスト（altFor）に入っている。
   */
  parts.push(
    `<line x1="${padX}" y1="${DIVIDER_Y}" x2="${W - padX}" y2="${DIVIDER_Y}" stroke="#e3e6ea" stroke-width="2"/>`,
  )

  // 取り上げた作品。公開年は右端に寄せる。
  const titleSize = 40
  shown.forEach((w, i) => {
    const y = ROW_TOP + i * ROW_STEP
    const yearText = w.year ? `${w.year}年` : ''
    const yearW = yearText ? textWidth('bold', yearText, 26) : 0
    const title = ellipsize('bold', w.title, titleSize, innerW - yearW - 32)
    parts.push(`<path d="${textPath('bold', title, padX, y, titleSize).d}" fill="#1a1d21"/>`)
    if (yearText) {
      parts.push(
        `<path d="${textPath('bold', yearText, W - padX - yearW, y, 26).d}" fill="#1f6feb"/>`,
      )
    }
  })

  if (rest > 0) {
    const y = ROW_TOP + shown.length * ROW_STEP - 8
    parts.push(`<path d="${textPath('regular', `ほか${rest}作`, padX, y, 26).d}" fill="#5c646e"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="#aed0ff" fill-opacity="0.13"/>
    </pattern>
  </defs>
  ${parts.join('\n  ')}
</svg>`
}

/**
 * 生成ポスター1枚の SVG。**ポスターが取れない作品のための版。**
 *
 * ジャンルの色と絵柄（genre-art.mjs）を土台に、作品名と公開年を組む。
 * 第三者の画像を1枚も使っていないので、許諾も出典表記も期限も無い。
 *
 * ★ 描くのは**作品名と年だけ**。日付と節の主題は描かない。
 *   すぐ上の小見出しに書いてあるので、ここに入れると同じ文字が2回出る
 *   （ポスターの版と同じ考え方）。
 *
 * ★ 絵柄は**透かし**として敷く。主役は題名で、絵柄は「何の種類の作品か」を
 *   色と形で添えるだけ。濃くすると題名が読めなくなる。
 */
function buildTileSvg(title, year, genreKey) {
  const { path, hue } = genreMotif(genreKey)
  // 彩度と明度は全ジャンル共通で、**色相だけを変える**（genreSvg と同じ約束）。
  // 何枚並べても1組のデザインに見える。
  const top = `hsl(${hue} 34% 30%)`
  const bottom = `hsl(${hue} 40% 19%)`
  const ink = `hsl(${hue} 60% 96%)`
  const sub = `hsl(${hue} 45% 74%)`
  const art = `hsl(${hue} 52% 74%)`
  const motif = path.replaceAll('CURRENT', art)

  const innerW = POSTER.w - TILE.pad * 2
  const lines = wrap('bold', title, TILE.titleSize, innerW, TILE.titleLines)
  /*
   * wrap() は入りきらないぶんを**黙って捨てる**。
   * 捨てたことが読者に分かるよう、最後の行を「…」で終わらせる。
   * 題名が途中で切れているのに切れて見えないのが一番まずい。
   */
  if ([...lines.join('')].length < [...title].length && lines.length > 0) {
    const dots = textWidth('bold', '…', TILE.titleSize)
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = ellipsize('bold', last, TILE.titleSize, innerW - dots) + '…'
  }

  const parts = []
  parts.push(`<rect width="${POSTER.w}" height="${POSTER.h}" fill="url(#bg)"/>`)
  parts.push(
    `<g transform="translate(120 300) scale(3.2)" fill="none" stroke="${art}"` +
      ` stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.16">${motif}</g>`,
  )
  // 題名の上の短い罫。文字だけの版の区切り線と同じ役目
  parts.push(
    `<rect x="${TILE.pad}" y="96" width="64" height="6" rx="3" fill="${sub}" opacity="0.85"/>`,
  )
  lines.forEach((line, i) => {
    const y = TILE.titleTop + i * TILE.titleStep
    parts.push(`<path d="${textPath('bold', line, TILE.pad, y, TILE.titleSize).d}" fill="${ink}"/>`)
  })
  if (year) {
    const d = textPath('bold', `${year}年`, TILE.pad, TILE.yearY, TILE.yearSize).d
    parts.push(`<path d="${d}" fill="${sub}"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${POSTER.w}" height="${POSTER.h}" viewBox="0 0 ${POSTER.w} ${POSTER.h}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
  </linearGradient></defs>
  ${parts.join('\n  ')}
</svg>`
}

/** 節を一意に指す8桁。見出しから作るので、節を並べ替えても参照が壊れない。 */
function hashFor(slug, heading) {
  return createHash('sha1').update(`${slug}\n${heading}`).digest('hex').slice(0, 8)
}

/** 文字だけの版のファイル名 */
function nameFor(slug, heading) {
  return `${slug}-${hashFor(slug, heading)}.jpg`
}

/** ポスター1枚のファイル名。節の中の並び順で連番にする。 */
function posterNameFor(slug, heading, index) {
  return `${slug}-${hashFor(slug, heading)}-${index + 1}.webp`
}

/**
 * 生成ポスター1枚のファイル名。**ポスターと同じ形**にしてある。
 * ディレクトリが違うので衝突しない（`tiles/` と `posters/`）。
 */
function tileNameFor(slug, heading, index) {
  return `${slug}-${hashFor(slug, heading)}-${index + 1}.webp`
}

/**
 * 文字だけの版の代替テキスト。**画像に描いてある内容をそのまま書く。**
 */
function altFor(section, years) {
  const shown = pickHighlights(section).map((r) => labelFor(r.title, years))
  const rest = section.rows.length - shown.length
  return `${section.heading}。${shown.join('、')}${rest > 0 ? `ほか${rest}作` : ''}`
}

/** 「作品名（公開年）」。ポスターの代替テキストに使う。 */
function labelFor(title, years) {
  const y = years.get(title)
  return y ? `${title}（${y}年）` : title
}

// --- 記事のヘッダー画像（heroImage） --------------------------------------

/** frontmatter を雑に読む。**書き換えはしない**ので、YAMLパーサは持ち込まない。 */
function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return null
  const body = m[1]
  const read = (key) => {
    const hit = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(body)
    if (!hit) return undefined
    return hit[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return {
    title: read('title') ?? '',
    heroImage: read('heroImage'),
    /** 閉じの `---` の行番号。ここの直前に足せば必ず frontmatter の中に入る */
    endLine: md.slice(0, m.index + m[0].length).split('\n').length - 1,
  }
}

/** その位置の一致が、前後を区切り文字（または文字列の端）で挟まれているか。 */
function isNamedWhole(articleTitle, at, len) {
  const before = at === 0 ? '' : articleTitle[at - 1]
  const after = at + len >= articleTitle.length ? '' : articleTitle[at + len]
  return (
    (before === '' || HERO_NAME_EDGE.includes(before)) &&
    (after === '' || HERO_NAME_EDGE.includes(after))
  )
}

/**
 * 記事タイトルの中で作品名が名指しされている位置と強さ。無ければ null。
 *
 * 記事タイトルに作品名がそのまま入っているとは限らない。
 * 「クレヨンしんちゃん劇場版」に対して作品名は
 * 「クレヨンしんちゃん ブリブリ王国の秘宝」のように**後ろが長い**。
 * そこで作品名を後ろから削りながら、記事タイトルに含まれる
 * いちばん長い前方一致を探す。長く一致したものほど強い。
 *
 * ★ `HERO_MATCH_MIN` 未満の一致は、**題名まるごとが区切りに挟まれて出ている**
 *   ときだけ認める（2026-08-28）。前方一致の途中では認めない。
 *   「来る」で認めてしまうと、別作品「来るべき明日」も同じ2文字で引っかかる。
 *
 * @returns {{ at: number, score: number } | null}
 *   `at` … 記事タイトルの中で名前が出てくる位置。**採用順はこれで決める**
 *   `score` … 一致した文字数。同じ位置に複数並んだときの絞り込みに使う
 */
function titleMatch(articleTitle, workTitle) {
  const chars = [...workTitle]
  for (let n = chars.length; n >= HERO_MATCH_MIN; n--) {
    const at = articleTitle.indexOf(chars.slice(0, n).join(''))
    if (at >= 0) return { at, score: n }
  }
  // 短い題名。まるごと・区切り付きのときだけ。1文字は誤爆が防げないので対象外。
  if (chars.length >= 2 && chars.length < HERO_MATCH_MIN) {
    const at = articleTitle.indexOf(workTitle)
    if (at >= 0 && isNamedWhole(articleTitle, at, workTitle.length)) {
      return { at, score: chars.length }
    }
  }
  return null
}

/**
 * ヘッダー画像の候補を、**使いたい順**に返す。
 *
 *   1. 記事タイトルが名指しした作品（**タイトルに出てくる順**）
 *   2. 記事に最初に出てくる作品（＝いちばん上の節で取り上げた作品）
 *
 * 実際にどれを使うかは、ポスターが取れるかどうかで決まる。
 * 呼び出し側が先頭から試して、最初に取れたものを採用する。
 *
 * ★ 1の並びは**一致の長さではなくタイトルでの登場順**（2026-08-28 に変更）。
 *   タイトルの作品名は編集上の優先順で並べている。
 *   「｜告白・来るとディア・ファミリー」なら主役は先頭の「告白」で、
 *   長さ順にすると最後に書いた「ディア・ファミリー」が勝ってしまう。
 *
 * ★ **記事の全作品に落ちる3段目は置かない**（2026-08-28 に削除）。
 *   U-NEXT の作品にはポスターが無い（配信情報の出どころが別で画像を持たない）ため、
 *   3段目があると候補を最後まで舐めて、**記事が一言も触れていない作品**の絵を
 *   ヘッダーに据えてしまう。実際に U-NEXT の新着記事が、別記事と同じ
 *   「ディア・ファミリー」を使っていた。
 *   **候補が尽きた記事はジャンル別の汎用画像に落とす**（呼び出し側）。
 */
function heroCandidates(sections, articleTitle) {
  const seen = new Set()
  const all = []
  for (const [order, s] of sections.entries()) {
    for (const r of s.rows) {
      if (seen.has(r.title)) continue
      seen.add(r.title)
      all.push({ title: r.title, order })
    }
  }

  const matched = all
    .map((c) => ({ ...c, m: titleMatch(articleTitle, c.title) }))
    .filter((c) => c.m)
    // 登場順 → 同じ位置なら長い一致（＝より具体的な題名）→ 記事での出現順
    .sort((a, b) => a.m.at - b.m.at || b.m.score - a.m.score || a.order - b.order)

  // 次点。記事の先頭の節が取り上げた作品を、地の文の順で。
  const firstShown = sections.length > 0 ? pickHighlights(sections[0]).map((r) => r.title) : []

  const out = []
  for (const t of [...matched.map((m) => m.title), ...firstShown]) {
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 記事を代表するジャンルの key を、**その記事の作品に多い順**で返す。
 *
 * ポスターが1枚も取れない記事のヘッダーに使う汎用画像を選ぶためのもの。
 * 作品ごとに `genreKeyOf()` を通してから数える。
 * **ジャンル名の集合をまとめて `genreKeyOf()` に渡してはいけない。**
 * あれは rank の小さいものが勝つので、記事のどこかに1本ホラーがあるだけで
 * 記事全体がホラー扱いになる。ここで知りたいのは「多数派はどれか」。
 *
 * 同数のときは記事に先に出てくるほうを優先する（並びが実行ごとに揺れないように）。
 */
function articleGenreKeys(sections, genres) {
  const count = new Map()
  const firstAt = new Map()
  let i = 0
  const seen = new Set()
  for (const s of sections) {
    for (const r of s.rows) {
      if (seen.has(r.title)) continue
      seen.add(r.title)
      const g = genres.get(r.title)
      if (!g?.length) continue
      const key = genreKeyOf(g)
      count.set(key, (count.get(key) ?? 0) + 1)
      if (!firstAt.has(key)) firstAt.set(key, i++)
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || firstAt.get(a[0]) - firstAt.get(b[0]))
    .map(([key]) => key)
}

// --- 実行 -----------------------------------------------------------------

mkdirSync(posterDir, { recursive: true }) // outDir も一緒にできる
mkdirSync(tileDir, { recursive: true })
mkdirSync(heroDir, { recursive: true })
const { years, genres } = loadWorkMeta()

/**
 * 画像の出どころは2つある。**期限が先のほうを採る。**
 *   収集ログ(data/events)      … 収集した時点の署名付きURL
 *   台帳(data/image-manifest)  … refresh:images で取り直した新しいURL
 * 取り直した直後は台帳のほうが新しく、まだ取り直していなければ収集ログしかない。
 */
const workImages = NO_POSTERS ? new Map() : loadWorkImages(repo)
const manifest = loadManifest(repo)
const manifestByTitle = new Map(
  Object.values(manifest.works ?? {}).map((w) => [w.title, w]),
)
const posters = NO_POSTERS ? null : new PosterCache(repo, { force: REFRESH })

/** サイトが実際に使った作品だけを台帳に残す。取り直しの対象を絞るため。 */
const usedWorks = {}

function imageFor(title) {
  const found = [manifestByTitle.get(title), workImages.get(title)]
    .filter((w) => w?.url && !isPlaceholder(w.url))
    .sort((a, b) => (b.expiresAt ?? '').localeCompare(a.expiresAt ?? ''))[0]
  if (found) {
    usedWorks[found.id] = {
      id: found.id,
      title: found.title,
      url: found.url,
      expiresAt: found.expiresAt,
    }
  }
  return found
}

let images = 0
let inserted = 0
let withPosters = 0
let withTiles = 0
let withText = 0
let heroes = 0
let heroesWritten = 0
let genericHeroes = 0

/**
 * すでにどれかの記事のヘッダー画像に使った作品。
 *
 * **同じ絵を2本の記事に出さない。** 記事一覧はカードが縦に並ぶので、
 * 隣り合う2枚が同じ絵だと「更新されていない」ように見える
 * （2026-08-28 に U-NEXT と邦画の新着記事で実際に起きた）。
 * 取られていたら次の候補へ送る。候補が尽きた記事は絵なしになる。
 */
const usedHeroWorks = new Set()

/**
 * すでに汎用画像として使ったジャンル。
 *
 * 汎用画像はジャンルごとに1枚しか絵柄が無いので、
 * 素直に多数派を採ると、ポスターの無い記事どうしで同じ絵になりうる。
 * 取られていたら、その記事の2番目に多いジャンルへずらす。
 */
const usedHeroGenres = new Set()

for (const file of readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
  const slug = file.replace(/\.md$/, '')
  const path = join(postsDir, file)
  let md = readFileSync(path, 'utf8')
  const sections = parseBlocks(md)
  /*
   * ヘッダー画像を選ぶための作品リスト。
   *
   * ★ **節（`parseBlocks`）と分けてある。** 節は `## ◯月◯日…` で始まる見出しだけを
   *   拾う決まりで、そこに本文中のセクション画像を挿している。
   *   シリーズ記事（`--type series`）は**日付で始まる見出しを持たない**
   *   （保存版なので、見出しに日付を書かないと決めてある）。
   *   節が0件だからといって記事ごと飛ばすと、**カードの絵だけが付かない記事**ができる。
   *
   * ★ セクション画像の対象は広げない。日付見出しを持つ記事では
   *   「全終了作品リスト」のような節に**わざと画像を入れていない**ので、
   *   節の判定を緩めると既存記事の見た目が変わる。
   */
  const heroBlocks = sections.length > 0 ? sections : workTables(md)
  if (sections.length === 0 && heroBlocks.length === 0) continue

  /** 節ごとの挿し込む1行。生成の結果（ポスターが揃ったか）で形が変わる。 */
  const refs = new Map()

  for (const s of sections) {
    const shown = pickHighlights(s)

    /*
     * ポスターは**その節の全員ぶん揃ったときだけ**使う。
     * 1枚だけ欠けた状態で並べると、片方だけ絵という中途半端な見た目になる。
     * 揃わない節は文字だけの版に戻す（情報量は変わらない）。
     */
    let arts = []
    if (posters) {
      arts = await Promise.all(
        shown.map((w) => {
          const src = imageFor(w.title)
          return src ? posters.poster(src.url, POSTER.w, POSTER.h, { label: w.title }) : null
        }),
      )
      if (!(arts.length > 0 && arts.every(Boolean))) arts = []
    }

    /*
     * ポスターが無い節を**生成ポスター**に落とせるか。
     * **節の全員ぶんジャンルが引けるときだけ**使う。ポスターの版と同じ規律で、
     * 1枚だけ欠けた中途半端な並びを作らない。
     *
     * 引けないのは、表の作品名が収集ログのどれとも一致しないとき（人が記事を
     * 手直しして題名が変わった、など）。その節は従来どおり文字だけのカードに戻る。
     */
    const tileable =
      !NO_TILES &&
      arts.length === 0 &&
      shown.length > 0 &&
      shown.every((w) => genres.has(w.title))

    if (arts.length > 0) {
      /*
       * ポスターがある節は**絵だけ**を置く。枠も日付も見出しも描かない。
       * すぐ上の小見出しに同じ日付と主題が書いてあるので、
       * 画像にも入れると同じ文字が2回出て冗長になる（2026-08-25 の変更）。
       * 文字情報は代替テキストと、すぐ下の表に残っている。
       */
      const links = []
      for (const [i, buf] of arts.entries()) {
        const name = posterNameFor(slug, s.heading, i)
        writeFileSync(join(posterDir, name), buf)
        const label = labelFor(shown[i].title, years)
        // 導線リンク。トラッキングIDはビルド時に rehype-affiliate が付ける。
        links.push(`[![${label}](/sections/posters/${name})](${posterLink(shown[i].title)})`)
        images++
      }
      refs.set(s.heading, links.join(' '))
      withPosters++
    } else if (tileable) {
      /*
       * 生成ポスター。**ポスターの版と1行も違わない形で挿す**
       * （同じ大きさ・同じ並べ方・同じ導線リンク）。読者から見て、
       * 配信元による記事の作りの違いが出ない。
       */
      const links = []
      for (const [i, w] of shown.entries()) {
        const svg = buildTileSvg(w.title, years.get(w.title), genreKeyOf(genres.get(w.title)))
        const buf = await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer()
        const name = tileNameFor(slug, s.heading, i)
        writeFileSync(join(tileDir, name), buf)
        const label = labelFor(w.title, years)
        links.push(`[![${label}](/sections/tiles/${name})](${posterLink(w.title)})`)
        images++
      }
      refs.set(s.heading, links.join(' '))
      withTiles++
    } else {
      const name = nameFor(slug, s.heading)
      await sharp(Buffer.from(buildSvg(s, years, 0)))
        .jpeg({ quality: 88, mozjpeg: true })
        .toFile(join(outDir, name))
      refs.set(s.heading, `![${altFor(s, years)}](/sections/${name})`)
      images++
      withText++
    }
  }

  /*
   * 記事のヘッダー画像。
   *
   *   1. 記事タイトルと一致する作品のポスター
   *   2. 取れなければ、記事に最初に出てくる作品のポスター
   *
   * **人が指定した heroImage は絶対に触らない。**
   * 自分で入れた `/heroes/<スラッグ>.webp` だけを作り直す。
   * 気に入らない絵は frontmatter を書き換えれば固定できる（好きな画像を
   * `site/public/` に置いて、そのパスを書けばよい）。
   */
  const fm = frontmatter(md)
  const heroPath = `/heroes/${slug}.webp`
  let heroRef = null

  if (posters && fm && (!fm.heroImage || fm.heroImage === heroPath)) {
    for (const title of heroCandidates(heroBlocks, fm.title)) {
      if (usedHeroWorks.has(title)) continue
      const src = imageFor(title)
      if (!src) continue
      const buf = await posters.poster(src.url, POSTER.w, POSTER.h, { label: title })
      if (!buf) continue
      writeFileSync(join(heroDir, `${slug}.webp`), buf)
      usedHeroWorks.add(title)
      heroRef = heroPath
      heroes++
      break
    }
    /*
     * ポスターが1枚も取れなかった記事は、**ジャンル別の汎用画像**にする。
     *
     * U-NEXT だけの記事がこれに当たる（配信情報の出どころが別で画像を持たない）。
     * ここを空にすると一覧でその記事だけ絵の無いカードになり、
     * 記事が抜け落ちたように見える。表の作品サムネイルが同じ事情で
     * ジャンル汎用画像に落ちるので（13節）、**同じ絵柄・同じ理屈**でそろえる。
     *
     * ★ 幾何学図形をその場で描くだけなので、許諾も出典表記も要らず、
     *   URLの失効も無い。定義は scripts/genre-art.mjs の1か所。
     * ★ 縦横比は `POSTER`（2:3）と `genreSvg` の viewBox（100×150）で一致させてある。
     *   ここを片方だけ変えると余白が入る。
     */
    if (!heroRef) {
      const keys = articleGenreKeys(heroBlocks, genres)
      const key = keys.find((k) => !usedHeroGenres.has(k)) ?? keys[0] ?? FALLBACK_GENRE
      const svg = genreSvg(key, POSTER.w, POSTER.h)
      const buf = await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer()
      writeFileSync(join(heroDir, `${slug}.webp`), buf)
      usedHeroGenres.add(key)
      heroRef = heroPath
      heroes++
      genericHeroes++
    }
  }

  if (!WRITE) continue

  // 後ろの節から処理する。前から触ると行番号がずれるため。
  const lines = md.split('\n')
  for (const s of [...sections].reverse()) {
    const ref = refs.get(s.heading)
    if (!ref) continue

    /*
     * 旧位置（表の直後）に残っている画像を先に消す。
     * **消す→入れる の順でなければならない。** 消す行は入れる行より下にあるので、
     * 先に入れると行番号がずれて別の行を消してしまう。
     */
    if (s.staleImageLine >= 0) {
      const blankAfter = lines[s.staleImageLine + 1]?.trim() === ''
      lines.splice(s.staleImageLine, blankAfter ? 2 : 1)
    }

    if (s.imageLine >= 0) {
      if (lines[s.imageLine] === ref && s.staleImageLine < 0) continue
      lines[s.imageLine] = ref
    } else {
      lines.splice(s.headingLine + 1, 0, '', ref)
    }
    inserted++
  }

  /*
   * frontmatter は**最後に触る**。ここは記事の先頭なので、
   * 先に1行足すと上で数えた節の行番号がすべて1つずれる。
   */
  /*
   * ★ `heroRef` が無いときは**何もしない**。行を消しにいかないこと。
   *   `--no-posters` では上のブロックごと飛ぶので heroRef が付かない。
   *   ここで「絵が無い＝行を取り下げる」と書くと、そのフラグを付けた1回で
   *   全記事の heroImage が消える。絵を用意できない記事は上で汎用画像に落ちる。
   */
  if (heroRef && fm) {
    const at = lines.findIndex((l, i) => i < fm.endLine && /^heroImage:/.test(l))
    const line = `heroImage: '${heroRef}'`
    if (at >= 0) {
      if (lines[at] !== line) {
        lines[at] = line
        heroesWritten++
      }
    } else {
      lines.splice(fm.endLine, 0, line)
      heroesWritten++
    }
  }

  const next = lines.join('\n')
  if (next !== md) {
    writeFileSync(path, next)
    md = next
  }
}

console.log(
  `セクション画像: ${images}枚を生成` +
    `（ポスターの節 ${withPosters} / 生成ポスターの節 ${withTiles} / 文字だけの節 ${withText}）` +
    (WRITE ? ` / 参照 ${inserted}件を記事に反映` : ''),
)
console.log(
  `ヘッダー画像: ${heroes}本の記事に用意（うち汎用画像 ${genericHeroes}本）` +
    (WRITE ? ` / frontmatter ${heroesWritten}件を更新` : ''),
)
/*
 * フォントに無い文字があれば最後に出す。**黙って〓になるのを防ぐため。**
 * 出たら scripts/font-safe.mjs の FOLD に寄せ先を足すか、フォントを見直す。
 */
{
  const report = missingReport(safeText.missing)
  if (report) console.log(report)
}


if (posters) {
  posters.report()
  // 台帳は「サイトが使った作品」だけに絞って書き直す。
  // 使わなくなった作品を残すと、取り直し(refresh:images)が無駄にAPIを叩く。
  saveManifest(repo, usedWorks)
}
