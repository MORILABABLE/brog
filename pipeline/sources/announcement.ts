/**
 * 配信各社が前月末に出す「翌月の配信開始ラインナップ」の告知を読む。
 *
 * ■ なぜ要るのか
 * Streaming Availability API の `upcoming`（配信開始予定）は、日本のカタログでは
 * 4社とも0件しか返らない（theme.yaml の実測コメント）。一方で各社は
 * **前月末に翌月のラインナップを自社サイトで告知している。**
 * 配信が始まる前に「9月から配信開始」を書ける素材は、いまのところここにしかない。
 *
 * ■ 何を取り、何を取らないか
 * 取るのは**事実だけ**。作品名・配信開始日・見放題／独占の区分の3つ。
 *
 * **紹介文と画像は取らない。**
 *   - 紹介文は先方が書いた文章そのもので、引用の範囲を超えて使えば複製になる
 *   - 画像は再配信の許諾が無い。記事の画像は posters.mjs の経路
 *     （Movie of the Night に照会して 2026-08-25 に許諾済み）だけを使う
 * 記事の文章はこちらで書く。告知は「何がいつ始まるか」の一次情報としてだけ扱う。
 *
 * ■ 相手への負荷
 * About Amazon の robots.txt は `User-agent: * / Crawl-delay: 10` のみで
 * Disallow は無い（2026-08-28 実測）。読むのは月に1ページだが、
 * 同じホストへの連続取得には10秒空ける（`MIN_INTERVAL_MS`）。
 * U-NEXT の `min_interval_ms` と同じ考え方で、**速くしたくなっても下げないこと。**
 *
 * ■ 静かに0件にならないこと
 * 告知ページのHTMLは先方の都合で変わる。解析の目印が消えていたら
 * **0件を返すのではなく例外を投げる。** 「まだ出ていない(404)」と
 * 「読めなくなった」を取り違えると、壊れたことに気づけなくなる。
 */
import { createHash } from 'node:crypto'
import type { ChangeEvent, Work } from './types.ts'

/** robots.txt の Crawl-delay。**下げないこと。** */
export const MIN_INTERVAL_MS = 10_000

/** 素性の分かる User-Agent を名乗る。ボットであることを隠さない。 */
const USER_AGENT =
  'brog/0.1 (monthly lineup reader for a Japanese streaming blog; 1 page per month)'

const FETCH_TIMEOUT_MS = 20_000

/** URL に埋める英語の月名（About Amazon の URL 規則） */
const MONTH_EN = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const

/** theme.yaml の `announcements:` 1件ぶん */
export interface AnnouncementConfig {
  /** theme.yaml の catalogs.key と揃える。イベントの service になる */
  service: string
  label: string
  /** 告知を出している主体。記事の出典表記に出す（例: About Amazon） */
  publisher: string
  /** 解析器の名前。`PARSERS` のキー */
  parser: string
  /** `{year}` `{month_en}` `{month}` を置換して使う */
  url: string
}

/** 告知から読み取れた1作品 */
export interface AnnouncedItem {
  /** 告知に書かれている表記のままの作品名（＝邦題）。推測で直さない */
  title: string
  /** 行そのもの。区分や注記を落とさずに記事の素材へ渡すために持つ */
  raw: string
  /** 告知側の見出し（例: 映画（海外・韓国）／テレビドラマ（日本）） */
  category: string
  /** 配信開始日（YYYY-MM-DD）。日付の無い節に出てきたものは undefined */
  date?: string
  /** ＊以降の注記（独占配信・見放題独占配信 など） */
  note?: string
  /** 告知に併記された国（韓国・中国 など） */
  country?: string
  /** 併記された原題（Prime Original『◯◯』（English／アメリカ）の English 部分） */
  originalTitle?: string
  /** 併記された公開年（「花咲舞が黙ってない (2014)」の 2014） */
  year?: number
  showType: 'movie' | 'series'
}

// --- 取得 -------------------------------------------------------------------

/** 直近の取得時刻。ホストごとに間隔を空けるために持つ */
const lastFetchAt = new Map<string, number>()

export function announcementUrl(cfg: AnnouncementConfig, ym: string): string {
  const [y, m] = ym.split('-')
  const mi = Number(m) - 1
  if (!y || !MONTH_EN[mi]) throw new Error(`月の指定が不正です: ${ym}（YYYY-MM の形で指定します）`)
  return cfg.url
    .replaceAll('{year}', y)
    .replaceAll('{month_en}', MONTH_EN[mi])
    .replaceAll('{month}', String(mi + 1).padStart(2, '0'))
}

/**
 * 告知ページを取ってくる。
 *
 * **404 は「まだ出ていない」を意味する**ので、例外ではなく null を返す。
 * 月末に毎日見に行く運用（.github/workflows/announce.yml）では
 * 出るまでの数日は必ず404になり、これをエラーにすると通知が鳴りっぱなしになる。
 */
export async function fetchAnnouncement(url: string): Promise<string | null> {
  const host = new URL(url).host
  const wait = MIN_INTERVAL_MS - (Date.now() - (lastFetchAt.get(host) ?? 0))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastFetchAt.set(host, Date.now())

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`告知ページを取得できません: ${res.status} ${url}`)
  return await res.text()
}

// --- 解析 -------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, String.fromCharCode(39))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 見出しから作品の種別を決める。ここだけで判断する */
function showTypeOf(category: string): 'movie' | 'series' {
  return /映画/.test(category) ? 'movie' : 'series'
}

/**
 * 1行ぶんの表記をほぐす。**原文は raw に必ず残す。**
 *
 * 実例:
 *   ・旅と日々 ＊独占配信
 *   ・劇場版「緊急取調室 THE FINAL」＊独占配信
 *   ・極限境界線　救出までの18日間（韓国）
 *   ・Prime Original『ザ・ランナー』（The Runner／アメリカ）
 *   ・花咲舞が黙ってない (2014)
 */
export function parseItemLine(line: string, category: string): AnnouncedItem | null {
  const raw = line.replace(/^[・･]\s*/, '').trim()
  if (!raw) return null

  // ＊以降は配信区分の注記。全角・半角の両方が使われている
  const parts = raw.split(/[＊*]/)
  const note = parts.slice(1).join(' ').trim() || undefined
  let title = (parts[0] ?? '').trim()
  let originalTitle: string | undefined
  let country: string | undefined
  let year: number | undefined

  // Prime Original『ザ・ランナー』（The Runner／アメリカ）
  const original = title.match(/『([^』]+)』(?:（([^（）]*)）)?/)
  if (original && /Prime Original/i.test(title)) {
    title = original[1]!.trim()
    const paren = original[2] ?? ''
    const [ot, co] = paren.split(/[／/]/)
    if (ot && ot.trim()) originalTitle = ot.trim()
    if (co && co.trim()) country = co.trim()
  }

  // 末尾の（韓国）（中国）。作品名の一部ではないので外す
  const tail = title.match(/（(韓国|中国|台湾|タイ|アメリカ|イギリス|フランス)）\s*$/)
  if (tail && tail.index !== undefined) {
    country ??= tail[1]
    title = title.slice(0, tail.index).trim()
  }

  // 末尾の (2014)。年として拾うが、**題名からは外さない。**
  //
  // ★ 外すと「花咲舞が黙ってない」が3つ（2014/2015/2024）とも同じ題名になり、
  //   記事の表に同じ行が3つ並ぶ。作品IDも同じになって1件に潰れる。
  //   告知がこの括弧で3作を区別している以上、区別ごと引き継ぐのが正しい。
  //   Wikidata に聞くときだけ外す（announced-works.ts の labelVariants）。
  const yearTail = title.match(/[（(](\d{4})[）)]\s*$/)
  if (yearTail) year = Number(yearTail[1])

  title = title.replace(/[\s　]+$/, '')
  if (!title) return null
  return {
    title,
    raw,
    category,
    note,
    country,
    originalTitle,
    year,
    showType: showTypeOf(category),
  }
}

/**
 * About Amazon（Prime Video）の月次ラインナップ記事を解析する。
 *
 * ページ後半の「◯年◯月新着予定作品一覧」以降だけを見る。
 * それより前は作品ごとの紹介文で、同じ体裁の箇条書きが混ざっているため、
 * 頭から読むと紹介文の一部を作品名として拾う（実測で確認）。
 *
 * 一覧の構造は素直で、**見出し(h2)がカテゴリ、太字が日付、`・`が作品**。
 *   <h2>映画（日本）</h2>
 *   <div class="text"><span class="boldText">…2026年9月1日（火）…</span>
 *     <span>・旅と日々 ＊独占配信</span><span>・白夜行</span></div>
 */
function parseAboutAmazon(html: string, ym: string): AnnouncedItem[] {
  const anchor = html.search(/新着(?:予定)?作品一覧/)
  if (anchor < 0) {
    throw new Error(
      '告知ページに「新着予定作品一覧」の見出しが見つかりません。' +
        'ページの作りが変わった可能性があります' +
        '（pipeline/sources/announcement.ts の parseAboutAmazon）',
    )
  }
  const tail = html.slice(anchor)
  const out: AnnouncedItem[] = []

  for (const section of tail.split(/<h2[^>]*>/).slice(1)) {
    const end = section.indexOf('</h2>')
    if (end < 0) continue
    const category = stripTags(section.slice(0, end))
    const body = section.slice(end)
    if (!category || /一覧/.test(category)) continue

    for (const block of body.match(/<div class="text">[\s\S]*?<\/div>/g) ?? []) {
      const dm = block.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
      const date = dm ? `${dm[1]}-${dm[2]!.padStart(2, "0")}-${dm[3]!.padStart(2, "0")}` : undefined
      // `>・` で始まる span だけを作品行とみなす。
      // 日付の「（水・祝）」の中黒を作品行と誤認しないための形。
      for (const m of block.matchAll(/>[・･]([^<]+)</g)) {
        const item = parseItemLine(m[1]!, category)
        if (item) out.push({ ...item, date })
      }
    }
  }

  // 対象月以外の日付が混ざっていたら落とす（前月の再掲や翌月の予告が入ることがある）
  return out.filter((i) => !i.date || i.date.startsWith(ym))
}

const PARSERS: Record<string, (html: string, ym: string) => AnnouncedItem[]> = {
  'about-amazon': parseAboutAmazon,
}

export function parseAnnouncement(parser: string, html: string, ym: string): AnnouncedItem[] {
  const fn = PARSERS[parser]
  if (!fn) {
    throw new Error(
      `解析器 ${parser} は未実装です（有効: ${Object.keys(PARSERS).join(', ')}）。` +
        'theme.yaml の announcements[].parser を確認してください',
    )
  }
  return fn(html, ym)
}

// --- イベント化 --------------------------------------------------------------

/**
 * 作品IDを作る。**告知には作品IDが無い**ので、こちらで決める。
 *
 * 台帳の重複判定キーは `service:kind:work.id`（core/events.ts）なので、
 * ここが実行のたびに変わると同じ告知を何度も新規として拾ってしまう。
 * 題名と配信開始日から決めれば、同じ告知は何度読んでも同じIDになる。
 *
 * ★ 後日 API が本物の `new` を返したときは kind が違うので別キーになり、
 *   「配信開始予定」を拾ったせいで「配信開始」を取りこぼすことはない。
 */
export function announcedWorkId(service: string, item: AnnouncedItem): string {
  const seed = `${service}|${item.title}|${item.date ?? ''}`
  return `ann-${createHash('sha1').update(seed).digest('hex').slice(0, 10)}`
}

/** 対象タイムゾーンの暦日 00:00 を ISO 文字列にする。日付の無い作品は undefined */
function atOf(date: string | undefined, utcOffsetMinutes: number): string | undefined {
  if (!date) return undefined
  const ms = Date.parse(`${date}T00:00:00Z`) - utcOffsetMinutes * 60_000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export function toEvents(
  items: AnnouncedItem[],
  cfg: AnnouncementConfig,
  opts: { url: string; utcOffsetMinutes: number; collectedAt?: string },
): ChangeEvent[] {
  const collectedAt = opts.collectedAt ?? new Date().toISOString()
  return items.map((item) => {
    const work: Work = {
      id: announcedWorkId(cfg.service, item),
      // ★ 告知は最初から邦題。原題を持っていないので title にも同じものを入れる。
      //   U-NEXT 由来のイベントと同じ形（docs/UNEXT.md 3.1）。
      title: item.title,
      localizedTitle: item.title,
      originalTitle: item.originalTitle,
      type: item.showType,
      year: item.year,
      // ★ あらすじは意図的に空。告知の紹介文は先方の文章なので取らない。
      overview: '',
      genres: [],
      meta: {
        // 出典表記の切り替えに使う（core/verify.ts の ATTRIBUTIONS）
        source: 'announcement',
        publisher: cfg.publisher,
        announcementUrl: opts.url,
        category: item.category,
        note: item.note,
        country: item.country,
        raw: item.raw,
      },
    }
    return {
      collectedAt,
      service: cfg.service,
      kind: 'upcoming' as const,
      at: atOf(item.date, opts.utcOffsetMinutes),
      work,
    }
  })
}
