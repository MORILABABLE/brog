/**
 * 記事タイプ: 配信終了（expiring）
 *
 * 収集済みの expiring イベントから「今月終了する作品」の記事を作る。
 * 終了日はAPIが返す確定情報なので、推測記事ではなく事実記事になる。
 */
import { readFileSync } from 'node:fs'
import { OUTPUT_FORMAT, type ArticleContext, type ArticleType } from '../../../pipeline/core/article.ts'
import { buildSearchLinks } from '../../../pipeline/core/search-links.ts'
import { currentYearMonth, formatMonthDay } from '../../../pipeline/core/datetime.ts'
import { themeFile } from '../../../pipeline/theme.ts'
import type { ChangeEvent } from '../../../pipeline/sources/types.ts'
import type { Ledger } from '../../../pipeline/core/events.ts'

/** 1記事に載せる上限。多すぎると本文が薄くなり、max_tokens も圧迫する。 */
const MAX_ITEMS = 32

export const leavingArticle: ArticleType = {
  id: 'leaving',
  category: 'leaving',

  select(events, _ledger: Ledger, ctx) {
    return events
      .filter((e) => e.kind === 'expiring')
      // 終了日が不明なものは記事にできない
      .filter((e) => e.at)
      // 当月に終了するものだけ。判定はサイトの基準タイムゾーンで行う。
      .filter((e) => sameMonthInSiteTz(e.at!, ctx))
      .sort((a, b) => a.at!.localeCompare(b.at!))
      .slice(0, MAX_ITEMS)
  },

  buildPrompt(items, ctx) {
    const template = readFileSync(themeFile(ctx.theme, 'templates', 'leaving.md'), 'utf8')
    const labelOf = new Map(ctx.theme.catalogs.map((c) => [c.key, c.label]))
    const offset = ctx.theme.utc_offset_minutes

    const rows = items.map((e) => {
      const links = buildSearchLinks(e.work, ctx.theme.search_links ?? [])
      const title = e.work.localizedTitle ?? e.work.title
      const note = e.work.localizedTitle
        ? `（原題: ${e.work.title}）`
        : '（★邦題が未確認。この原題のまま書くこと）'

      return [
        `- ${title} ${note}`,
        `  サービス: ${labelOf.get(e.service) ?? e.service}`,
        `  終了日: ${formatMonthDay(e.at!, offset)}`,
        e.work.year ? `  公開年: ${e.work.year}年` : '',
        e.work.rating ? `  評価: ${e.work.rating}/100` : '',
        e.work.genres.length ? `  ジャンル: ${e.work.genres.join(' / ')}` : '',
        e.work.overview ? `  あらすじ(英語原文): ${e.work.overview}` : '',
        links.length ? `  検索リンク: ${links.map((l) => `[${l.label}](${l.url})`).join(' / ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    const system = `あなたは動画配信サービスの情報を扱う日本語ブログの編集者です。
与えられたデータだけを使って記事を書きます。データに無い事実を書いてはいけません。

${template}

${OUTPUT_FORMAT}`

    const prompt = `以下は今月配信終了が確定している作品のデータです。全${items.length}件。

${rows.join('\n\n')}

---

このデータから記事を書いてください。

特に重要な作業:
1. 終了日を見比べて「同じ日に終了するまとまり」を探すこと。
   同一監督・同一シリーズ・同一ジャンルの集中があれば、それを記事の軸にする。
2. あらすじは英語で与えられています。日本語で書き直してください（直訳ではなく要約でよい）。
3. 「★邦題が未確認」と書かれた作品は、**与えられた原題をそのまま**使ってください。
   日本語タイトルを推測して書いてはいけません。
4. 記事の最後に必ず次の1行を入れてください:
   > 配信情報は Streaming Availability API by Movie of the Night 提供`

    return { system, prompt }
  },

  tags(items, ctx) {
    const labelOf = new Map(ctx.theme.catalogs.map((c) => [c.key, c.label]))
    const services = [...new Set(items.map((e) => labelOf.get(e.service) ?? e.service))]
    const month = currentYearMonth(ctx.theme.utc_offset_minutes)
    const [y, m] = month.split('-')
    return [...services, '配信終了', `${y}年${Number(m)}月`]
  },

  slug(ctx) {
    return `${currentYearMonth(ctx.theme.utc_offset_minutes)}-leaving`
  },

  verify(md, items) {
    const issues: string[] = []

    // 全終了作品リスト（表）があるか
    if (!md.includes('|')) {
      issues.push('全終了作品の一覧表がありません。テンプレートの構成4が守られていません。')
    }
    // 他サービス検索リンクがあるか（収益導線かつ読者の実用性）
    if (!/U-NEXT|Hulu|DMM/.test(md)) {
      issues.push('他サービスでの検索リンクがありません。テンプレートの構成5が守られていません。')
    }
    // 「配信中」と断定していないか（把握していないサービスについての誤情報）
    if (/U-NEXTで配信中|Huluで配信中|DMM TVで配信中/.test(md)) {
      issues.push(
        '対象外サービスについて「配信中」と断定しています。配信状況のデータを持っていないため書けません。',
      )
    }
    if (items.length > 0 && !md.includes(String(items.length))) {
      // 本数の明記はリードの要件。無くても致命的ではないので警告扱いにしない
    }
    return issues
  },
}

/** サイトのタイムゾーンで当月かどうか */
function sameMonthInSiteTz(iso: string, ctx: ArticleContext): boolean {
  const shifted = new Date(Date.parse(iso) + ctx.theme.utc_offset_minutes * 60_000)
  return shifted.toISOString().slice(0, 7) === currentYearMonth(ctx.theme.utc_offset_minutes)
}
