/**
 * 記事タイプ共通の部品。
 *
 * 配信終了・配信開始・（今後増える）ジャンル別記事は、
 * 固定文言の読み方・サービス名の並べ方・本文の走査の仕方が同じ。
 * 記事タイプを1つ増やすたびに同じ関数を書き写さずに済むよう、ここに集める。
 *
 * **記事タイプごとに違うもの（構成・文体・検査の中身）はここに置かない。**
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { loadFixedPhrases, render, type FixedPhrases } from '../../../pipeline/core/fixed-phrases.ts'
import {
  SHORT_MAX_CUT_CHARS,
  SHORT_MAX_SECONDS,
  SHORT_OUTPUT_FORMAT,
  narrationBudget,
} from '../../../pipeline/core/short.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { ArticleContext, Axis } from '../../../pipeline/core/article.ts'
import type { VerifyIssue } from '../../../pipeline/core/verify.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'

// --- 固定文言 -------------------------------------------------------------

let cache: { key: string; phrases: FixedPhrases } | undefined

/**
 * テーマの固定文言を読む。テーマごとに1度だけ読み込む。
 * プロンプト組み立てと検査の両方から呼ばれ、**同じ値が返ることが要件**。
 */
export function fixedPhrases(ctx: ArticleContext, required: readonly string[]): FixedPhrases {
  if (cache?.key !== ctx.theme.key) {
    cache = {
      key: ctx.theme.key,
      phrases: loadFixedPhrases(themeFile(ctx.theme, 'templates', 'fixed-phrases.md'), required),
    }
  }
  return cache.phrases
}

/**
 * 記事の軸とタイトルの決まり（`templates/naming.md`）をそのまま返す。
 *
 * ★ 記事タイプごとのテンプレートとは**別に渡す**。
 *   タイトルの型は全記事タイプで同じなので、4つのテンプレートに書き写すと
 *   必ずどれかが古くなる。品質ゲート（`titleIssues`）もこの1枚に対応している。
 */
export function namingRules(ctx: ArticleContext): string {
  return readFileSync(themeFile(ctx.theme, 'templates', 'naming.md'), 'utf8')
}

/**
 * 全記事タイプ共通の文章の決まり（`templates/writing.md`）をそのまま返す。
 *
 * ★ `namingRules` と同じ理由で1枚にまとめてある。
 *   「記事の作りを読者に説明しない」「配信の裏側を推測しない」は
 *   どの記事タイプでも同じなので、テンプレートごとに書くと必ずずれる。
 *   品質ゲート（`styleIssues`）もこの1枚に対応している。
 */
export function writingRules(ctx: ArticleContext): string {
  return readFileSync(themeFile(ctx.theme, 'templates', 'writing.md'), 'utf8')
}

/** 固定文言に値を差し込む小さなヘルパ */
export function phraseReader(
  phrases: FixedPhrases,
  vars: Record<string, string | number>,
): (key: string) => string {
  return (key: string) => render(phrases.get(key) ?? '', vars)
}

// --- 記事の基本情報 -------------------------------------------------------

/**
 * 記事が対象とする月。
 * 実行日ではなく対象月から取る。8月のうちに9月分を書く場合でもずれない。
 */
export function articleMonth(ctx: ArticleContext): number {
  return Number(ctx.targetMonth.split('-')[1])
}

/**
 * **タグの並びから、その記事が名乗っている月を取り出す**（`2026年8月` → `2026-08`）。
 * 名乗っていなければ `undefined`。
 *
 * ■ 何のためにあるか
 * 月次記事は年月のタグを付け、シリーズ記事は**意図的に付けない**（`series.ts` の `tags()`）。
 * つまりこのタグの有無が「月を名乗る記事かどうか」の目印になっている。
 * `ArticleType.retire` の `monthOf` がこれを使い、月が過ぎた記事だけを拾う（`core/retire.ts`）。
 *
 * ★ 書いている側は各記事タイプの `tags()`（`${y}年${Number(m)}月`）。
 *   `leaving` / `ended` / `arrivals` / `arrivals-service` / `upcoming` /
 *   `upcoming-service` / `special` の7つ。**書式を変えるならここも直すこと。**
 * ★ 0埋めのどちらでも読めるようにしてある（`2026年8月` / `2026年08月`）。
 *   書式が片方に寄っても、静かに「月を名乗っていない」と判定されないため。
 * ★ 特報の「2026年9月配信開始」のような**後ろに語が付くタグは月と見なさない**。
 *   あれは期間の呼び名（`special.ts` の `periodLabel`）であってタグではない。
 */
export function monthTagOf(tags: readonly string[]): string | undefined {
  for (const t of tags) {
    const m = /^(\d{4})年(\d{1,2})月$/.exec(t)
    if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`
  }
  return undefined
}

/** 記事作成日。「8月9日」形式 */
export function asOfLabel(ctx: ArticleContext): string {
  return formatMonthDay(ctx.now.toISOString(), ctx.theme.utc_offset_minutes)
}

/**
 * スラッグに使うバリアントのキー。**無ければ落とす。**
 *
 * ★ 以前は `?? 'all'` で「総合1本」のスラッグに落としていた。
 *   それは**軸を名乗らない記事＝サービス横断のまとめ**が作れる穴で、
 *   実際 `2026-08-leaving`（Netflix・Prime Video の合同記事）がそれで生まれている。
 *   落ちるようにしておけば、次に同じ形の記事を作ろうとした時点で気づける。
 */
export function variantKey(ctx: ArticleContext, typeId: string): string {
  const key = ctx.variant?.key
  if (!key) {
    throw new Error(
      `${typeId} は軸（サービス／ジャンル）ごとに1本ずつ書く記事です。` +
        '--service または --genre を指定してください。',
    )
  }
  return key
}

/**
 * 記事に出しうるサービスの一覧（キーと表示名）。
 *
 * ★ `theme.catalogs` だけを見てはいけない。
 *   U-NEXT は Streaming Availability API のカタログに存在せず、
 *   `theme.unext` に別枠で定義されている（取得手段がまったく違うため）。
 *   ここで足しておかないと、U-NEXT の記事だけサービス名が
 *   キー（`u-next`）のまま本文に出る。
 */
export function allServices(ctx: ArticleContext): { key: string; label: string }[] {
  const list = ctx.theme.catalogs.map((c) => ({ key: c.key, label: c.label }))
  if (ctx.theme.unext) {
    list.push({ key: ctx.theme.unext.service_key, label: ctx.theme.unext.label })
  }
  return list
}

/** 「NetflixとAmazon Prime Video」。3つ以上なら中黒でつなぐ。 */
export function serviceNames(items: ChangeEvent[], ctx: ArticleContext): string {
  const present = new Set(items.map((e) => e.service))
  const all = allServices(ctx)
  // 並び順はテーマの定義順に固定する。月によって順番が入れ替わらないようにするため。
  const labels = all.filter((c) => present.has(c.key)).map((c) => c.label)
  if (labels.length === 0) return all.map((c) => c.label).join('・')
  if (labels.length === 2) return labels.join('と')
  return labels.join('・')
}

/** サービス名の対応表。プロンプトに出す表示名を引くため。 */
export function serviceLabels(ctx: ArticleContext): Map<string, string> {
  return new Map(allServices(ctx).map((c) => [c.key, c.label]))
}

/** サイトのタイムゾーンで見て、記事の対象月に入るか */
export function isTargetMonth(iso: string, ctx: ArticleContext): boolean {
  const shifted = new Date(Date.parse(iso) + ctx.theme.utc_offset_minutes * 60_000)
  return shifted.toISOString().slice(0, 7) === ctx.targetMonth
}

// --- 人名 -------------------------------------------------------------------

/**
 * 素材に出す「監督」「出演」の行。
 *
 * ■ **日本語で取れた人名だけを渡す。取れなければ何も渡さない。**
 * 配信APIが返す人名はローマ字（`Tetsuya Nakashima`）。読者は日本語圏なので、
 * 記事にローマ字が並ぶと読みにくく、体裁も崩れる。
 * かといって記事側で漢字に起こすのは**推測**で、同姓同名や表記ゆれで誤る。
 *
 * そこで `npm run enrich` が Wikidata から日本語ラベルを引いておき
 * （theme-packs/streaming-jp/work-context.ts）、**取れたものだけを素材に出す。**
 * 取れなかった作品は人名に触れずに書く。人名は作品を説明する材料のひとつで、
 * 日付や題名と違って**欠けても記事は成立する**（2026-08-27 にこの方針へ変更）。
 *
 * ★ 以前はローマ字を「★ローマ字のまま書くこと」付きで渡していた。
 *   規則としては正しく動いていたが、**読者から見れば直っていないのと同じ**だったので、
 *   渡すのをやめた。ローマ字を素材に出さなければ、記事に出ることもない。
 *
 * ★ **Wikidata の並び順は主演順ではない。**
 *   実測で「告白」の先頭が芦田愛菜（助演）、「アリー/ スター誕生」の2番目が
 *   デイヴ・シャペルになった。配信API側は主演順だが、
 *   日本語名とローマ字名を突き合わせる手段が無いので並べ替えられない。
 *   そこで**順番に意味を持たせない書き方**を素材の注記で指示する。
 *
 * @param label 「監督」「出演」
 * @param japanese Wikidata から日本語で取れた名前（無ければ行ごと出さない）
 * @param unordered 並び順に意味が無いなら true（出演者はこちら）
 */
export function peopleLine(
  label: string,
  japanese: string[] | undefined,
  unordered = false,
): string {
  if (!japanese?.length) return ''
  const note = unordered ? '（★並び順は主演順ではない。「主演」「1番手」と書かないこと）' : ''
  return `  ${label}: ${japanese.join(' / ')}${note}`
}

// --- 出さない作品 -----------------------------------------------------------

/**
 * 記事に出さない作品のID。`data/excluded-works.json` を人が手で管理する。
 *
 * ■ なぜ自動判定にしないか
 * 題名のキーワードで機械的に外すと、同じ語を含む一般作品を巻き込む。
 * 実測で「ラブレース セックスの女神」（2013年の伝記映画）と
 * 「セックス・アンド・マネー」（2006年）が誤って当たった。
 * **1件ずつ人が決める**ほうが、件数（月に数件）から見ても現実的で安全。
 *
 * ■ 収集データは消さない
 * ここで外れるのは記事とページへの掲載だけ。判断を変えれば台帳から1行消すだけで戻る。
 *
 * ★ サイト側にも同じ除外がある（site/src/lib/excluded.ts）。
 *   **片方だけ直すと、記事には出ないのに常設ページには出る**という状態になる。
 */
let excludedIds: Set<string> | undefined

function loadExcluded(): Set<string> {
  if (excludedIds) return excludedIds
  try {
    const raw = readFileSync(join('data', 'excluded-works.json'), 'utf8')
    const parsed = JSON.parse(raw) as { works?: { id?: unknown }[] }
    excludedIds = new Set(
      (parsed.works ?? []).map((w) => String(w.id ?? '')).filter((id) => id.length > 0),
    )
  } catch {
    // 台帳が無い・壊れている＝除外なし。記事の生成は止めない。
    excludedIds = new Set()
  }
  return excludedIds
}

/**
 * 記事に出してよい素材だけを残す。**各記事タイプの select() の先頭で必ず通すこと。**
 * 通し忘れると、その記事タイプだけ除外が効かない。
 */
export function publishable(events: ChangeEvent[]): ChangeEvent[] {
  const excluded = loadExcluded()
  if (excluded.size === 0) return events
  return events.filter((e) => !excluded.has(String(e.work.id)))
}

/** テスト・再読込用 */
export function resetExcluded(): void {
  excludedIds = undefined
}

// --- 前回の版との差分 -------------------------------------------------------
//
// 月内に何度も同じスラッグを書き直す記事タイプ（arrivals / arrivals-service）が
// 「前回の版から何が増えたか」を出すための共通部品。
// **記事タイプごとに書き写さないこと。** 判定がずれると、
// 同じ作品が片方では「新着」、もう片方では「既出」になる。

/**
 * 既に公開されている同じスラッグの記事から、前回の基準日を読む。
 *
 * 読めなければ undefined ＝「初回」として扱う。**ここで例外を投げない。**
 * 記事ファイルが壊れていても、初回の形で書き直せば復旧できる。
 */
export function previousAsOf(slug: string): Date | undefined {
  const path = join('site', 'src', 'content', 'posts', `${slug}.md`)
  if (!existsSync(path)) return undefined
  try {
    const md = readFileSync(path, 'utf8')
    const m = /^dataAsOf:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(md)
    if (!m) return undefined
    const at = Date.parse(`${m[1]}T00:00:00Z`)
    return Number.isFinite(at) ? new Date(at) : undefined
  } catch {
    return undefined
  }
}

/**
 * 作品1件が、前回の版に対してどういう位置づけか。
 *
 * ★ `配信開始日`（実際に見放題になった日）と `把握した日`（収集した日）はずれる。
 *   取りこぼしを後から拾うと、**古い作品が今回の素材に現れる。**
 *   それを「新たに追加」と書けば誤情報なので、ここで1件ずつ区別する。
 */
export type Freshness =
  /** 前回の版以降に**実際に配信が始まった**。「新たに配信開始」と書いてよい */
  | 'started'
  /** 配信開始は前回より前だが、**今回はじめて把握した**。「新たに確認」と書く */
  | 'found'
  /** 前回の版にも載っていた */
  | 'known'

export function freshnessOf(e: ChangeEvent, since: Date | undefined): Freshness {
  if (!since) return 'known' // 初回。全件が同じ扱いなので区別しない
  const collected = Date.parse(e.collectedAt)
  if (!Number.isFinite(collected) || collected < since.getTime()) return 'known'
  const started = e.at ? Date.parse(e.at) : NaN
  return Number.isFinite(started) && started >= since.getTime() ? 'started' : 'found'
}

/**
 * 素材に添える、書き方を指示する1行。**LLM に日付を突き合わせさせない。**
 * 「今回の追加分」でなければ空文字（行ごと落とす前提）。
 */
/**
 * 前回の版のあとに把握した作品か。**配信終了記事の更新版はこれで区別する。**
 *
 * ★ 終了記事で `freshnessOf()` を使ってはいけない。あれは
 *   「配信開始日が前回の版より後か」を見るもので、終了記事が持っているのは終了日。
 *   終了日はほぼ常に未来なので、全件が `started`（＝今回配信開始）になってしまう。
 *
 * 終了記事で意味があるのは「前回の版に載っていたかどうか」だけ。
 * 月の途中で新しい終了予定が判明するのが更新の実体なので、収集日だけを見る。
 */
export function foundSince(e: ChangeEvent, since: Date | undefined): boolean {
  if (!since) return false
  const collected = Date.parse(e.collectedAt)
  return Number.isFinite(collected) && collected >= since.getTime()
}

export function freshnessNote(f: Freshness): string {
  if (f === 'started') {
    return '  ★今回の追加分（前回の更新以降に配信開始）。「新たに見放題配信が始まりました」と書いてよい'
  }
  if (f === 'found') {
    return '  ★今回の追加分（配信開始は前回より前。今回はじめて確認した）。「新たに配信が始まった」とは書かないこと。「今回新たに確認されました」と書く'
  }
  return ''
}

// --- 事故を防ぐ言い回し -----------------------------------------------------
//
// ★ **記事タイプごとに書き写さないこと。** 同じ危険が複数の記事タイプに出る
//   （終了済みの記事も、終了済みを扱う特報も、同じ嘘をつきうる）。
//   写すと片方だけ直され、もう片方から誤情報が漏れる。

/**
 * もう観られない作品を「まだ観られる」と読ませる表現。
 *
 * **1つでもあれば公開を止める。** 読者を直接裏切る誤情報であり、
 * 文体の好みの問題ではないため warn ではなく error。
 * 終了「済み」を扱う記事（`ended` と、kind が removed の特報）で効かせる。
 */
export const MISLEADING_AFTER_END = [
  'お見逃しなく',
  'お見逃しがないように',
  '見逃せません',
  '今のうちに',
  'まだ間に合',
  '観ておきましょう',
  '見ておきましょう',
  'チェックしておきましょう',
  '配信中です',
  '視聴できます',
  '観られます',
] as const

/**
 * **まだ始まっていない配信**を「もう観られる」と読ませる表現。
 *
 * 配信開始「予定」の記事（kind が upcoming の特報）で効かせる。
 * 記事の性格は終了済みの記事と裏返しで、誤ると読者は
 * **観られない作品を観に行かされる**。よって warn ではなく error。
 *
 * ★ 「観られます」「視聴できます」は入れない。
 *   「9月1日から観られます」は予定の記事でも正しい書き方で、
 *   部分一致で止めると正しい文まで公開できなくなる。
 *   ここに置くのは**いま観られると読める言い方だけ**。
 */
export const NOT_YET_AVAILABLE_CLAIM = [
  '配信中です',
  '配信が始まりました',
  '配信が開始されました',
  '配信開始しました',
  '見放題に加わりました',
  '見放題に追加されました',
  'すでに配信',
  '今すぐ観られます',
  '今すぐ視聴',
] as const

/**
 * ポイント（レンタル）で残る可能性がある作品を「もう観られない」と読ませる表現。
 *
 * **見放題とポイントが同居するサービス（U-NEXT）でだけ効かせる。**
 * Netflix / Prime Video の見放題終了はサービスからの退出そのものなので、
 * 同じ言い回しでも誤りにならない。一律にすると正しい記述まで止まる。
 */
export const UNAVAILABLE_CLAIM = [
  '観られなくなり',
  '観られなくなる',
  '見られなくなり',
  '見られなくなる',
  '視聴できなくなり',
  '視聴できなくなる',
  '観ることができなくなり',
  '観ることができなくなる',
] as const

/**
 * 「配信終了」と、修飾なしで書いている行。
 *
 * ★ ここに「配信が終了します」を足してはいけない。
 *   正しい書き方である**「見放題配信が終了します」もその文字列を含む**ので、
 *   単純な部分一致では区別できず、正しい記述まで error で止まる。
 *   行に「見放題」があるかどうかで見る。
 */
export function bareDeliveryEnd(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|'))
    .filter((l) => /配信(が)?終了/.test(l) && !l.includes('見放題'))
}

// --- タイトル ---------------------------------------------------------------
//
// タイトルの型は全記事タイプで共通なので、ここに1つだけ置く。
// 文章としての決まりは templates/naming.md にあり、**この関数はその写し**。
// 片方だけ直すと、テンプレートが要求する形と検査が食い違う。

/**
 * タイトルに出うるサービスの呼び方。**略称・カタカナ表記も入れる。**
 *
 * 正式表記だけを見ると「Netflixの記事に『アマプラ』が入っている」を見逃す。
 * キーは theme.yaml の catalogs（と unext）と揃えること。
 */
const SERVICE_NAMES: { key: string; pattern: RegExp }[] = [
  { key: 'netflix', pattern: /Netflix|ネットフリックス|ネトフリ/i },
  {
    key: 'prime-video',
    pattern: /Amazon Prime Video|Prime Video|プライムビデオ|プライム・ビデオ|アマプラ/i,
  },
  { key: 'u-next', pattern: /U-?NEXT|ユーネクスト/i },
  { key: 'disney-plus', pattern: /Disney\s?\+|ディズニープラス|ディズニー\+/i },
  { key: 'apple-tv', pattern: /Apple TV\s?\+|アップルTV/i },
]

/** 正式表記でない呼び方。読者がサービスを取り違えるほどではないが、表記は揃える。 */
const ABBREVIATIONS =
  /(アマプラ|プライムビデオ|プライム・ビデオ|ネトフリ|ネットフリックス|ディズニープラス|ユーネクスト)/

/** 中身を伴わない煽り。事実だけで成立する記事なので使わない。 */
const HYPE = /(衝撃|必見|神作|話題沸騰|驚愕)/

export interface TitleRule {
  /** この記事が名乗る軸 */
  axis: Axis
  /**
   * 記事タイプごとに固定の動詞句。`見放題配信が始まった` など。
   * templates/naming.md の表と1文字も違えないこと。
   *
   * ★ 空文字なら検査しない。**先頭の【】が動詞まで名乗る記事タイプ**
   *   （配信開始予定＝`periodLabel` が「2026年9月配信開始」）でだけ空にする。
   *   同じことをタイトルに2回書かせないため。
   */
  verbPhrase: string
  /**
   * 先頭の【】に入れる期間の名乗り。既定は `{年}年{月}月`。
   *
   * ★ 配信開始「予定」の記事だけ「2026年9月配信開始」にしている。
   *   同じ月には配信終了予定の記事も並ぶので（【2026年9月】Netflixで…終了予定）、
   *   **先頭の数文字だけを見る読者に、開始と終了を取り違えさせない**ため。
   */
  periodLabel?: string
  /** 更新版か（`previousAsOf()` が前の版を見つけたか） */
  isUpdate: boolean
  /**
   * タイトルに必ず出る軸の呼び名。既定は `ctx.variant?.label`。
   * 特報のようにバリアントを持たない記事タイプが、主題を渡すために使う。
   */
  axisLabel?: string
  /**
   * 本数（◯本）を求めるか。既定は求める。
   * 特報は1作品だけを扱うことがあるので、その場合に false を渡す。
   */
  requiresCount?: boolean
}

/**
 * タイトルが「【期間】＋軸」の型を守っているかを見る。
 *
 * ■ ここを検査にしている理由
 * 読者は検索結果の一覧で、**いつの・どこの情報かだけを見て**開くかどうかを決める。
 * 「見放題配信が始まった作品まとめ」は、その2つがどちらも無い。
 * 品質ゲートに入れないかぎり、月によって型が揺れる（実際11本中6本が揺れていた）。
 *
 * ■ error と warn の分け方
 * 期間・軸・動詞句は**記事の名乗り**なので error（公開を止める）。
 * 本数・字数・煽りは読みやすさの話なので warn。
 */
export function titleIssues(title: string, ctx: ArticleContext, rule: TitleRule): VerifyIssue[] {
  const issues: VerifyIssue[] = []
  const err = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warn', message })

  const [y, m] = ctx.targetMonth.split('-')
  const monthLabel = `${y}年${Number(m)}月`
  const updateMark = `【${asOfLabel(ctx)}更新】`

  // --- 期間（先頭の【】） ---
  //
  // ★ 初回も更新版も**先頭は同じ**（【2026年9月】）。
  //   更新の日付は本数の直後に置く。
  //
  //     【2026年9月】Netflixで見放題配信が終了予定の作品42本【9月12日更新】｜追加は踊る大捜査線
  //
  //   先頭を 【9月12日更新】 にすると、検索結果の一覧で
  //   **どのカテゴリ・どの月の記事なのかが頭から消える。**
  //   読者が最初に見るのは先頭の数文字なので、そこは版によらず固定する。
  const period = rule.periodLabel ?? monthLabel
  if (!title.startsWith(`【${period}】`)) {
    err(`タイトルは「【${period}】」で始めます。現在: 「${clip(title, 30)}」`)
  }

  if (rule.isUpdate) {
    if (!title.includes(updateMark)) {
      err(
        `更新版のタイトルに「${updateMark}」がありません。**本数の直後**に置きます。\n` +
          `      例: 【${monthLabel}】…作品42本${updateMark}｜…`,
      )
    } else {
      if (title.startsWith(updateMark)) {
        err(`「${updateMark}」を先頭に置かないでください。先頭は「【${monthLabel}】」です。`)
      }
      // 見どころ（｜のあと）より後ろに置くと、更新したことが本文の要約に埋もれる
      const bar = title.indexOf('｜')
      if (bar >= 0 && title.indexOf(updateMark) > bar) {
        err(`「${updateMark}」は「｜」より前（本数の直後）に置きます。`)
      }
    }
  } else if (title.includes('更新')) {
    // 前の版が無いのに「更新」と名乗るのは読者に対する嘘
    err('初回の版なのにタイトルが「更新」を名乗っています。前の版がありません。')
  }

  // --- 軸 ---
  const label = rule.axisLabel ?? ctx.variant?.label
  if (label && !title.includes(label)) {
    err(`タイトルに軸（${label}）がありません。期間と軸が無いタイトルは作りません。`)
  }

  const named = SERVICE_NAMES.filter((s) => s.pattern.test(title))
  if (rule.axis === 'service') {
    const others = named.filter((s) => s.key !== ctx.variant?.key)
    if (others.length > 0) {
      err(
        `サービス別の記事のタイトルに他社名があります（${others.map((s) => s.key).join(' / ')}）。` +
          '1本の記事が扱うのは1社だけです。',
      )
    }
  } else if (rule.axis === 'genre' && named.length > 0) {
    err(
      `ジャンル別の記事のタイトルにサービス名があります（${named.map((s) => s.key).join(' / ')}）。` +
        'ジャンル記事はサービスを横断するので、特定の1社を名乗りません。',
    )
  }
  // ★ 主題軸（特報）はサービス名を出してよい。
  //   「Netflixで『007』シリーズが終了」は主題の記事であって横断まとめではなく、
  //   どこの話かを名乗るほうが読者の役に立つ。横断も許される軸なので社数も問わない。

  const abbr = ABBREVIATIONS.exec(title)
  if (abbr) {
    err(`サービス名の略称（${abbr[0]}）を使っています。タイトルも本文も正式表記で揃えます。`)
  }

  // --- 動詞句 ---
  // 空文字は「先頭の【】が動詞まで名乗るので検査しない」の意（TitleRule 参照）
  if (rule.verbPhrase && !title.includes(rule.verbPhrase)) {
    err(
      `タイトルに「${rule.verbPhrase}」がありません。記事タイプごとに固定の言い方です` +
        '（「見放題配信開始の」「見放題終了する」などに言い換えないこと）。',
    )
  }

  // --- 止めない指摘 ---
  if (rule.requiresCount !== false && !/\d+本/.test(title)) {
    warn('タイトルに本数（◯本）がありません。読者が規模を掴めません。')
  }
  if (title.length > 60) {
    warn(`タイトルが${title.length}字です。60字以内に収めてください（検索結果で切れます）。`)
  }
  const hype = HYPE.exec(title)
  if (hype) warn(`タイトルに煽り表現（${hype[0]}）があります。事実だけで書きます。`)

  return issues
}

// --- 本文の走査 -----------------------------------------------------------

export interface DateSection {
  heading: string
  /** 表・箇条書き・見出しを除いた、最後の本文段落 */
  lastParagraph: string | undefined
  /**
   * 見出しの直後（最初の非空行）が表かどうか。
   * テンプレートは「見出し → 表 → 解説」の順を必須にしている。
   * 導入文を挟むと、読者が一覧を掴む前に文章を読まされる。
   */
  startsWithTable: boolean
}

/**
 * `## 8月14日：…` 形式のセクションを取り出す。
 * 締めの検査は日付ごとのまとまりだけが対象で、
 * 「その他の注目作」「全作品リスト」などは対象外。
 */
export function dateSections(md: string): DateSection[] {
  const sections: DateSection[] = []
  let current: { heading: string; lines: string[] } | undefined

  const flush = () => {
    if (!current) return
    const trimmed = current.lines.map((l) => l.trim())
    const prose = trimmed.filter(
      (l) => l && !l.startsWith('|') && !l.startsWith('-') && !l.startsWith('#') && !l.startsWith('>'),
    )
    sections.push({
      heading: current.heading,
      lastParagraph: prose.at(-1)?.replace(/\*+/g, '').trim(),
      startsWithTable: (trimmed.find((l) => l) ?? '').startsWith('|'),
    })
    current = undefined
  }

  for (const line of md.split('\n')) {
    const h2 = line.match(/^## +(.*)$/)
    if (h2) {
      flush()
      const heading = h2[1]!.trim()
      if (/^\d{1,2}月\d{1,2}日/.test(heading)) current = { heading, lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  flush()
  return sections
}

/**
 * Markdown のリンク記法を取り除く。URL の半角括弧を誤検出しないため。
 *
 * ★ **画像をリンクで包んだ形を先に落とす**（2026-09-02 追加）。
 *   セクション画像は `[![説明](/sections/…webp)](リンク先)` の形で入る
 *   （`site/scripts/make-sections.mjs`）。先に落とさないと、内側だけが消えて
 *   `](https://www.amazon.co.jp/s?k=…)` が本文に残り、URLの `? ( ) !` が
 *   「地の文の半角記号」として毎回警告になる。
 *
 *   書き直し（`npm run write -- --refresh`）は**画像が入ったあとの本文**を
 *   もう一度検査に通すので、ここを直さないと毎回この警告が出続ける。
 */
export function stripLinks(md: string): string {
  return md
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    // 画像単体（`![説明](URL)`）とふつうのリンク
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
}

/**
 * 地の文に混ざった半角記号。全角に統一する規約の検査用。
 *
 * ★ 作品名に含まれる半角記号は**正式表記なので直せない**
 *   （「Free!」「アッパレ!戦国大合戦」「日本爆裂!!」など）。
 *   除外しないと毎月必ず警告が出て、本当の違反がその中に埋もれる。
 *
 * @param titles 検査から外す文字列（その月の作品名）。長いものから順に取り除く。
 */
export function halfWidthSymbols(md: string, titles: readonly string[] = []): string[] {
  let text = stripLinks(md)
  for (const title of [...titles].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(title).join('')
  }
  return [...new Set(text.match(/[!?()]/g) ?? [])]
}

/**
 * 記事の作りを読者に説明している言い回し（`templates/writing.md` 1節）。
 *
 * 節のまとめ方（同じ日・同じシリーズ・同じ制作会社）は**書き手の都合**で、
 * 読者に伝える情報ではない。事実を書いたあとに付ける
 * 「〜という並びです」「〜する形です」は、作品の話を並び方の解説に変えてしまう。
 *
 * ★ 「9月1日に11作がまとめて配信開始予定です」のような**事実の記述は当たらない。**
 *   ここに並べたのは決まり文句だけで、事実の言い方を狭めないようにしてある。
 */
const ARTICLE_STRUCTURE_TALK = [
  '並びです',
  '並びになっています',
  '並びになりました',
  'という形です',
  '形になっています',
  '形になりました',
  '起点になります',
  'という構成です',
  /*
   * ★ 2026-08-30 追加。「まとめて追えるのがこちらの並びの特徴になります」のような、
   *   **表の並べ方そのものを長所として語る**書き方。
   *   読者が知りたいのは作品の話で、記事の組み立て方ではない。
   */
  '並びの特徴',
] as const

/**
 * 配信の裏側（ライセンス・権利・契約）への踏み込み（`templates/writing.md` 2節）。
 *
 * ★ 「独占配信」は各社の告知に書かれた**事実**なので当たらない。
 *   止めたいのは、同じ日に並んだ理由をこちらで推し量って書くこと。
 */
const BEHIND_THE_SCENES = ['ライセンス', '権利関係', '配給権', '独占契約'] as const

/**
 * 全記事タイプ共通の文体検査。**書いてよいことの範囲そのものなので error。**
 *
 * 文体の指摘は普通 warn（判定が外れうるので公開は止めない）だが、この2つは違う。
 *   - 記事の作りの説明 … 読者にとって情報量ゼロだと**決めた**もの
 *   - 配信の裏側の推測 … 読者に確かめようがなく、外したときの損が記事全体に及ぶ
 * どちらも決まり文句なので誤検出しにくく、直し方も1文の書き換えで済む。
 */
export function styleIssues(md: string): VerifyIssue[] {
  const issues: VerifyIssue[] = []
  const text = stripLinks(md)

  for (const phrase of ARTICLE_STRUCTURE_TALK) {
    if (!text.includes(phrase)) continue
    issues.push({
      level: 'error',
      message:
        `「${phrase}」は記事の作りの説明です（templates/writing.md 1節）。` +
        '節のまとめ方は書き手の都合なので、読者に向けた言い方に直してください。' +
        '例:「シーズン1〜2と合わせて視聴してみましょう！」',
    })
  }

  for (const word of BEHIND_THE_SCENES) {
    if (!text.includes(word)) continue
    issues.push({
      level: 'error',
      message:
        `「${word}」に触れています（templates/writing.md 2節）。` +
        '配信の裏側は素材に無く、推測になります。その分は作品の説明に使ってください。',
    })
  }

  // 「〜と考えられます」で推測を事実らしく見せない
  for (const m of text.matchAll(/[^。\n]*(?:と考えられます|とみられます)[^。\n]*。/g)) {
    issues.push({
      level: 'error',
      message:
        `推測を事実のように書いています: 「${clip(m[0], 50)}」` +
        '（templates/writing.md 3節）。推測が要る場面なら、そもそも書きません。',
    })
  }

  return issues
}

/** その月の作品名（邦題と原題の両方）。検査の除外リストに使う。 */
export function itemTitles(items: ChangeEvent[]): string[] {
  return items.flatMap((e) => [e.work.localizedTitle, e.work.title].filter((t): t is string => Boolean(t)))
}

/**
 * 地の文で評価スコアに言及している箇所。
 *
 * 評価は表にだけ載せる規約なので、表の行（`|` で始まる）は対象から外す。
 * 「読者が探しているのはその月に増えた作品であって、その日の最高得点ではない」
 * という判断がテンプレート側にあり、これはその機械的な担保。
 */
const RATING_IN_PROSE =
  /(評価(?:は|が|で)?\s*\d+|\d+\s*\/\s*100|評価(?:の高い|上位|が最も高|は今月|に次ぐ)|最高評価|評価だけで選ぶ)/

export function ratingMentionsInProse(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|'))
    .filter((l) => RATING_IN_PROSE.test(l))
}

export function clip(s: string, max = 40): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

// --- ショート動画の台本 ---------------------------------------------------

/**
 * 台本の候補に出す作品数の上限。**記事の素材と同じだけ渡す。**
 *
 * 30秒に載るのは4〜5本だが、候補を絞ってはいけない。
 * 1行40字ほどなので記事本体のプロンプトに比べれば無視できる量で、
 * 一方で切り詰めると**記事のフックになった作品が候補から落ちる**事故が起きる
 * （終了日順に上から24件だと、月の後半がまるごと消える）。
 */
const SHORT_CANDIDATES = 80

export interface ShortScriptOptions {
  /** 日付の呼び方。「終了日」「配信開始日」 */
  dateLabel: string
  /**
   * 素材が最初から邦題か（U-NEXT がこれ）。
   * false のときは `localizedTitle` が引けた作品だけを候補にする。
   */
  titlesAreLocalized: boolean
  /** 候補にする素材。記事と同じ並び順で渡す */
  candidates: ChangeEvent[]
  /** 締めの固定文言（差し込み済み） */
  closer: string
  /** 記事タイプ固有の追加ルール */
  extraRules?: readonly string[]
}

/**
 * ショート動画の台本の指示を組み立てる。
 *
 * ■ 記事タイプごとに違うのは3つだけ
 * 日付の呼び方・素材が邦題かどうか・固有の注意。それ以外は共通なので、
 * 構成も禁止事項も `templates/short-script.md` の1枚に集めてある。
 * 記事タイプを増やしても、このファイルと記事タイプ側の数行しか触らない。
 *
 * ■ 候補を「邦題が確定している作品」に絞る理由（音声固有）
 * 記事なら原題をそのまま書けば済む。**音声では英語の原題を読み上げても
 * 視聴者に伝わらず、読み方を推測した時点で誤情報になる。**
 * 記事の★注記に頼らず、候補の段階で機械的に外しておく。
 */
export function shortScriptSection(ctx: ArticleContext, opts: ShortScriptOptions): string {
  const template = readFileSync(themeFile(ctx.theme, 'templates', 'short-script.md'), 'utf8')
  const labelOf = serviceLabels(ctx)
  const offset = ctx.theme.utc_offset_minutes

  const speakable = opts.candidates
    .filter((e) => opts.titlesAreLocalized || e.work.localizedTitle)
    .slice(0, SHORT_CANDIDATES)

  const rows = speakable.map((e) => {
    const title = e.work.localizedTitle ?? e.work.title
    const date = e.at ? formatMonthDay(e.at, offset) : '日付未定'
    const service = labelOf.get(e.service) ?? e.service
    const year = e.work.year ? ` ／ ${e.work.year}年` : ''
    return `- ${title} ／ ${opts.dateLabel} ${date} ／ ${service}${year}`
  })

  const dropped = opts.candidates.length - speakable.length

  // カット6本を標準として字数の目安を出す。実際の上限はカット数で変わる。
  const budget = narrationBudget(6)

  const rules = [
    `**読み上げの合計は ${budget}字が目安**（カット6本のとき）。${SHORT_MAX_SECONDS}秒を超えたら作品を減らす。`,
    `1カットの読み上げは${SHORT_MAX_CUT_CHARS}字まで。`,
    '**記事で見つけた「まとまり」をそのままフックにする。** 別の切り口を新たに探さない。',
    '**「台本に出してよい作品」に無い作品を台本に出さない。** 邦題が確定しておらず、読み上げられないため。',
    '評価スコアを音声にも画面にも出さない。',
    ...(opts.extraRules ?? []),
  ]

  return `# ショート動画の台本（記事と同時に作る）

記事を書き終えたら、**続けてショート動画の台本のたたき台を1本**作ってください。
ユーザーが手で詰めて完成させる前提のたたき台です。完成品を目指さなくてよい。

${template}

---

## 締めの固定文言（一字一句そのまま）

${opts.closer}

---

## 台本に出してよい作品（${speakable.length}件）

${rows.join('\n')}
${dropped > 0 ? `\n※ 邦題が確定していない${dropped}件は候補から外してあります。台本に出さないでください。\n` : ''}
---

## 出力

${SHORT_OUTPUT_FORMAT}

特に重要な作業:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
}

/**
 * LLM の出力を行単位の検査にかけられる形に整える。
 * CRLF のままだと一致せず、「検査したが何も見つからなかった」ように見えてしまう。
 */
export function normalizeBody(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
}
