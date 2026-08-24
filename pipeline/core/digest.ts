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

/** 無料枠のこの割合を超えたら警告する */
const QUOTA_WARN_RATIO = 0.8

export interface Digest {
  subject: string
  body: string
  /** 通知すべき変化が1件も無い。呼び出し側はこのとき送らない。 */
  isEmpty: boolean
}

export interface DigestOptions {
  theme: Theme
  /** 今回の通知が対象とする収集の時刻（複数回ぶんをまとめることがある） */
  collectedAt: string[]
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

  const subject = `[収集] ${when} 新規${events.length}件` + (expiring.length ? ` / 終了予定${expiring.length}件` : '')

  const lines: string[] = []
  lines.push(`収集 **${when}** ／ 前回の通知以降に増えた変化 **${events.length}件**`, '')

  lines.push(...breakdownSection(events, label))
  if (expiring.length) lines.push(...expiringSection(expiring, label, tz, now))
  if (usage) lines.push(...quotaSection(usage))

  lines.push(
    '---',
    '',
    '記事にできる素材の一覧は `npm run write -- --list`。',
    '対応が済んだらこの Issue を閉じてください。',
  )

  return { subject, body: lines.join('\n'), isEmpty: events.length === 0 }
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
