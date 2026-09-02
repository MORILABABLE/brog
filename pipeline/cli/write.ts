/**
 * 記事を生成する。
 *
 * ── どの記事が作れるかを見る
 *   npm run write -- --list
 *
 * ── A. API で生成（課金あり）
 *   npm run write -- --type arrivals --genre anime
 *
 * ── B. このターミナル（Claude Code等）で生成（API課金なし）
 *   npm run write -- --type arrivals --genre anime --emit
 *   （prompt.md を読んで記事を書き、data/draft/response.md に保存）
 *   npm run write -- --apply    → 検証して site/ に書き出す
 *
 *   スラッシュコマンド /article で上記を自動化できる。
 *
 * ── C. プロンプトの確認だけ（無料）
 *   npm run write -- --type arrivals --genre anime --dry-run
 *
 * ── D. 書き直しどきの記事（見放題終了予定 → 見放題終了 など）
 *   npm run write -- --refresh            どれが書き直しどきかを並べる
 *   npm run write -- --refresh --emit     いちばん急ぐ1本のプロンプトを書き出す
 *   npm run write -- --register --type series --slug conan-movies …
 *                                         公開済みの記事を控えに登録する
 *   スラッシュコマンド /refresh が上をまとめて回す。
 *
 * ★ **コマンドは1行で書くこと。** 行末の `\` は PowerShell では次の行に続かず、
 *   2行目以降のフラグが落ちたまま実行される（下の `assertNoLineContinuation`）。
 *
 * ■ なぜ分割するか
 * 検証・frontmatter組み立て・書き出しは、どの方式でも共通の処理。
 * 「プロンプトを作る」と「応答を適用する」に分ければ、
 * 生成手段だけを差し替えられる。品質ゲートはどの経路でも必ず通る。
 *
 * ■ 記事タイプはここに書かない
 * どんな記事があるかはテーマパックの `article-types/index.ts` が決める。
 * この CLI は記事タイプの中身を知らないまま、一覧・選択・実行だけを担う。
 * 記事を1種類増やしてもこのファイルは変わらない。
 *
 * ■ ショート動画の台本（2026-08-25 追加）
 * `buildShortPrompt` を実装した記事タイプは、記事と同時に台本のたたき台を作る。
 *   --emit  … prompt.md の末尾に台本の指示が付く
 *   --apply … data/draft/short.md があれば shorts/<スラッグ>.md に書き出す
 * **台本は記事の品質ゲートを通らない**（別ファイル・検査はすべて warn）。
 * 台本の不備で記事の公開が止まるのは優先順位が逆なので、そう作ってある。
 * B（LLM API）経路では台本を作らない。/article だけが作る。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadArticleTypes, loadTheme, type Theme } from '../theme.ts'
import { loadLedger, readAllEvents, saveLedger, type Ledger } from '../core/events.ts'
import {
  currentYearMonth,
  daysUntil,
  formatIsoDate,
  formatMonthDay,
  previousYearMonth,
} from '../core/datetime.ts'
import {
  ARTICLE_LOG_PATH,
  loadArticleLog,
  recordArticle,
  rewriteCommand,
  shellValue,
  type ArticleRecord,
} from '../core/article-log.ts'
import {
  coverageGap,
  mentionsByTitle,
  POSTS_DIR,
  readPublishedPosts,
  type PublishedPost,
} from '../core/coverage.ts'
import { seriesCandidates } from '../core/series-candidates.ts'
import {
  buildMarkdown,
  parseArticle,
  variantFlag,
  type ArticleContext,
  type ArticleType,
  type ArticleVariant,
} from '../core/article.ts'
import {
  categoryLabel,
  liveElsewhereRows,
  staleArticles,
  staleSummary,
  type LiveElsewhereRow,
  type StaleArticle,
} from '../core/stale.ts'
import { hasError, verifyArticle } from '../core/verify.ts'
import {
  articleUrl,
  buildShortMarkdown,
  estimateSeconds,
  hashtags,
  parseShort,
  speechChars,
  verifyShort,
} from '../core/short.ts'
import { loadFixedPhrases, render } from '../core/fixed-phrases.ts'
import { themeFile } from '../theme.ts'
import { createProvider } from '../llm/index.ts'
import { ATTRIBUTION } from '../sources/streaming-availability.ts'
import type { ChangeEvent } from '../sources/types.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

const DRAFT_DIR = join('data', 'draft')
const PROMPT_PATH = join(DRAFT_DIR, 'prompt.md')
const CONTEXT_PATH = join(DRAFT_DIR, 'context.json')
const RESPONSE_PATH = join(DRAFT_DIR, 'response.md')
/** ショート動画の台本の下書き。★ response.md に混ぜない（下の finalizeShort 参照） */
const SHORT_DRAFT_PATH = join(DRAFT_DIR, 'short.md')
/**
 * 出来上がった台本の置き場。**docs/ でも data/ でもなくリポジトリ直下。**
 * ユーザーが手で開いて詰める前提のファイルなので、生成物置き場にも読み物にも入れない。
 * git で管理して、手を入れた内容が残るようにする。
 */
const SHORTS_DIR = 'shorts'
const MAX_TOKENS = 16_000

/**
 * **PowerShell に貼られた「行末の \」を見つけて、そこで止める。**
 *
 * ■ なぜ要るか（2026-09-02 追加）
 * コマンド例は長い。bash なら行末の `\` で折り返せるが、
 * **PowerShell では `\` は行を継続しない。** 貼り付けると1行目だけが実行され、
 * 2行目以降のフラグが**丸ごと落ちた状態で**ここに届く。
 *
 *   npm run write -- --type series --topic "…" \     ← ここまでが実行される
 *     --slug conan-movies --match "…" --emit         ← PowerShell は別の式と解釈して構文エラー
 *
 * 実際にこれが起きたとき、CLI は「--slug / --match が必要です」とだけ答えた。
 * **その答えは正しいが、原因を指していない。** 運用者の画面には
 * 「渡したはずのフラグが要ると言われた」としか映らないので、
 * 原因（`\` が引数として届いていること）を名指しで出す。
 *
 * ★ 見るのは**単独の `\`** だけ。値の末尾の `\`（正規表現のエスケープ）には触らない。
 *   bash なら `\` ＋改行はシェルが食べるので、**単独の `\` が引数として届いたこと自体が、
 *   継続として扱われなかった証拠**になる。
 */
function assertNoLineContinuation(): void {
  if (!process.argv.slice(2).includes('\\')) return
  throw new Error(
    '引数に「\\」がそのまま入っています。PowerShell では行末の \\ は次の行に続きません。\n' +
      '  2行目以降のフラグは、このコマンドには届いていません。**1行で書いてください。**\n' +
      '  （どうしても折り返すなら、PowerShell の継続はバッククォート ` です）',
  )
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

/** --apply のときに素材を復元するための保存内容 */
interface DraftContext {
  typeId: string
  createdAt: string
  /** 記事が対象とする月。--emit 時の指定を --apply でも再現するため保存する。 */
  targetMonth?: string
  /** 選択したバリアント（ジャンル）。同じく --apply で再現するため保存する。 */
  variantKey?: string
  /**
   * 記事タイプが宣言したフラグの値（特報の `--topic` など）。
   * ★ これが無いと `--apply` で主題もスラッグも復元できず、別の記事が書き出される。
   */
  flags?: Record<string, string>
  items: ChangeEvent[]
}

/** 「記事タイプ×バリアント」1通り。これが記事1本に対応する。 */
interface Recipe {
  type: ArticleType
  variant?: ArticleVariant
  /** 記事タイプが `flags` で宣言したフラグの値。宣言していない記事タイプでは undefined。 */
  flags?: Readonly<Record<string, string>>
}

/** 登録されている記事タイプから、作れる記事の組み合わせをすべて並べる。 */
function recipes(types: ArticleType[]): Recipe[] {
  return types.flatMap((type) =>
    type.variants?.length ? type.variants.map((variant) => ({ type, variant })) : [{ type }],
  )
}

/**
 * 作れる記事のスラッグが1つも重複していないことを確かめる。
 *
 * ■ なぜ要るか
 * スラッグは記事の身元そのもので、**同じスラッグ＝同じURL＝同じファイル**。
 * 別々の記事タイプが同じスラッグに落ちると、片方がもう片方を黙って上書きする。
 * いま `arrivals`（ジャンル別）と `arrivals-service`（サービス別）は
 * どちらも `{月}-arrivals-{キー}` の形で、**名前空間を共有している。**
 * 衝突していないのはジャンルキーとサービスキーがたまたま被っていないからにすぎない。
 *
 * 起動のたびに確かめておけば、記事タイプやバリアントを増やした**その場で**分かる。
 */
function assertUniqueSlugs(all: Recipe[], theme: Theme, now: Date, targetMonth: string): void {
  // ★ ここではフラグを渡さない（--list と同じ状態）。フラグでスラッグが決まる記事タイプは
  //   `slug()` が指定なしでも落ちない形にしておくこと（例: `2026-09-special-<slug>`）。
  const seen = new Map<string, string>()
  for (const r of all) {
    const slug = r.type.slug({ theme, now, targetMonth, variant: r.variant })
    const prev = seen.get(slug)
    if (prev) {
      throw new Error(
        `記事のスラッグが重複しています: ${slug}\n` +
          `  「${prev}」と「${recipeLabel(r)}」が同じURLになります。\n` +
          '  1つのURLに2種類の記事は置けません。どちらかの slug() を変えてください。',
      )
    }
    seen.set(slug, recipeLabel(r))
  }
}

/** バリアントの人間向けの呼び方。エラー文と一覧の見出しに使う。 */
function variantNoun(type: ArticleType): string {
  return type.variantNoun ?? 'ジャンル'
}

function recipeLabel(r: Recipe): string {
  return r.variant ? `${r.type.id} --${variantFlag(r.type)} ${r.variant.key}` : r.type.id
}

/**
 * frontmatter に載せる出典。**素材の出どころから機械的に決める。**
 *
 * ★ 固定で書いてはいけない。U-NEXT は Streaming Availability API から
 *   取っていないので、一律に載せると**取得していないAPIを出典として偽る**。
 *   記事タイプ側で書き分けると、タイプを増やしたときの書き分け漏れが
 *   そのまま嘘の出典になるため、データ側から決める。
 */
function sourcesFor(items: ChangeEvent[]): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []

  const announced = items.filter((e) => e.work.meta.source === 'announcement')
  /*
   * ★ 「u-next 以外はAPI」と書いてはいけない。
   *   各社の告知（announcement）由来の作品はAPIから取っていないので、
   *   一律に載せると**取得していないAPIを出典として偽る**。
   *   ただし告知由来でも、画像と公開年をAPIから引いた作品（apiShowId がある）は
   *   **実際にAPIのデータを使っている**ので、そのときは出典に要る。
   */
  const usesApi = items.some((e) => {
    const source = e.work.meta.source
    if (source === 'u-next') return false
    if (source === 'announcement') return typeof e.work.meta.apiShowId === 'string'
    return true
  })

  if (usesApi) {
    out.push({ label: ATTRIBUTION.text, url: ATTRIBUTION.url })
  }
  if (usesApi || announced.length > 0) {
    // 邦題（API由来）も、告知の邦題から作品を特定する経路も Wikidata を通る
    out.push({ label: '作品タイトル（Wikidata・CC0）', url: 'https://www.wikidata.org/' })
  }
  if (announced.length > 0) {
    const publisher = String(announced[0]!.work.meta.publisher ?? '各社')
    const url = String(announced[0]!.work.meta.announcementUrl ?? '')
    out.push({ label: `配信開始日は ${publisher} が公表した公式発表`, url })
  }
  if (items.some((e) => e.work.meta.source === 'u-next')) {
    out.push({
      label: '配信状況・見放題終了日は U-NEXT の作品ページに掲載されている情報',
      url: 'https://video.unext.jp/',
    })
  }
  return out
}

/**
 * 既存記事のタイトル一覧（重複検知用）。
 *
 * これから書き出すファイル自身は除く。除かないと、
 * 一度書き出した記事を直して再実行したときに
 * 「同じタイトルの記事が既に存在します」で自分自身に弾かれ、
 * 記事を修正できなくなる。
 */
async function existingTitles(excludeSlug: string): Promise<string[]> {
  try {
    const files = await readdir(POSTS_DIR)
    const titles: string[] = []
    for (const f of files.filter((f) => f.endsWith('.md') && f !== `${excludeSlug}.md`)) {
      const raw = await readFile(join(POSTS_DIR, f), 'utf8')
      const m = raw.match(/^title:\s*'(.*)'\s*$/m) ?? raw.match(/^title:\s*"(.*)"\s*$/m)
      if (m?.[1]) titles.push(m[1].replace(/''/g, "'"))
    }
    return titles
  } catch {
    return []
  }
}

/**
 * 記事の frontmatter に入れるジャンル（`anime` / `western` / `japanese`）。
 *
 * ■ 軸で決める。バリアントの有無では決めない
 * ジャンルを名乗るのは**軸がジャンルの記事タイプだけ**（`ArticleType.axis`）。
 * サービス軸の記事にもバリアントはあるが、あちらのバリアントはサービスなので、
 * `recipe.variant.key` をそのまま渡すと `genre: 'netflix'` になる。
 * **`axis` を見ずにバリアントを渡さないこと。**
 *
 * ■ ジャンル軸なのにジャンルが無い記事は書き出さない
 * ジャンル軸の記事タイプを新しく足したときに、`variants` を宣言し忘れると
 * ここが undefined になり、**ジャンルの付いていない記事が黙って1本できる**。
 * 黙って落とすと、サイト側でも気づけない（`genre` は optional なので
 * スキーマ検証は通ってしまう）。ここで止める。
 *
 * ★ キーの値はテーマパックが決める（theme-packs/…/genres.ts の `GENRES`）。
 *   site/src/content.config.ts の enum と揃っていない値を入れると
 *   **サイトのビルドが落ちる。それが検知の仕組み**なので、ここでは値を検査しない。
 */
function articleGenre(recipe: Recipe): string | undefined {
  if (recipe.type.axis !== 'genre') return undefined

  const key = recipe.variant?.key
  if (!key) {
    console.error(
      `記事タイプ ${recipe.type.id} は軸がジャンル（axis: 'genre'）なのに、` +
        'ジャンルが決まっていません。',
    )
    console.error(
      '  ジャンル軸の記事タイプには variants が要ります' +
        '（theme-packs/<テーマ>/article-types/ の該当ファイル）。',
    )
    process.exit(1)
  }
  return key
}

/**
 * 生成された本文を検証し、記事として書き出す。
 * API経由でもターミナル経由でも、必ずここを通る。
 *
 * 書き出したスラッグ・タイトル・タグを返すのは、ショート動画の台本が
 * それらを必要とするため（記事URLと概要欄の組み立て）。
 */
async function finalize(
  raw: string,
  recipe: Recipe,
  items: ChangeEvent[],
  theme: Theme,
  now: Date,
  targetMonth: string,
  stopReason?: string,
): Promise<{ slug: string; title: string; tags: string[] }> {
  const { type } = recipe
  const parsed = parseArticle(raw)
  if (!parsed) {
    console.error('出力を解釈できませんでした。指定した形式に従っていません。')
    console.error('TITLE: / DESCRIPTION: / ---BODY--- の3つが必要です。')
    console.error('--- 受け取った内容（先頭400字）---')
    console.error(raw.slice(0, 400))
    process.exit(1)
  }

  const ctx = { theme, now, targetMonth, variant: recipe.variant, flags: recipe.flags }
  const slug = type.slug(ctx)
  const issues = [
    ...verifyArticle({
      parsed,
      items,
      existingTitles: await existingTitles(slug),
      stopReason,
      // 同じ作品を別の題で書く記事タイプがある（ArticleType.mentions）
      mentions: type.mentions ? (e, body) => type.mentions!(e, body, items) : undefined,
    }),
    ...type.verify(parsed.body, items, ctx),
    // ★ タイトルは verify() に渡っていない（`ArticleType.verifyTitle` のコメント）。
    //   ここを足すまで、タイトルは長さしか見られていなかった。
    ...(type.verifyTitle?.(parsed.title, ctx) ?? []),
  ]

  for (const i of issues) console.log(`  [${i.level === 'error' ? 'NG' : '警告'}] ${i.message}`)

  if (hasError(issues)) {
    console.error('\n品質ゲートを通過しませんでした。記事は書き出しません。')
    console.error('本文を直して、もう一度 --apply してください。')
    process.exit(1)
  }
  if (issues.length === 0) console.log('  品質ゲート: 問題なし')

  const tags = type.tags(items, ctx)
  // 特報のようにカテゴリが実行時に決まる記事タイプがある（ArticleType.categoryOf）
  const category = type.categoryOf?.(ctx, items) ?? type.category
  const md = buildMarkdown({
    parsed,
    category,
    genre: articleGenre(recipe),
    tags,
    sources: sourcesFor(items),
    dataAsOf: now,
    pubDate: now,
    offsetMinutes: theme.utc_offset_minutes,
  })

  const path = join(POSTS_DIR, `${slug}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, md, 'utf8')

  const ledger = await loadLedger()
  ledger.usedRankingThemes.push(`article:${slug}`)
  await saveLedger(ledger)

  /*
   * ★ **どの指示で作ったかを控えに残す**（core/article-log.ts）。
   *   `--topic` と `--match` は人が決めた値で、記事のどこにも残らない。
   *   ここで記録しておかないと、同じURLを書き直すことになったときに
   *   **束ね方を思い出すところから**やり直しになる。
   *   すべての記事タイプで記録する（シリーズ記事だけの都合にしない）。
   */
  await recordArticle({
    slug,
    typeId: type.id,
    variantKey: recipe.variant?.key,
    targetMonth,
    flags: recipe.flags ? { ...recipe.flags } : undefined,
    category,
    writtenAt: formatIsoDate(now.toISOString(), theme.utc_offset_minutes),
  })

  console.log(`\n書き出し: ${path}`)
  console.log(`タイトル: ${parsed.title}`)
  console.log(`本文: ${parsed.body.replace(/\s/g, '').length}字`)

  return { slug, title: parsed.title, tags }
}

/**
 * ショート動画の台本を書き出す。
 *
 * ■ 記事とは完全に切り離す
 * 記事の書き出しが**成功したあとにだけ**呼ばれ、ここで何が起きても記事は取り消さない。
 * 台本の下書きが無ければ黙って何もしない。検査は `verifyShort` がすべて warn で返す。
 * 台本は人が詰めて完成させるたたき台で、この時点で公開されるものではない。
 * ここを厳しくすると、台本の粗が記事の公開を止めることになり優先順位が逆転する。
 *
 * ■ frontmatter と概要欄は人にもLLMにも書かせない
 * 記事URL・出典表記は機械的に決まる事実で、**出典表記は動画にも義務がある**
 * （YouTube は記事とは別の配布先）。人が毎回書く形にすると、
 * 忘れた回がそのまま規約違反になる。
 */
async function finalizeShort(
  article: { slug: string; title: string; tags: string[] },
  recipe: Recipe,
  items: ChangeEvent[],
  theme: Theme,
  now: Date,
): Promise<void> {
  if (!recipe.type.buildShortPrompt) return

  let raw: string
  try {
    raw = await readFile(SHORT_DRAFT_PATH, 'utf8')
  } catch {
    console.log(`\n（${SHORT_DRAFT_PATH} が無いので台本は作りませんでした）`)
    return
  }

  const short = parseShort(raw)
  if (!short) {
    console.log(`\n[警告] ${SHORT_DRAFT_PATH} を解釈できませんでした。記事はそのまま書き出してあります。`)
    console.log('       NOTE: / ---CUTS--- / カット表 の3つが必要です。')
    return
  }

  // 締めの固定文言。プロンプトに出したものと同じ値でなければ検査が意味を持たない。
  const phrases = loadFixedPhrases(themeFile(theme, 'templates', 'fixed-phrases.md'), [
    'short-closer',
    'short-description',
  ])
  const closer = phrases.get('short-closer')!

  const issues = verifyShort({
    short,
    items,
    closer,
    offsetMinutes: theme.utc_offset_minutes,
  })
  for (const i of issues) console.log(`  [台本/警告] ${i.message}`)

  const url = articleUrl(article.slug)

  /*
   * ★ 出典は記事の frontmatter と**同じ関数**から作る。
   *   概要欄用に別で書き起こすと、U-NEXT の記事に API の帰属表示が付くような
   *   食い違いが静かに生まれる。出どころが違えば表示も違う。
   */
  const sources = sourcesFor(items)
    .map((s) => `${s.label.replace(/^>\s*/, '')}\n${s.url}`)
    .join('\n')

  const description = render(phrases.get('short-description')!, {
    記事タイトル: article.title,
    記事URL: url,
    出典: sources,
    ハッシュタグ: hashtags(article.tags),
  })

  const md = buildShortMarkdown({
    slug: article.slug,
    typeId: recipe.type.id,
    variantKey: recipe.variant?.key,
    articleTitle: article.title,
    articleUrl: url,
    short,
    description,
    generatedAt: now,
    offsetMinutes: theme.utc_offset_minutes,
  })

  const path = join(SHORTS_DIR, `${article.slug}.md`)
  await mkdir(SHORTS_DIR, { recursive: true })
  await writeFile(path, md, 'utf8')

  const chars = short.cuts.reduce((n, c) => n + speechChars(c.narration), 0)
  console.log(`\n台本: ${path}`)
  console.log(
    `      ${short.cuts.length}カット / 読み上げ ${chars}字 / 推定 ${estimateSeconds(short.cuts).toFixed(1)}秒`,
  )
  console.log('      カット画像: cd site && npm run shorts')
}

/** --apply: 手元で書いた本文を取り込む */
async function applyDraft(theme: Theme): Promise<void> {
  let ctxRaw: string
  try {
    ctxRaw = await readFile(CONTEXT_PATH, 'utf8')
  } catch {
    console.error(`${CONTEXT_PATH} がありません。先に npm run write -- --emit を実行してください。`)
    process.exit(1)
  }
  const draft = JSON.parse(ctxRaw) as DraftContext

  let response: string
  try {
    response = await readFile(RESPONSE_PATH, 'utf8')
  } catch {
    console.error(`${RESPONSE_PATH} がありません。`)
    console.error(`${PROMPT_PATH} を読んで記事を書き、その内容を ${RESPONSE_PATH} に保存してください。`)
    process.exit(1)
  }

  const type = (await loadArticleTypes(theme)).find((t) => t.id === draft.typeId)
  if (!type) throw new Error(`context.json の記事タイプが不明です: ${draft.typeId}`)

  const variant = draft.variantKey
    ? type.variants?.find((v) => v.key === draft.variantKey)
    : undefined
  if (draft.variantKey && !variant) {
    throw new Error(
      `context.json の${variantNoun(type)}が不明です: ${draft.typeId} / ${draft.variantKey}`,
    )
  }

  const now = new Date(draft.createdAt)
  const targetMonth = draft.targetMonth ?? currentYearMonth(theme.utc_offset_minutes)
  // ★ フラグも復元する。無いまま進むと、特報が主題もURLも失った別記事になる。
  const flags = draft.flags ?? {}
  assertRequiredFlags(type, flags)

  console.log(
    `下書きを適用します（${recipeLabel({ type, variant })} / 対象 ${targetMonth} / ` +
      `素材${draft.items.length}件 / ${draft.createdAt}）\n`,
  )
  const recipe = { type, variant, flags: type.flags?.length ? flags : undefined }
  const article = await finalize(response, recipe, draft.items, theme, now, targetMonth)
  await finalizeShort(article, recipe, draft.items, theme, now)
  console.log('\n確認: cd site && npm run build')
}

/**
 * 前の版がある記事を書き直すときに、プロンプトの先頭へ差し込む節。
 *
 * ■ なぜ「全部書き直す」ではいけないのか（2026-09-02 追加）
 * 状態が変わったシリーズ記事（終了予定 → 終了済み）で**変わる事実はごく一部**。
 * タイトルの動詞句・リードの固定文言・節の見出し・表の「状態」の列、それだけ。
 *
 * それ以外は変える理由が無い。
 *   - 2段落目や各節の解説は `npm run research` で調べた事実で書いてある。
 *     ゼロから書き直すと、**同じ材料から別の文章が出て、内容が静かに痩せる。**
 *   - 手で足した一文（他社との相互参照など）は、書き直すたびに消える
 *     （docs/EDITING.md「他社の話を1文だけ足すとき」）。
 *   - 読者から見ても、事実が1つ変わっただけの記事が丸ごと別物になるのは不自然。
 *
 * 月次記事の更新版が「**前回までの分を落とさない**」（`templates/naming.md`）のと
 * 同じ考え方を、状態の書き換えにも通す。**書き直しは差し替えであって、書き下ろしではない。**
 *
 * ★ 何を差し替えるべきかは記事タイプの決まり（`templates/series.md` の
 *   「書き直し（状態が変わったとき）」）にある。ここが持つのは
 *   「前の版を土台にする」という**どの記事タイプにも共通する部分**だけ。
 */
function rewriteSection(previous: { slug: string; body: string; reason?: string }): string {
  return `# ★ この記事には前の版があります（新しく書き下ろすのではありません）

すでに公開している記事 **\`${previous.slug}\`** の**更新版**です。
${previous.reason ? `\n    食い違い: ${previous.reason}\n` : ''}
> **あらすじも、一度調べた作品の特徴も、書き直す必要はありません。**
> **いまの状態で読んでも違和感が出ないところだけを直して、記事を遷移させてください。**

**下の「前の版の本文」を土台にします。** 段落ごとに「この文は、いまの素材で読んでも
おかしくないか」だけを見て、おかしくない段落には**手を触れないでください。**

- **作品ごとの解説はそのまま引き継ぐ。** 前の版に書いてある作品の説明は
  調べた事実で書いてあります。同じ材料からもう一度書くと別の文章になり、
  **内容が静かに痩せます。**「言い回しを整える」だけの書き換えもしないでください。
- 手を入れるのは次の2つだけです。
  1. **事実が変わったせいで嘘になっている箇所**（動詞句・固定文言・状態の列・日付）
  2. **今回はじめて素材に入った作品**（素材の ★ 印）。ここだけ新しく書き足す
- **表の行は落とさない。** 前の版に載っていた作品は、状態が変わっても表に残します。
- 前の版に手で足した一文（他社との相互参照など）があれば**残す**。
  ただし事実として誤りになっていれば直す。
- タイトルも同じ。**見どころ（\`｜\` の後ろ）は変える理由が無ければそのまま。**

★ **構成までは前の版に固定しません。** 記事タイプによっては更新版で節が増えます
  （月次記事の「今回新たに判明した終了予定」の節など）。
  **どういう形にするかは下の記事の仕様に従い、文章だけを引き継いでください。**

---

## 前の版の本文

**ここから下は、いま公開されている記事の本文です。** 出力に含める前に、上の指示に従って直してください。

<<<前の版ここから>>>
${previous.body.trim()}
<<<前の版ここまで>>>

---
`
}

/** --emit: プロンプトと素材をファイルに書き出す */
async function emitDraft(
  system: string,
  prompt: string,
  recipe: Recipe,
  items: ChangeEvent[],
  ctx: ArticleContext,
  /**
   * 前の版がある回だけ渡す。その本文を土台にさせる（`rewriteSection`）。
   * `reason` は書き直し（`--refresh`）のときだけ付く食い違いの説明。
   */
  previous?: { slug: string; body: string; reason?: string },
): Promise<void> {
  await mkdir(DRAFT_DIR, { recursive: true })

  /*
   * ショート動画の台本。**記事タイプが実装しているときだけ付く。**
   * CLI は台本の中身を知らない（記事タイプの構成を知らないのと同じ扱い）。
   * `ended` のように意図的に実装していないタイプでは、この節がそのまま消える。
   */
  const shortSection = recipe.type.buildShortPrompt?.(items, ctx)

  /*
   * ★ 前の記事の台本を消しておく。
   *   消さないと、記事Aで書いた台本が残ったまま記事Bを --emit → --apply したとき、
   *   **記事Bの台本として記事Aの内容が書き出される**。
   *   記事本体（response.md）は固定文言の検査が食い違いを弾くが、
   *   台本にはそういう歯止めが無いので、ここで断ち切る。
   */
  await rm(SHORT_DRAFT_PATH, { force: true })

  const doc = `# 記事の下書き依頼

このファイルの指示に従って記事を書き、**\`${RESPONSE_PATH}\` に保存**してください。
保存したら \`npm run write -- --apply\` を実行すると、検証を通して記事になります。

- 出力形式（TITLE / DESCRIPTION / ---BODY---）を必ず守ること
- frontmatter は書かないこと（日付・出典はパイプラインが機械的に組み立てる）
${shortSection ? `- 記事を書いたら、続けて**ショート動画の台本**を \`${SHORT_DRAFT_PATH}\` に書くこと（末尾の節）\n` : ''}
---

${previous ? `${rewriteSection(previous)}\n` : ''}## 役割・記事の仕様

${system}

---

## 素材

${prompt}
${shortSection ? `\n---\n\n${shortSection}\n` : ''}`

  await writeFile(PROMPT_PATH, doc, 'utf8')
  await writeFile(
    CONTEXT_PATH,
    JSON.stringify(
      {
        typeId: recipe.type.id,
        createdAt: ctx.now.toISOString(),
        targetMonth: ctx.targetMonth,
        variantKey: recipe.variant?.key,
        // ★ 特報の --topic / --slug はここに保存しないと --apply で失われ、
        //   主題の無いタイトルと違うURLの記事が書き出される。
        flags: recipe.flags ? { ...recipe.flags } : undefined,
        items,
      } satisfies DraftContext,
      null,
      2,
    ),
    'utf8',
  )

  console.log(`書き出し: ${PROMPT_PATH}`)
  console.log(`          ${CONTEXT_PATH}`)
  console.log('\n次の手順:')
  console.log(`  1. ${PROMPT_PATH} を読んで記事を書く`)
  console.log(`  2. その内容を ${RESPONSE_PATH} に保存する`)
  if (shortSection) console.log(`  2b. ショート動画の台本を ${SHORT_DRAFT_PATH} に保存する`)
  console.log('  3. npm run write -- --apply')
  // 書き直しの回は入口が違う（前の版を土台にする決まりが /refresh 側にある）
  console.log(
    previous
      ? '\n（このセッションなら /refresh で1〜3を自動化できます）'
      : '\n（このセッションなら /article で1〜3を自動化できます）',
  )
}

/**
 * --list: 作れる記事を素材の件数つきで並べる。
 *
 * 記事タイプが増えても、使う側はこれを見れば選べる。
 * スラッシュコマンドに記事の一覧を書き写さずに済ませるための入口。
 */
async function listRecipes(
  theme: Theme,
  targetMonth: string,
  now: Date,
  /** 対象月を運用者が明示したか。していないときだけ前月の取りこぼしも見に行く */
  monthGiven = false,
): Promise<void> {
  const events = await readAllEvents()
  const ledger = await loadLedger()
  const existing = new Set(
    (await readdir(POSTS_DIR).catch(() => []))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  )
  // 公開済み記事の本文。取りこぼしの突き合わせに使う（core/coverage.ts）
  const posts = await readPublishedPosts(POSTS_DIR)
  const gaps: CoverageRow[] = []

  console.log(`テーマ: ${theme.label}  対象月: ${targetMonth}  収集済み ${events.length}件\n`)
  console.log('  記事                              素材  状態  スラッグ')
  console.log('  ' + '-'.repeat(72))

  for (const r of recipes(await loadArticleTypes(theme))) {
    const ctx = { theme, now, targetMonth, variant: r.variant }
    const slug = r.type.slug(ctx)

    // ★ 特報のように「何を書くかを毎回指示する」記事タイプは、
    //   指示が無い状態で素材を数えても意味がない。0件と出すと
    //   「素材が無い」と読めてしまうので、そうではないと分かる形にする。
    if (r.type.flags?.some((f) => f.required)) {
      const need = r.type.flags.filter((f) => f.required).map((f) => `--${f.name}`).join(' ')
      console.log(`  ${recipeLabel(r).padEnd(32)}   —  要指示  ${need}`)
      continue
    }

    const items = r.type.select(events, ledger, ctx)
    const min = r.type.minItems ?? 0
    // ★ 別の軸ですでに書かれていれば「未作成」と出さない。
    //   出すと、件数だけを見て書き始めて同じ作品の記事が2本立つ（article.ts の coveredBy）。
    const covered = r.type.coveredBy?.(ctx, existing)
    const state = existing.has(slug)
      ? '作成済'
      : covered
        ? `作成済(${covered})`
        : items.length === 0
          ? '素材なし'
          : // 少ない月に無理に1本立てると表がスカスカの記事になる。
            // 止めはしないが、運用者が気づけるように出す。
            items.length < min
            ? '素材不足'
            : '未作成'
    console.log(
      `  ${recipeLabel(r).padEnd(32)}${String(items.length).padStart(4)}  ${state.padEnd(18)}${slug}`,
    )

    /*
     * ★ 素材が公開済みの記事に載っているかは、状態（作成済／未作成）とは別に数える。
     *   記事を書いたあとに収集した素材は「作成済」の下に溜まり続けるし、
     *   記事タイプを分割してスラッグが変わった月は「未作成」と出たまま放置される。
     *   どちらも件数だけでは締切が見えないので、下にまとめて出す（core/coverage.ts）。
     */
    if (items.length > 0) {
      const category = r.type.categoryOf?.(ctx, items) ?? r.type.category
      const { missing, nearest } = coverageGap(
        items,
        posts,
        category,
        r.type.mentions ?? mentionsByTitle,
      )
      if (missing.length > 0) gaps.push({ label: recipeLabel(r), category, missing, nearest })
    }
  }

  if (gaps.length > 0) printCoverageGaps(gaps, theme.utc_offset_minutes, now)

  /*
   * ★ 前月ぶんの取りこぼし（2026-09-01 追加）
   *
   * 上の突き合わせは**対象月（既定は今月）の素材**しか見ない。
   * 月末に配信が始まった作品が翌月の収集で入ると、
   *   - 先月の記事はもう書き終えている（dataAsOf がその前）
   *   - 今月の記事は `isTargetMonth` が先月開始を外す
   * の両方に当たり、**どの記事にも載らないまま一覧からも消える。**
   * 実際に「機動戦士ガンダム 閃光のハサウェイ キルケーの魔女」（8月31日開始・
   * 9月1日収集）がそうなった。月が変わった瞬間に窓が閉じるので、
   * 前月ぶんだけは黙って毎回見に行く。
   *
   * ★ 締切のあるカテゴリ（leaving）は出さない。**期限そのものが過ぎている**ので、
   *   いま更新版を書いても読者には届かない。拾えるのは起きたことを記録する記事だけ。
   */
  if (!monthGiven) {
    const prev = previousYearMonth(targetMonth)
    const prevGaps = coverageGapsFor(await loadArticleTypes(theme), events, ledger, posts, {
      theme,
      now,
      targetMonth: prev,
    }).filter((g) => !DEADLINE_CATEGORIES.has(g.category))

    if (prevGaps.length > 0) {
      printCoverageGaps(prevGaps, theme.utc_offset_minutes, now, {
        heading: `${prev} ぶんで、まだどの記事にも載っていない素材`,
        hint:
          '  ※ 月末に始まった作品は翌月の収集で入るので、今月の一覧には出てこない。\n' +
          `  ※ 拾うには更新版を書く:  npm run write -- --type <記事> [--<区分> <値>] --month ${prev} --emit`,
      })
    }
  }

  await reportSeriesCandidates(await loadArticleTypes(theme), events, ledger, posts, {
    theme,
    now,
    targetMonth,
  })

  /*
   * ★ **すでに公開した記事のうち、事実と食い違っているもの**（`core/stale.ts`）。
   *   上の表は「記事が有るか無いか」しか見ないので、公開済みのシリーズ記事は
   *   書いた翌日から一生「作成済」のまま並ぶ。ここに出さないと、
   *   運用者がこの画面から気づける機会が無い。
   *   一覧と書き出しは `--refresh` が受け持つので、ここでは件数と理由だけ出す。
   */
  const stale = await staleArticles(await loadArticleTypes(theme), events, ledger, posts, {
    theme,
    now,
  })
  if (stale.length > 0) {
    console.log(`\n  書き直しどきの記事 ${stale.length}本（すでに公開したもの）`)
    console.log('  ' + '-'.repeat(72))
    for (const s of stale) {
      console.log(
        `  ${s.record.slug.padEnd(20)}${String(s.items.length).padStart(4)}  ${staleSummary(s)}`,
      )
    }
    console.log('  ※ 書き出しは npm run write -- --refresh --emit（このセッションなら /refresh）')
    console.log('  ※ 書き直しは差し替え。前の版の本文がプロンプトに付く（解説の段落は変えない）')
  }

  printLiveElsewhere(await liveElsewhereRows(await loadArticleTypes(theme), events, ledger, posts, {
    theme,
    now,
  }))

  console.log('\n書き出す:  npm run write -- --type <記事> [--<区分> <値>] --emit')
  console.log('           区分は上の一覧に出ている形（--genre / --service）をそのまま使う')
}

/**
 * 指定した月について「どの記事にも載っていない素材」だけを数える。**表は出さない。**
 *
 * `--list` の一覧表は対象月ぶんしか作らないので、別の月を同じ網に掛けたいときに
 * この計算だけを取り出せるようにしてある。指示が要る記事タイプ（`--kind` などが
 * 必須のもの）は、指示が無いと素材が決まらないので飛ばす。
 */
function coverageGapsFor(
  types: ArticleType[],
  events: ChangeEvent[],
  ledger: Ledger,
  posts: PublishedPost[],
  base: { theme: Theme; now: Date; targetMonth: string },
): CoverageRow[] {
  const rows: CoverageRow[] = []
  for (const r of recipes(types)) {
    if (r.type.flags?.some((f) => f.required)) continue

    const ctx = { ...base, variant: r.variant }
    const items = r.type.select(events, ledger, ctx)
    if (items.length === 0) continue

    const category = r.type.categoryOf?.(ctx, items) ?? r.type.category
    const { missing, nearest } = coverageGap(
      items,
      posts,
      category,
      r.type.mentions ?? mentionsByTitle,
    )
    if (missing.length > 0) rows.push({ label: recipeLabel(r), category, missing, nearest })
  }
  return rows
}

/**
 * 「サービスを横断して終わるシリーズ」を候補として並べる。
 *
 * ■ なぜ一覧表とも取りこぼしとも別に出すのか
 * 上の一覧表は**記事タイプごと**、取りこぼしは**素材ごと**に数えている。
 * どちらも「1つのシリーズが2社で同時に終わっている」ことを見せられない。
 * 表には `leaving --service netflix 61件` としか出ないので、
 * そのうち29本が同じシリーズの劇場版だったことは数字から読めなかった（2026-08）。
 *
 * **サービス軸の記事に他社を混ぜられない**以上（`templates/naming.md`）、
 * 横断は主題軸（`series`）でしか記事にできない。**気づけないと記事にならない。**
 *
 * ■ どこで出すか（2か所）
 *   1. `--list`（`/article` の手順1）… 何を書くか決める前に見る
 *   2. 見放題終了の記事を `--emit` した直後 … その素材の中に横断があったとき
 * 2 があるのは、月次記事を書いている最中に気づけるようにするため。
 * 書き終えてから一覧に戻ると、その月はもう書いた気になっている。
 *
 * ■ 出すのは候補まで
 * 主題・URL・絞り込みは**人が決める**（`core/series-candidates.ts`）。
 * 束の名前をそのまま `--topic` にしないこと。
 */
async function reportSeriesCandidates(
  types: ArticleType[],
  events: ChangeEvent[],
  ledger: Ledger,
  posts: PublishedPost[],
  ctx: { theme: Theme; now: Date; targetMonth: string },
): Promise<void> {
  /*
   * ★ 記事タイプが無ければ何も出さない。**CLI は記事タイプの中身を知らない**
   *   という決まりのまま、シリーズ記事を持たないテーマでも動くようにしておく。
   */
  const series = types.find((t) => t.id === 'series')
  if (!series) return

  const candidates = seriesCandidates(
    events,
    posts,
    // 件数の判断はすべて記事タイプに任せる（series-candidates.ts の `select` の説明）
    (match) => series.select(events, ledger, { ...ctx, flags: { match } }),
    series.mentions ?? mentionsByTitle,
  )
  if (candidates.length === 0) return

  console.log('\n  シリーズ候補（サービスを横断して終わる作品群）')
  console.log('  ' + '-'.repeat(72))
  for (const c of candidates) {
    const labels = c.services.map((s) => serviceLabel(ctx.theme, s)).join(' / ')
    const when = c.nearest
      ? `最短 ${formatMonthDay(c.nearest, ctx.theme.utc_offset_minutes)}`
      : '日付なし'
    console.log(`  ${(c.key + '…').padEnd(20)}${String(c.works).padStart(3)}作  ${labels}  ${when}`)
    console.log(`      ${c.titles.join(' / ')}`)
    console.log(
      `      npm run write -- --type series --topic "「?」シリーズ" --slug ? --match "${c.match}" --dry-run`,
    )
  }
  console.log('  ※ --topic と --slug は人が決める。束の名前をそのまま主題にしないこと。')
  console.log('  ※ 件数は --dry-run が正確に出す。上の作数は先頭6文字で束ねた粗い数。')
}

/**
 * サービスキーを読み手向けの表記に直す。テーマの一覧に無ければキーのまま出す。
 *
 * ★ U-NEXT は `catalogs`（配信API）ではなく別枠にある（`theme.ts` の `unext`）。
 *   catalogs だけを見ると、U-NEXT が絡む束で `u-next` と生のキーが出る。
 */
function serviceLabel(theme: Theme, key: string): string {
  if (theme.unext && theme.unext.service_key === key) return theme.unext.label
  return theme.catalogs.find((c) => c.key === key)?.label ?? key
}

/**
 * 「どの記事にも載っていない素材」を締切つきで並べる。
 *
 * ■ なぜ一覧表と分けるのか（2026-08-31 追加）
 * 上の表は「記事が有るか無いか」しか見ていない。2026年8月に、
 * `2026-08-leaving`（サービス別に分ける前の記事）を公開した**25分後**の収集で
 * Netflix の8月31日終了61本（うち29本が「名探偵コナン」劇場版）が入り、
 * その61本はどの月次記事にも載らないまま月末を迎えた。
 * 表には「未作成 61件」と出ていたが、同じ月・同じカテゴリの記事が別スラッグで
 * 既にあったため、運用者からは「書き終えた月」に見えていた。
 * **件数ではなく締切で気づけるようにする。**
 *
 * ■ 出たときにやること
 *   1. その記事タイプで**更新版**を書く（同じスラッグを書き直す＝記事が育つ）
 *   2. サービスをまたいで同じ作品が並んでいるなら、**主題軸**で1本立てる
 *      （`series` / `special`）。**サービス軸の記事に他社を混ぜてはいけない**ので、
 *      横断してよいのは主題軸だけ（README「記事の種類」）。
 */
interface CoverageRow {
  label: string
  /** 記事のカテゴリ。締切のある素材かどうかがこれで決まる */
  category: string
  missing: ChangeEvent[]
  /** 未掲載のうち最も近い日付（ISO）。日付を持たない素材しか無ければ undefined */
  nearest?: string
}

/**
 * 締切のあるカテゴリ。`at` が**これから来る期限**を指すのはここだけ。
 *
 * ★ `arrivals` の `at` は配信**開始**日なので、過ぎているのが普通。
 *   同じ言い回しで「期限切れ」と出すと、正常なものを事故に見せることになる。
 */
const DEADLINE_CATEGORIES = new Set(['leaving'])

function printCoverageGaps(
  gaps: CoverageRow[],
  offsetMinutes: number,
  now: Date,
  /** 見出しと締めの一行。前月ぶんを出すときだけ差し替える */
  section = {
    heading: '記事に載っていない素材（公開済み記事の本文と突き合わせた結果）',
    hint: '  ※ 更新版を書くか、サービスをまたぐなら主題軸（series / special）で1本立てる。',
  },
): void {
  console.log(`\n  ${section.heading}`)
  console.log('  ' + '-'.repeat(72))
  // 締切のあるものが先、そのなかは締切の近い順。
  // 日付だけで並べると、過ぎた配信開始日が本当の締切より上に来る。
  const sorted = [...gaps].sort((a, b) => {
    const da = DEADLINE_CATEGORIES.has(a.category) ? 0 : 1
    const db = DEADLINE_CATEGORIES.has(b.category) ? 0 : 1
    if (da !== db) return da - db
    return (a.nearest ?? '9999').localeCompare(b.nearest ?? '9999')
  })
  for (const g of sorted) {
    let when = '日付なし'
    if (g.nearest && DEADLINE_CATEGORIES.has(g.category)) {
      const d = daysUntil(g.nearest, offsetMinutes, now)
      const rest = d < 0 ? '期限切れ' : d === 0 ? '本日まで' : `あと${d}日`
      when = `最短 ${formatMonthDay(g.nearest, offsetMinutes)}（${rest}）`
    } else if (g.nearest) {
      when = `最古 ${formatMonthDay(g.nearest, offsetMinutes)}`
    }
    console.log(`  ${g.label.padEnd(32)}${String(g.missing.length).padStart(4)}件  ${when}`)
    const names = g.missing.slice(0, 3).map((e) => e.work.localizedTitle ?? e.work.title)
    const more = g.missing.length > names.length ? ` ほか${g.missing.length - names.length}件` : ''
    console.log(`      ${names.join(' / ')}${more}`)
  }
  console.log(section.hint)
}

// --- 書き直し（--refresh / --register） ----------------------------------

/**
 * 「終了しました」と書いた作品に、他社の生きている観測が残っている、の一覧。
 *
 * ★ **書き直しの一覧とは別に出す。** 書き直しても直らないので、
 *   同じ表に並べると「片づけたのに消えない行」になる（`core/stale.ts`）。
 * ★ 断定の言い方をしないこと。当サイトが持っているのは変化の観測で、在庫ではない。
 */
function printLiveElsewhere(rows: LiveElsewhereRow[]): void {
  if (rows.length === 0) return
  console.log(`\n  他社に生きている観測が残っている作品 ${rows.length}件`)
  console.log('  ' + '-'.repeat(72))
  for (const r of rows) {
    console.log(
      `  ${r.slug.padEnd(20)}${r.title}\n` +
        `      ${r.offLabel}で終了 / ${r.liveLabel}で` +
        (r.kind === 'leaving' ? '終了予定日がまだ先' : '配信開始を観測したまま'),
    )
  }
  console.log('  ※ 「他社で配信中」とは言えません（当サイトが持つのは変化の観測で、在庫ではない）。')
  console.log('  ※ 記事で「終了しました」と言い切る前に、実際の配信状況を確かめてください。')
}

/**
 * `--refresh`: **書き直しどきの記事を並べる。** `--emit` を足すと1本ぶん書き出す。
 *
 * ■ なぜ `--list` と別なのか
 * `--list` が答えるのは「**いま何を新しく書けるか**」で、見ているのは
 * 今月の素材と、記事ファイルが有るか無いか。**公開済みの記事は「作成済」で終わり**、
 * そこから先は見ていない。シリーズ記事は月を名乗らないURLを書き直し続ける記事なので、
 * 書いた翌日から一生「作成済」のまま並び、終了日が過ぎても誰も気づけなかった。
 *
 * ここが答えるのは「**すでに書いた記事のうち、どれが事実と食い違っているか**」。
 * 判定は `core/stale.ts`、素材は控え（`core/article-log.ts`）から復元する。
 *
 * ■ 1本ずつしか書き出さない
 * 下書きの置き場（`data/draft/`）は1本ぶんしかない。**まとめて書き出すと
 * 最後の1本しか残らない。** かわりに「残り何本か」を必ず出して、
 * 書き終えたらもう一度呼べばよい形にしてある（`/refresh` がこれを回す）。
 */
async function refreshArticles(theme: Theme, types: ArticleType[], now: Date): Promise<void> {
  const log = await loadArticleLog()
  if (log.length === 0) {
    console.log(`控え（${ARTICLE_LOG_PATH}）が空です。`)
    console.log('  記事を書けば自動で記録されます。公開済みの記事は --register で登録できます:')
    console.log(
      '    npm run write -- --register --type series --slug conan-movies ' +
        '--topic "「名探偵コナン」劇場版シリーズ" --match "名探偵コナン"',
    )
    return
  }

  const events = await readAllEvents()
  const ledger = await loadLedger()
  const posts = await readPublishedPosts(POSTS_DIR)
  const stale = await staleArticles(types, events, ledger, posts, { theme, now })
  const live = await liveElsewhereRows(types, events, ledger, posts, { theme, now })

  // 控えのうち、書き直しどきの判定にかかる記事タイプ（evergreen）の本数
  const watched = log.filter((r) => types.find((t) => t.id === r.typeId)?.evergreen).length

  if (stale.length === 0) {
    console.log(`書き直しどきの記事はありません（控え ${log.length}本／うち見張り ${watched}本）。`)
    printLiveElsewhere(live)
    return
  }

  if (!flag('emit')) {
    console.log(`書き直しどきの記事 ${stale.length}本（控え ${log.length}本／うち見張り ${watched}本）\n`)
    console.log('  記事                  素材  理由')
    console.log('  ' + '-'.repeat(72))
    for (const s of stale) {
      console.log(
        `  ${s.record.slug.padEnd(20)}${String(s.items.length).padStart(4)}  ${staleSummary(s)}`,
      )
      console.log(`      ${rewriteCommand(s.record, s.type)}`)
    }
    console.log('\n  ※ カテゴリの食い違い（例: 見放題終了予定 → 見放題終了）がいちばん急ぎます。')
    console.log('  ※ タイトルの動詞句・リードの固定文言・バッジがまとめて食い違っている状態です。')
    printLiveElsewhere(live)
    console.log('\n  上から1本ずつ書き出す:  npm run write -- --refresh --emit')
    console.log('  （このセッションなら /refresh がまとめて回します）')
    return
  }

  // --- --refresh --emit: 1本だけ書き出す ---
  const picked = arg('slug')
  const target: StaleArticle | undefined = picked
    ? stale.find((s) => s.record.slug === picked)
    : stale[0]
  if (!target) {
    throw new Error(
      `${picked} は書き直しどきの一覧にありません。\n  一覧: npm run write -- --refresh`,
    )
  }

  const { record, type, items } = target
  const variant = record.variantKey
    ? type.variants?.find((v) => v.key === record.variantKey)
    : undefined
  const ctx = {
    theme,
    now,
    targetMonth: record.targetMonth,
    variant,
    flags: record.flags,
  }

  console.log(`テーマ: ${theme.label}  書き直し: ${record.slug}（${type.id}）`)
  console.log(`理由: ${staleSummary(target)}`)
  console.log(`素材: ${events.length}件中 ${items.length}件を選択\n`)

  const { system, prompt } = type.buildPrompt(items, ctx)
  /*
   * ★ **前の版の本文を渡す。** 書き直しは差し替えであって書き下ろしではない
   *   （`rewriteSection` の説明）。渡さないと、状態が1つ変わっただけの記事が
   *   毎回ゼロから書き直され、調べて書いた解説が別の文章に入れ替わる。
   */
  const previous = {
    slug: record.slug,
    body: posts.find((p) => p.slug === record.slug)!.body,
    reason: staleSummary(target),
  }
  await emitDraft(system, prompt, { type, variant, flags: record.flags }, items, ctx, previous)

  const rest = stale.filter((s) => s !== target)
  if (rest.length > 0) {
    console.log(`\nこのあと書き直しどきの記事があと ${rest.length}本あります:`)
    for (const s of rest) console.log(`  ${s.record.slug.padEnd(20)}${staleSummary(s)}`)
    console.log('  1本書き終えて --apply したら、もう一度 npm run write -- --refresh --emit')
  }
}

/**
 * `--register`: **公開済みの記事を、あとから控えに登録する。**
 *
 * ■ 何のためにあるか
 * 控え（`core/article-log.ts`）は 2026-09-02 に作ったので、
 * それ以前に書いた記事は1本も入っていない。`--topic` と `--match` は
 * 記事のどこにも残らない人の判断なので、**登録は人にしかできない。**
 *
 * ★ 記事タイプの必須フラグはここでも必ず求める。半端な控えを作ると、
 *   書き直しのときに「素材0件」で止まる記事が並ぶだけになる。
 * ★ カテゴリと基準日は**公開されている記事から読む**（引数で受け取らない）。
 *   人が値を打ち込む形にすると、控えと記事が食い違ったまま登録できてしまう。
 */
async function registerArticle(
  theme: Theme,
  types: ArticleType[],
  targetMonth: string,
  now: Date,
): Promise<void> {
  /*
   * ★ `--type` の省略を許さない。`pickRecipe` は省略時に**先頭の記事タイプ**を選ぶが、
   *   書き出しと違って登録は画面に記事が出てこないので、取り違えたことに気づけない。
   *   間違った記事タイプで控えに入ると、以後ずっと素材0件の記事として扱われる。
   */
  if (!arg('type')) {
    throw new Error(
      '--register には --type が要ります（省略できません）。\n' +
        `  有効: ${types.map((t) => t.id).join(', ')}\n` +
        '  例: npm run write -- --register --type series --slug conan-movies ' +
        '--topic "「名探偵コナン」劇場版シリーズ" --match "名探偵コナン"',
    )
  }
  const recipe = pickRecipe(types)
  const { type } = recipe
  const ctx = { theme, now, targetMonth, variant: recipe.variant, flags: recipe.flags }
  const slug = type.slug(ctx)

  const post = (await readPublishedPosts(POSTS_DIR)).find((p) => p.slug === slug)
  if (!post) {
    throw new Error(
      `公開済みの記事が見つかりません: ${join(POSTS_DIR, `${slug}.md`)}\n` +
        '  --register は**すでにある記事**を控えに入れるためのものです。\n' +
        '  これから書くなら --emit を使ってください（書き出したときに自動で記録されます）。',
    )
  }

  /*
   * ★ 登録する前に素材を数えて見せる。`--match` の書き間違いはここでしか気づけない
   *   （控えに入ってしまえば、以後は黙って素材0件の記事として扱われる）。
   */
  const events = await readAllEvents()
  const ledger = await loadLedger()
  const items = type.select(events, ledger, ctx)

  await recordArticle({
    slug,
    typeId: type.id,
    variantKey: recipe.variant?.key,
    targetMonth,
    flags: recipe.flags ? { ...recipe.flags } : undefined,
    category: post.category,
    writtenAt: post.dataAsOf || formatIsoDate(now.toISOString(), theme.utc_offset_minutes),
  })

  console.log(`控えに登録しました: ${slug}（${type.id}）`)
  console.log(`  カテゴリ  ${post.category}（${categoryLabel(post.category)}）`)
  console.log(`  基準日    ${post.dataAsOf || '（記事から読めず、本日で記録）'}`)
  console.log(`  素材      ${items.length}件`)
  if (items.length === 0) {
    console.log('\n  [警告] 素材が0件です。--match が記事の作品に当たっていない可能性があります。')
    console.log('         正しい値でもう一度 --register すると上書きできます。')
  }
  console.log(`\n  控え: ${ARTICLE_LOG_PATH}`)
  console.log('  書き直しどきかを見る:  npm run write -- --refresh')
}

/**
 * 記事タイプが宣言したフラグ（`ArticleType.flags`）を CLI から集める。
 *
 * **CLI はフラグの意味を知らない。** 名前も必須かどうかも記事タイプ側の宣言だけを見る。
 * `variants` と同じ考え方で、記事タイプを増やしてもこの関数は変わらない。
 */
function collectFlags(type: ArticleType): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of type.flags ?? []) {
    const v = arg(f.name)
    if (v !== undefined) out[f.name] = v
  }
  return out
}

/**
 * その記事タイプを1行で走らせるコマンド。**すでに渡された値はそのまま埋める。**
 *
 * ★ 埋めるのが要点。「フラグの一覧」だけを出すと、運用者は自分が打った長い主題を
 *   もう一度書き写すことになる。原因が「1行に収まっていなかった」ことである以上、
 *   **貼り直せる1行を返すのがいちばん短い直し方**になる（`assertNoLineContinuation`）。
 */
function exampleCommand(
  type: ArticleType,
  flags: Readonly<Record<string, string>>,
  tail = '--emit',
): string {
  const parts = ['npm run write --', `--type ${type.id}`]
  for (const f of type.flags ?? []) {
    const v = flags[f.name]
    if (v === undefined && !f.required) continue
    parts.push(`--${f.name} ${v === undefined ? `<${f.name}>` : shellValue(v)}`)
  }
  return [...parts, tail].join(' ')
}

/** 必須フラグが揃っているか。揃っていなければ、何を渡せばよいかを見せて落とす。 */
function assertRequiredFlags(type: ArticleType, flags: Readonly<Record<string, string>>): void {
  const missing = (type.flags ?? []).filter((f) => f.required && !flags[f.name])
  if (missing.length === 0) return
  const all = (type.flags ?? [])
    .map((f) => `    --${f.name} <値>  ${f.required ? '【必須】' : '（任意）'}${f.description}`)
    .join('\n')
  throw new Error(
    `記事タイプ ${type.id} には ${missing.map((f) => `--${f.name}`).join(' / ')} が必要です。\n` +
      `  この記事タイプが受け取るフラグ:\n${all}\n` +
      /*
       * ★ 受け取った値を埋めた1行を必ず出す。渡し忘れの大半は
       *   「複数行に折り返して PowerShell に貼った」ことが原因で、
       *   フラグの一覧だけでは同じ貼り方をもう一度されてしまう。
       */
      `\n  そのまま貼れる形（**1行**。<…> だけ埋める）:\n    ${exampleCommand(type, flags)}`,
  )
}

/** `--type` と バリアントのフラグ（`--genre` / `--service`）から作る記事を1つに決める。 */
function pickRecipe(types: ArticleType[]): Recipe {
  const all = recipes(types)
  const typeId = arg('type') ?? types[0]!.id
  const type = types.find((t) => t.id === typeId)
  if (!type) {
    throw new Error(
      `不明な記事タイプ: ${typeId}（有効: ${types.map((t) => t.id).join(', ')}）\n` +
        '  一覧は npm run write -- --list',
    )
  }

  const flags = collectFlags(type)
  assertRequiredFlags(type, flags)
  const declared = type.flags?.length ? flags : undefined

  const vFlag = variantFlag(type)
  const noun = variantNoun(type)
  const picked = arg(vFlag)
  if (!type.variants?.length) {
    if (picked) throw new Error(`記事タイプ ${type.id} は${noun}で分かれていません（--${vFlag} は不要）`)
    return { type, flags: declared }
  }

  if (!picked) {
    throw new Error(
      `記事タイプ ${type.id} には --${vFlag} が必要です（有効: ${type.variants.map((v) => v.key).join(' / ')}）\n` +
        `  例: npm run write -- --type ${type.id} --${vFlag} ${type.variants[0]!.key} --emit`,
    )
  }
  const variant = type.variants.find((v) => v.key === picked)
  if (!variant) {
    throw new Error(
      `不明な${noun}: ${picked}（${type.id} で有効: ${type.variants.map((v) => v.key).join(' / ')}）`,
    )
  }
  const base = all.find((r) => r.type === type && r.variant === variant)!
  return { ...base, flags: declared }
}

async function main(): Promise<void> {
  // ★ 何よりも先に見る。ここで落ちないと、原因ではなく症状（フラグ不足）が表に出る。
  assertNoLineContinuation()

  const theme = await loadTheme()

  // --apply は素材を context.json から復元するので、選択処理を行わない
  if (flag('apply')) return await applyDraft(theme)

  const now = new Date()
  const targetMonth = arg('month') ?? currentYearMonth(theme.utc_offset_minutes)
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error(`--month は YYYY-MM 形式で指定してください: ${targetMonth}`)
  }

  const types = await loadArticleTypes(theme)
  assertUniqueSlugs(recipes(types), theme, now, targetMonth)

  // 月を明示したときは前月の取りこぼしを出さない（見たい月を運用者が選んでいる）
  if (flag('list')) return await listRecipes(theme, targetMonth, now, arg('month') !== undefined)

  /*
   * ★ `--refresh` は `--emit` より先に見る。どちらも書き出す動きだが、
   *   `--refresh --emit` が書き出すのは**控えから復元した記事**で、
   *   下の `pickRecipe` の経路（新しく書く記事）とは素材の出どころが違う。
   */
  if (flag('refresh')) return await refreshArticles(theme, types, now)
  if (flag('register')) return await registerArticle(theme, types, targetMonth, now)

  const recipe = pickRecipe(types)
  const { type } = recipe

  const ctx = { theme, now, targetMonth, variant: recipe.variant, flags: recipe.flags }
  const events = await readAllEvents()
  const ledger = await loadLedger()
  const items = type.select(events, ledger, ctx)

  console.log(`テーマ: ${theme.label}  記事: ${recipeLabel(recipe)}  対象月: ${targetMonth}`)
  console.log(`素材: ${events.length}件中 ${items.length}件を選択\n`)

  if (items.length === 0) {
    console.log(`${targetMonth} を対象にできる素材がありません。先に npm run collect を実行してください。`)
    return
  }

  const { system, prompt } = type.buildPrompt(items, ctx)

  if (flag('dry-run')) {
    console.log('='.repeat(60))
    console.log('SYSTEM')
    console.log('='.repeat(60))
    console.log(system)
    console.log('\n' + '='.repeat(60))
    console.log('PROMPT')
    console.log('='.repeat(60))
    console.log(prompt)
    console.log('\n' + '='.repeat(60))
    console.log(`概算: system ${system.length}字 / prompt ${prompt.length}字`)
    console.log('--dry-run のためAPIは呼んでいません。')
    return
  }

  if (flag('emit')) {
    /*
     * ★ **同じスラッグの記事がすでにあれば、その本文を土台として渡す**（2026-09-02 追加）。
     *
     *   月次記事は同じ月・同じ軸なら書き直す決まり（`templates/naming.md`）だが、
     *   前の版の本文は**一度も渡していなかった**。渡していたのは
     *   `previousAsOf()` の日付だけで、素材に ★ 印を付けるためのもの。
     *   その結果、更新版は毎回ゼロから書き起こされ、
     *   **前の版で調べて書いた作品ごとの解説が、更新のたびに別の文章に入れ替わっていた。**
     *
     *   下書きに載っている作品の説明は `npm run research` の結果で書かれている。
     *   同じ材料からもう一度書いても良くはならないので、引き継いで
     *   **増えた作品ぶんだけ書き足す**形にする（`rewriteSection`）。
     *
     * ★ 下書き（`draft: true`）は土台にしない。読者に届いていない本文なので、
     *   それを引き継ぐと「前の版」の意味が変わる。
     */
    const posts = await readPublishedPosts(POSTS_DIR)
    const published = posts.find((p) => p.slug === type.slug(ctx) && !p.draft)
    await emitDraft(
      system,
      prompt,
      recipe,
      items,
      ctx,
      published ? { slug: published.slug, body: published.body } : undefined,
    )
    /*
     * ★ **見放題終了の記事を書き出した直後に、横断シリーズを知らせる。**
     *   ここで出すのは、月次記事を書いている最中に気づけるようにするため。
     *   一覧（--list）にも同じものが出るが、運用者が一覧に戻るのは
     *   「その月をまだ書いていない」と思っているときだけで、
     *   書き終えた直後にはもう戻らない（2026-08 の見落としがこの形だった）。
     *
     *   シリーズ記事そのものを書き出したときは出さない（もう書いている）。
     */
    const category = type.categoryOf?.(ctx, items) ?? type.category
    if (type.id !== 'series' && (category === 'leaving' || category === 'ended')) {
      await reportSeriesCandidates(types, events, ledger, posts, { theme, now, targetMonth })
    }
    return
  }

  // --- API で生成 ---
  const llm = createProvider({ provider: arg('provider'), model: arg('model') })
  console.log(`生成中... (${llm.name} / ${llm.model})`)

  const result = await llm.generate({
    system,
    prompt,
    maxTokens: MAX_TOKENS,
    effort: (arg('effort') as 'low' | 'medium' | 'high') ?? 'medium',
  })

  const cost = result.costUnknown
    ? 'コスト不明（LLM_PRICE_INPUT / LLM_PRICE_OUTPUT 未設定）'
    : `$${result.costUsd.toFixed(4)}`
  console.log(
    `完了: 入力 ${result.usage.inputTokens} / 出力 ${result.usage.outputTokens} トークン  ${cost}\n`,
  )

  // ★ API経路では台本を作らない。台本には別の指示が要り、2度目の呼び出しになる。
  //   台本は `/article`（このセッションで書く経路）だけが作る。
  await finalize(result.text, recipe, items, theme, now, targetMonth, result.stopReason)
  console.log('\n確認: cd site && npm run build')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
