/**
 * 収集結果を「運用者に届ける1通」に組み立てる。
 *
 * ■ この層が何を知らないか
 * **データソースを知らない。** 読むのは `ChangeEvent` の列だけで、
 * Streaming Availability API という言葉はここに一度も出てこない。
 * 将来 U-NEXT なりを別アダプタで足しても、`theme.yaml` の `catalogs` に
 * 1行増えるだけで、このファイルは**一切変わらない**。
 * （収集ソースを差し替え可能にしたのと同じ発想を、出口側にも通している）
 *
 * ■ 通知先も知らない
 * 返すのは件名と Markdown 本文だけ。どこへ送るかは `pipeline/notify/` の仕事。
 * 「何を書くか」と「どこへ送るか」を分けておくと、
 * 通知先を増やすときに本文の組み立てを触らずに済む。
 *
 * ■ サイトには出さない
 * ここで作るのは運用者向けの内部資料であって記事ではない。
 * 出力は通知先へ渡すだけで、`site/` からは参照しない
 * （`site/src/lib/events-data.ts` が読むのは `data/events/*.jsonl` だけ）。
 */
import type { Theme } from '../theme.ts'
import type { ChangeEvent, ChangeKind } from '../sources/types.ts'
import { daysUntil, formatIsoDate, formatMonthDay } from './datetime.ts'
import type { UsageSnapshot } from './api-usage.ts'
import { rewriteCommand } from './article-log.ts'
import { staleSummary, type LiveElsewhereRow, type StaleArticle } from './stale.ts'

/** 表に出す変化の種類と、その見出し。並び順もこの通りにする。 */
const KIND_LABELS: Record<ChangeKind, string> = {
  new: '配信開始',
  expiring: '終了予定',
  removed: '終了済み',
  upcoming: '開始予定',
}
const KIND_ORDER: ChangeKind[] = ['new', 'expiring', 'removed', 'upcoming']

/**
 * 終了予定の表に載せる上限。
 * 月初の一斉終了は100件を超えることがあり、全部並べると
 * 肝心の「今週中に消えるもの」が下へ流れて読まれなくなる。
 */
const MAX_EXPIRING_ROWS = 50

/** これを割り込んだ終了予定に印を付ける（日） */
const URGENT_DAYS = 7

/**
 * 「まもなく見放題配信開始」に載せる先の日数。
 *
 * ■ ここだけ差分ではなく在庫を出す理由
 * 配信開始予定は各社が**前月末に一度だけ**まとめて公表する。差分だけを送ると、
 * その1通を読み逃した時点で「9月10日に何が始まるか」は通知から永久に消える。
 * 毎回あたらしいものが出てくる終了予定とは出方が違うので、扱いも変える。
 *
 * 7日にしたのは終了予定の「⚠」と同じ幅にして、読み手の基準を1つにするため。
 * 在庫の全体は data/UPCOMING.md（`npm run stock` が毎日書き直す）にある。
 */
const SOON_DAYS = 7

/** 「まもなく見放題配信開始」の表に載せる上限。月初は数十件が同じ日に集まる。 */
const MAX_SOON_ROWS = 40

/** 無料枠のこの割合を超えたら警告する */
const QUOTA_WARN_RATIO = 0.8

export interface Digest {
  subject: string
  body: string
  /** 知らせることが1件も無い。呼び出し側はこのとき送らない。 */
  isEmpty: boolean
  /**
   * 本日から配信が始まる作品の数。
   * **収集の差分が0でも送る**かどうかを、呼び出し側がこれで決める。
   */
  startsToday: number
  /**
   * 書き直しどきの記事の本数。**これも収集の差分が0でも送る理由になる**
   * （終了日が過ぎるのは収集の差分に出ない出来事なので、差分で待つと永久に届かない）。
   */
  staleCount: number
  /**
   * 他社に生きている観測が残っている作品の件数。
   * **これも収集の差分が0でも送る理由になる**（食い違いは差分に出てこない）。
   */
  liveCount: number
}

export interface DigestOptions {
  theme: Theme
  /** 今回の通知が対象とする収集の時刻（複数回ぶんをまとめることがある） */
  collectedAt: string[]
  /**
   * 収集済みの**全**イベント。差分ではなく在庫を見る欄（まもなく配信開始）に使う。
   * 渡さなければその欄は出ない。
   */
  stock?: ChangeEvent[]
  /**
   * 書き直しどきの記事（`core/stale.ts`）。渡さなければその欄は出ない。
   *
   * ★ 判定そのものはここでは行わない。記事タイプと控えを読む処理は
   *   このファイルの担当（「収集結果を1通に組み立てる」）の外にある。
   *   呼び出し側（`cli/notify.ts`）が計算して渡す。
   */
  stale?: StaleArticle[]
  /**
   * 「終了しました」と書いた作品に、他社の生きている観測が残っているもの
   * （`core/stale.ts` の `liveElsewhereRows()`）。渡さなければその欄は出ない。
   */
  live?: LiveElsewhereRow[]
  usage?: UsageSnapshot
  now?: Date
}

export function buildDigest(events: ChangeEvent[], opts: DigestOptions): Digest {
  const { theme, collectedAt, usage } = opts
  const now = opts.now ?? new Date()
  const tz = theme.utc_offset_minutes
  const label = new Map(theme.catalogs.map((c) => [c.key, c.label]))

  // 収集日。1回ぶんなら「8月25日」、まとめて通知するなら期間で出す。
  const dates = [...new Set(collectedAt.map((c) => formatIsoDate(c, tz)))].sort()
  const when = dates.length <= 1 ? (dates[0] ?? formatIsoDate(now.toISOString(), tz)) : `${dates[0]}〜${dates.at(-1)}`

  const expiring = events
    .filter((e) => e.kind === 'expiring')
    // 日付不明は末尾へ。並べ替えの基準が無いものを先頭に置くと読み手が混乱する。
    .sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'))

  // 配信開始予定（各社が前月末に出す翌月のラインナップ）。
  // 終了予定と違って**月に一度まとまって出る**ので、出た月だけこの欄が付く。
  const upcoming = events
    .filter((e) => e.kind === 'upcoming')
    .sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'))

  // まもなく配信が始まるもの。**差分ではなく在庫**から選ぶ（SOON_DAYS の説明）。
  const soon = pickSoon(opts.stock ?? [], tz, now)
  const startsToday = soon.filter((e) => daysUntil(e.at!, tz, now) === 0).length

  const stale = opts.stale ?? []
  const live = opts.live ?? []

  const counts = [
    events.length ? `新規${events.length}件` : '',
    expiring.length ? `終了予定${expiring.length}件` : '',
    upcoming.length ? `開始予定${upcoming.length}件` : '',
    // 件名で分かるようにする。「今日から見られる」は通知を開く動機が他と違う。
    startsToday ? `本日開始${startsToday}件` : '',
    // 書き直しは**公開済みの記事の話**で、他の欄（これから書く記事の素材）と用が違う
    stale.length ? `書き直し${stale.length}本` : '',
    // 件名に出す。**記事の誤りになりうる**ので、他の欄より開く動機が強い
    live.length ? `要確認${live.length}件` : '',
  ].filter(Boolean)
  const subject = `[収集] ${when}${counts.length ? ` ${counts.join(' / ')}` : ''}`

  const lines: string[] = []
  lines.push(
    events.length
      ? `収集 **${when}** ／ 前回の通知以降に増えた変化 **${events.length}件**`
      : `**${when}** ／ 前回の通知以降に増えた変化はありません（本日から始まる作品のお知らせです）`,
    '',
  )

  /*
   * ★ **いちばん上に出す。** 他の欄は「これから書く記事の素材」だが、
   *   ここだけは**すでに公開している記事が、いま読者に誤った事実を見せている**話。
   *   下に置くと、件数の多い終了予定の表に押し流されて読まれない。
   */
  /*
   * ★ **書き直しより上。** 書き直しは手順が決まっているが、こちらは
   *   「公開中の記事が誤っているかもしれない」という話で、判断が要る。
   */
  if (live.length) lines.push(...liveSection(live))
  if (stale.length) lines.push(...staleSection(stale))
  if (events.length) lines.push(...breakdownSection(events, label))
  if (soon.length) lines.push(...soonSection(soon, label, tz, now))
  if (expiring.length) lines.push(...expiringSection(expiring, label, tz, now))
  if (upcoming.length) lines.push(...upcomingSection(upcoming, label, tz))
  if (usage) lines.push(...quotaSection(usage))

  lines.push(
    '---',
    '',
    '記事にできる素材の一覧は `npm run write -- --list`。',
    '対応が済んだらこの Issue を閉じてください。',
  )

  return {
    subject,
    body: lines.join('\n'),
    // 差分が無くても「本日から配信開始」「書き直しどき」「要確認」があるなら知らせる。
    isEmpty: events.length === 0 && startsToday === 0 && stale.length === 0 && live.length === 0,
    startsToday,
    staleCount: stale.length,
    liveCount: live.length,
  }
}

/**
 * **「終了しました」と書いた作品が、他社では生きている観測のまま。**
 *
 * ■ なぜ通知に載せるのか（2026-09-02 追加）
 * シリーズ記事が `ended` に切り替わる判定は、**その記事が選んだ素材だけ**を見ている。
 * 他社での配信開始は素材に入らないので、
 * 「Netflixで終了、しかしAmazon Prime Videoでは配信開始を観測したまま」の作品があっても
 * 記事は素材の範囲で「終了しました」と書く。**公開後に誤りになりうる唯一の形。**
 *
 * ■ 断定しない
 * 当サイトが持っているのは変化の観測であって在庫ではない
 * （`site/src/lib/works.ts` 冒頭の「絶対に守ること」）。
 * `new` を観測して `removed` を観測していないことは、いま観られることを意味しない。
 * **ここが渡すのは「確かめる材料」まで。** 文面でも言い切らないこと。
 *
 * ■ 書き直しの欄と分ける
 * 書き直しても直らない（記事の素材が変わるわけではない）。
 * 同じ表に混ぜると、片づけたのに消えない行になる（`core/stale.ts`）。
 */
function liveSection(live: LiveElsewhereRow[]): string[] {
  const out = ['## 要確認: 「終了しました」と書いた作品が、他社では生きています', '']
  out.push(
    `公開中の記事に **${live.length}件**、当サイトのデータと食い違う作品があります。`,
    '',
    '| 記事 | 作品 | 終了と書いた先 | 生きている観測 |',
    '|---|---|---|---|',
  )
  for (const r of live) {
    const how = r.kind === 'leaving' ? '終了予定日がまだ先' : '配信開始を観測したまま'
    out.push(`| \`${r.slug}\` | ${r.title} | ${r.offLabel} | ${r.liveLabel}（${how}） |`)
  }
  out.push(
    '',
    '**「他社で配信中」とは言えません。** 当サイトが持っているのは変化の観測であって、',
    'いまの在庫ではありません（Disney+ と Apple TV+ は終了予定を返さず、終了の観測も遅れて出ます）。',
    '',
    '実際の配信状況を確かめて、記事が「終了しました」と言い切ってよいかを判断してください。',
    '',
  )
  return out
}

/**
 * **公開済みの記事が、いまのデータと食い違っている。**
 *
 * ■ なぜ通知に載せるのか（2026-09-02 追加）
 * 終了日が過ぎるのは**収集の差分に一度も出てこない出来事**。
 * 予告した日に何かが届くわけではなく、ただ過ぎるだけなので、
 * 差分を待っていると「終了予定の記事が終了済みになった」瞬間は永久に届かない。
 *
 * シリーズ記事は月を名乗らないURLを書き直し続ける記事なので、
 * 書き直すまで**タイトルもバッジも表の全行も「終了予定」と言い続ける。**
 * 気づける場所を毎日走る通知に置いておく（判定は `core/stale.ts`）。
 *
 * ■ コマンドまで載せる
 * 配信開始予定の欄（`upcomingSection`）と同じ考え方。
 * **その場で打てる1行**が無いと、通知を見てから調べ直すことになる。
 * `--topic` と `--match` は人が決めた値で記事のどこにも残らないので、
 * 控え（`core/article-log.ts`）から組み立てて出す。
 */
function staleSection(stale: StaleArticle[]): string[] {
  const out = ['## 書き直しどきの記事', '']
  out.push(
    `公開済みの記事 **${stale.length}本**が、いまのデータと食い違っています。`,
    '月を名乗らない記事（保存版）は、書き直すまで古い事実を言い続けます。',
    '',
    '| 記事 | 食い違い | 素材 |',
    '|---|---|--:|',
  )
  for (const s of stale) {
    out.push(`| \`${s.record.slug}\` | ${staleSummary(s)} | ${s.items.length}件 |`)
  }
  out.push('', '**書き直すコマンド**（1行ずつ。`--emit` のあとは記事を書いて `--apply`）', '')
  out.push('```')
  for (const s of stale) out.push(rewriteCommand(s.record, s.type))
  out.push('```')
  out.push('', 'まとめて回すなら `npm run write -- --refresh`（対話セッションなら `/refresh`）。', '')
  return out
}

/**
 * まもなく配信が始まる作品を在庫から選ぶ。
 *
 * 同じ作品が複数回 upcoming として記録されることは無い（収集時に台帳が弾く）が、
 * 告知元が増えたときに二重に載らないよう、ここでも念のため潰しておく。
 */
function pickSoon(stock: ChangeEvent[], tz: number, now: Date): ChangeEvent[] {
  const seen = new Set<string>()
  return stock
    .filter((e) => {
      if (e.kind !== 'upcoming' || !e.at) return false
      const days = daysUntil(e.at, tz, now)
      // 過ぎたものは落とす。配信が始まったあとの「予定」は読み手を混乱させる。
      if (days < 0 || days > SOON_DAYS) return false
      const key = `${e.service}:${e.work.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort(
      (a, b) =>
        a.at!.localeCompare(b.at!) ||
        (a.work.localizedTitle ?? a.work.title).localeCompare(b.work.localizedTitle ?? b.work.title),
    )
}

/**
 * サービス×種別の件数。
 *
 * 縦にサービス・横に種別の表にしている。
 * 「ある社だけ終了予定が0件のまま」のような**取りこぼしの兆候**は、
 * 平坦な一覧より行を見比べられる形のほうが気づける。
 */
function breakdownSection(events: ChangeEvent[], label: Map<string, string>): string[] {
  const kinds = KIND_ORDER.filter((k) => events.some((e) => e.kind === k))
  if (kinds.length === 0) return []

  const services = [...new Set(events.map((e) => e.service))].sort()
  const count = (service: string, kind: ChangeKind) =>
    events.filter((e) => e.service === service && e.kind === kind).length

  const out = ['## 内訳', '']
  out.push(`| サービス | ${kinds.map((k) => KIND_LABELS[k]).join(' | ')} | 計 |`)
  out.push(`|---|${kinds.map(() => '--:').join('|')}|--:|`)

  for (const s of services) {
    const cells = kinds.map((k) => count(s, k))
    const total = cells.reduce((a, b) => a + b, 0)
    out.push(`| ${label.get(s) ?? s} | ${cells.join(' | ')} | ${total} |`)
  }

  const totals = kinds.map((k) => events.filter((e) => e.kind === k).length)
  out.push(`| **計** | ${totals.map((n) => `**${n}**`).join(' | ')} | **${events.length}** |`, '')
  return out
}

/**
 * 新たに判明した配信終了予定。
 *
 * ここが通知の主目的。API が終了予定を出す猶予はサービスで全く違い、
 * Prime Video は**11日前にしか出さない**（docs/HANDOVER.md に実測あり）。
 * つまり「先週見たときは無かった終了予定」が毎回出てくるので、
 * 収集のたびに差分だけを見られる形にしておく必要がある。
 */
function expiringSection(
  expiring: ChangeEvent[],
  label: Map<string, string>,
  tz: number,
  now: Date,
): string[] {
  const out = ['## 新たに判明した配信終了予定', '']
  out.push('| 終了日 | 残り | サービス | 作品 |')
  out.push('|---|--:|---|---|')

  for (const e of expiring.slice(0, MAX_EXPIRING_ROWS)) {
    const title = e.work.localizedTitle ?? e.work.title
    const service = label.get(e.service) ?? e.service

    if (!e.at) {
      out.push(`| 日付未定 | — | ${service} | ${title} |`)
      continue
    }
    const days = daysUntil(e.at, tz, now)
    // 収集から通知までの間に過ぎることがある。伏せずにそのまま出す。
    const left = days < 0 ? '**終了済**' : days === 0 ? '**本日**' : days <= URGENT_DAYS ? `**${days}日** ⚠` : `${days}日`
    out.push(`| ${formatMonthDay(e.at, tz)} | ${left} | ${service} | ${title} |`)
  }

  if (expiring.length > MAX_EXPIRING_ROWS) {
    out.push('', `※ 終了日の近い ${MAX_EXPIRING_ROWS}件のみ表示（残り ${expiring.length - MAX_EXPIRING_ROWS}件）。`)
  }
  out.push('')
  return out
}

/**
 * 新たに公表された配信開始予定（＝翌月のラインナップ）。
 *
 * ■ 終了予定と役割が違う
 * 終了予定は「差分を追い続ける」欄だが、こちらは**月に一度、まとめて出る**。
 * 各社が前月末に翌月のラインナップを告知した回にだけ現れ、
 * それは同時に「先出しの記事を1本書ける」という合図になる。
 * だから件数と日付の範囲を出したうえで、**書き出しのコマンドまで載せる。**
 *
 * 作品名を全部並べない（数十〜百件になる）。並べるのは日付ごとの件数だけで、
 * 中身は記事を書くときに `npm run write -- --emit` が渡してくれる。
 */
function upcomingSection(
  upcoming: ChangeEvent[],
  label: Map<string, string>,
  tz: number,
): string[] {
  const out = ['## 新たに公表された配信開始予定', '']

  const services = [...new Set(upcoming.map((e) => e.service))]
  for (const s of services) {
    const list = upcoming.filter((e) => e.service === s)
    const dated = list.filter((e) => e.at)
    const range =
      dated.length > 0
        ? `${formatMonthDay(dated[0]!.at!, tz)}〜${formatMonthDay(dated.at(-1)!.at!, tz)}`
        : '日付未定'
    out.push(`- **${label.get(s) ?? s}** ${list.length}件（${range}）`)
  }

  out.push(
    '',
    // ★ この欄は「前回以降に増えたぶん」しか出せない。**いま何が貯まっているか**は
    //   data/UPCOMING.md（`npm run stock` が毎日書き直す）を見てもらう。
    //   通知を1通読み逃しても在庫が分からなくならないようにするため。
    'いま何が貯まっているかの全体は **[data/UPCOMING.md](../../blob/main/data/UPCOMING.md)** にあります。',
    '',
    '記事にするには（サービスと対象月は読み替えてください）:',
    '',
    '```',
    '# サービス別に1本（ジャンルが取れない Netflix / Disney+ はこちら）',
    'npm run write -- --type upcoming-service --service <サービス> --month YYYY-MM --emit',
    '',
    '# ジャンル別に1本ずつ（告知に区分がある Prime Video 向け）',
    'npm run write -- --type upcoming --genre anime    --service <サービス> --month YYYY-MM --emit',
    'npm run write -- --type upcoming --genre western  --service <サービス> --month YYYY-MM --emit',
    'npm run write -- --type upcoming --genre japanese --service <サービス> --month YYYY-MM --emit',
    '```',
    '',
  )
  return out
}

/**
 * まもなく見放題配信が始まる作品（＝すでに公表されている「◯月◯日 見放題配信開始」）。
 *
 * ■ ほかの欄と決定的に違うところ
 * 終了予定も開始予定も「前回の通知以降に増えたぶん」＝**差分**だが、
 * この欄だけは**在庫**（収集済みの全イベント）から毎回そのまま出す。
 * 告知は月に一度しか出ないので、差分で出すと公表された日の1通にしか載らない。
 * 実際に配信が始まる日には何も通知されず、**察知が遅れる**（というより届かない）。
 *
 * ■ ここでは件数ではなく作品名を並べる
 * 「新たに公表された配信開始予定」は数十〜百件になるので件数だけにしているが、
 * こちらは7日以内に絞ってあるぶん短い。日付と作品名が並んでいて初めて
 * 「今日から見られるのはこれ」が分かり、記事を出す合図として使える。
 */
function soonSection(
  soon: ChangeEvent[],
  label: Map<string, string>,
  tz: number,
  now: Date,
): string[] {
  const out = ['## まもなく見放題配信開始', '']
  out.push(`各社が公表した見放題ラインナップのうち、**${SOON_DAYS}日以内**に始まるもの。`, '')
  out.push('| 開始日 | あと | サービス | 作品 |')
  out.push('|---|--:|---|---|')

  for (const e of soon.slice(0, MAX_SOON_ROWS)) {
    const days = daysUntil(e.at!, tz, now)
    const left = days === 0 ? '**本日** ★' : days === 1 ? '**明日**' : `${days}日`
    const title = e.work.localizedTitle ?? e.work.title
    out.push(`| ${formatMonthDay(e.at!, tz)} | ${left} | ${label.get(e.service) ?? e.service} | ${title} |`)
  }

  if (soon.length > MAX_SOON_ROWS) {
    out.push('', `※ 開始日の近い ${MAX_SOON_ROWS}件のみ表示（残り ${soon.length - MAX_SOON_ROWS}件）。`)
  }
  out.push(
    '',
    // 在庫の全体はここにある。7日より先のぶんを見たいときの行き先を必ず示す。
    `${SOON_DAYS}日より先のぶんを含む在庫の全体は **[data/UPCOMING.md](../../blob/main/data/UPCOMING.md)**。`,
    '',
  )
  return out
}

/** API無料枠の消費。429 で収集が止まってから気づくのを避けるための欄。 */
function quotaSection(usage: UsageSnapshot): string[] {
  const out = ['## API無料枠', '']

  // 記録が無い月に「0 / 500」と出すと、実際は消費しているのに
  // 枠が丸ごと余っているように読めてしまう。数えていないことを明示する。
  if (!usage.tracked) {
    out.push(
      `${usage.month} は計測開始前のため記録がありません（枠は ${usage.limit}リクエスト/月）。`,
      '次回の収集ぶんから消費量が出ます。',
      '',
    )
    return out
  }

  const left = usage.limit - usage.used
  const warn = usage.used >= usage.limit * QUOTA_WARN_RATIO
  out.push(
    `${usage.month} の消費 **${usage.used} / ${usage.limit}** リクエスト（残り ${left}）` +
      (warn ? ' ⚠ **枠が残り少なくなっています**' : ''),
    '',
    '※ このリポジトリから投げた回数の概算。正確な残量は提供元のダッシュボードで確認してください。',
    '',
  )
  return out
}
