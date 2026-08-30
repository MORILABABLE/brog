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

/** 同一ホスト内で追う転送の上限 */
const MAX_REDIRECTS = 5

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
  /** `{year}` `{month_en}` `{month}` `{yymm}` を置換して使う */
  url: string
  /**
   * URL が月を持たない告知元（ローリング窓）か。
   *
   * ★ 既定は false で、そのとき url に月の差し込みが無いと theme.ts が落とす。
   *   「毎月同じページを読んでいて月が変わっても気づかない」事故を止めるため。
   *   Netflix の新作情報のように**1枚のページが進んでいく**告知元だけ true にする。
   *   その場合、対象月での絞り込みは**解析器の責任**になる。
   */
  rolling?: boolean
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
  /**
   * 告知元が持っている作品ID。**あるならこれが作品IDになる**（`announcedWorkId`）。
   * 題名＋日付のハッシュより強い。日付がずれても同じ作品だと分かるため。
   * いまのところ Netflix の videoID だけが該当する。
   */
  sourceId?: string
  /** 告知元が示している作品ページ。記事に出典として載せる */
  link?: string
}

// --- 取得 -------------------------------------------------------------------

/** 直近の取得時刻。ホストごとに間隔を空けるために持つ */
const lastFetchAt = new Map<string, number>()

export function announcementUrl(cfg: AnnouncementConfig, ym: string): string {
  const [y, m] = ym.split('-')
  const mi = Number(m) - 1
  if (!y || !MONTH_EN[mi]) throw new Error(`月の指定が不正です: ${ym}（YYYY-MM の形で指定します）`)
  const mm = String(mi + 1).padStart(2, '0')
  return cfg.url
    .replaceAll('{year}', y)
    .replaceAll('{month_en}', MONTH_EN[mi])
    .replaceAll('{month}', mm)
    // Disney+ の `/recommend/2608` 形式（西暦下2桁＋月）
    .replaceAll('{yymm}', `${y.slice(-2)}${mm}`)
}

/**
 * 告知ページを取ってくる。
 *
 * **404 は「まだ出ていない」を意味する**ので、例外ではなく null を返す。
 * 月末に毎日見に行く運用（.github/workflows/announce.yml）では
 * 出るまでの数日は必ず404になり、これをエラーにすると通知が鳴りっぱなしになる。
 */
export async function fetchAnnouncement(url: string): Promise<string | null> {
  let current = url
  // ホストをまたぐ転送は追わない（下の理由）。同一ホスト内の転送だけ数回まで追う。
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const host = new URL(current).host
    const wait = MIN_INTERVAL_MS - (Date.now() - (lastFetchAt.get(host) ?? 0))
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastFetchAt.set(host, Date.now())

    const res = await fetch(current, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // ★ 自動で追わせない。追う先が読んでよいホストかを自分で判断する
      redirect: 'manual',
    })

    if (res.status === 404) return null

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`転送先が示されていません: ${res.status} ${current}`)
      const next = new URL(location, current)
      if (next.host !== host) {
        // ★ **ホストが変わったら止める。** robots.txt はホストごとに違う。
        //   実例: disneyplus.disney.co.jp/recommend/latest は
        //   www.disneyplus.com へ 301 するが、そちらの robots.txt は
        //   `User-agent: * / Disallow: /`（2026-08-30 実測）。
        //   自動で追うと、読んではいけないページを読んでしまう。
        //   転送先を読みたくなったら、そのホストの robots.txt を確かめてから
        //   theme.yaml の url を書き換えること。黙って追わせてはいけない。
        throw new Error(
          `告知ページが別ホストへ転送されました: ${current} → ${next.href}
` +
            '転送先の robots.txt を確認するまで取得しません' +
            '（pipeline/sources/announcement.ts の fetchAnnouncement）',
        )
      }
      current = next.href
      continue
    }

    if (!res.ok) throw new Error(`告知ページを取得できません: ${res.status} ${current}`)
    return await res.text()
  }
  throw new Error(`転送が多すぎます（${MAX_REDIRECTS}回）: ${url}`)
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

/**
 * Disney+ の月次ラインナップ（`/recommend/{YYMM}`）を解析する。
 *
 * ■ どのURLを読むか（**ここを間違えると読んではいけないページを読む**）
 * 同じ内容が3か所にあるが、読んでよいのは日付つきURLだけ。
 *
 *   disneyplus.disney.co.jp/recommend/2608     ← これを読む。robots.txt は `/` を許可
 *   disneyplus.disney.co.jp/news/2026/08_recommend  ← 同内容。同じホストなので可
 *   disneyplus.disney.co.jp/recommend/latest   ← **www.disneyplus.com へ 301。読まない**
 *
 * `latest` の転送先 www.disneyplus.com の robots.txt は `User-agent: * / Disallow: /`
 * で、許可されているのは名指しされた検索・SNS・広告のボットだけ（2026-08-30 実測）。
 * 転送を追わない仕掛けは `fetchAnnouncement` にある。
 *
 * ★ **日付つきページは月初にならないと立たないことがある。**
 *   2026-08-30 時点で `/recommend/2609`（9月分）は 404 で、
 *   9月の内容は `latest`＝読めないホストにしか無かった。
 *   404 は `fetchAnnouncement` が null にして「まだ出ていません」と出す。
 *   **0件を返して静かに済ませないこと。**
 *
 * ■ ページの構造
 * 「配信スケジュール」の見出し以降が、その月の全ラインナップ。
 *   <h4><span>8月1日(土)</span></h4>
 *   <p><span>タイム・アンド・ウォーター：氷河と共に生きる</span><br>
 *      <span>幼女戦記Ⅱ（第4話／23:00配信開始）</span><br></p>
 *
 * ページ前半（ピックアップ／映画／シリーズ）は紹介文つきの抜粋で、
 * 同じ作品が日付つきで後半にも出る。**後半だけを読む**（About Amazon と同じ考え方）。
 *
 * ■ 第2話以降を落とす理由
 * 配信スケジュールには放送中シリーズの毎週のエピソードが全部載る（8月は約570行）。
 * これは「今月から観られるようになるもの」ではないので、記事の素材にすると
 * **本当の新着が埋まる。** 第1話（＝シリーズの配信開始）と、話数表記の無い
 * 単発（映画・スペシャル）だけを残す。
 */
export function parseDisneyRecommend(html: string, ym: string): AnnouncedItem[] {
  const anchor = html.search(/配信スケジュール/)
  if (anchor < 0) {
    throw new Error(
      '告知ページに「配信スケジュール」の見出しが見つかりません。' +
        'ページの作りが変わった可能性があります' +
        '（pipeline/sources/announcement.ts の parseDisneyRecommend）',
    )
  }
  const year = ym.slice(0, 4)
  const out: AnnouncedItem[] = []

  for (const chunk of html.slice(anchor).split(/<h4[^>]*>/).slice(1)) {
    const end = chunk.indexOf('</h4>')
    if (end < 0) continue
    const dm = stripTags(chunk.slice(0, end)).match(/(\d{1,2})月(\d{1,2})日/)
    if (!dm) continue
    const date = `${year}-${dm[1]!.padStart(2, '0')}-${dm[2]!.padStart(2, '0')}`

    // 見出しの後ろから、その節が終わるまでが、その日の作品リスト。
    // ★ `</section>` で切ること。スケジュールの後ろには同じ体裁の宣伝ブロックが続き
    //   （「韓ドラも、KPOPコンテンツも、バラエティも。」など h3 の節）、
    //   節の終わりで止めないと、その紹介文と「もっと見る」を作品として拾う（実測）。
    let body = chunk.slice(end + 5)
    const stop = body.search(/<\/section>|<h2[^>]*>|<h3[^>]*>/)
    if (stop >= 0) body = body.slice(0, stop)

    for (const block of body.match(/<p[^>]*>[\s\S]*?<\/p>/g) ?? []) {
      for (const m of block.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)) {
        const item = parseDisneyLine(stripTags(m[1]!), date)
        if (item) out.push(item)
      }
    }
  }

  // 前月の積み残しや翌月の予告が混ざっていたら落とす（About Amazon と同じ）
  return out.filter((i) => i.date?.startsWith(ym))
}

/**
 * 配信スケジュールの1行をほぐす。**原文は raw に必ず残す。**
 *
 *   タイム・アンド・ウォーター：氷河と共に生きる
 *   幼女戦記Ⅱ（第4話／23:00配信開始）              → 第2話以降なので落とす
 *   いくつもの鋭い破片（第1話～第2話／10:00配信開始）  → 配信開始なので残す
 *   アダルト シーズン1（第1話／2:00配信開始）※プロローグエピソード追加
 */
function parseDisneyLine(line: string, date: string): AnnouncedItem | null {
  const raw = line.replace(/^[・･]\s*/, '').trim()
  if (!raw) return null

  // 末尾の ※ 以降は注記。作品名ではない
  let rest = raw
  let note: string | undefined
  const aster = rest.match(/[※＊*](.+)$/)
  if (aster) {
    note = aster[1]!.trim()
    rest = rest.slice(0, aster.index).trim()
  }

  // 末尾の括弧のうち、話数か配信開始時刻を書いているものだけを外す。
  // ★ 題名そのものに含まれる括弧（「（韓国ドラマ）」など）を削らないための絞り込み。
  let episode: string | undefined
  const meta = rest.match(/[（(]([^（）()]*(?:第\d+話|配信開始)[^（）()]*)[）)]\s*$/)
  if (meta && meta.index !== undefined) {
    episode = meta[1]!.trim()
    rest = rest.slice(0, meta.index).trim()
  }

  // 第2話以降は「放送中シリーズの今週ぶん」。配信開始ではないので素材にしない
  const epNo = episode?.match(/第(\d+)話/)
  if (epNo && Number(epNo[1]) > 1) return null

  const title = rest.replace(/[\s　]+$/, '').trim()
  if (!title) return null

  // 話数表記があれば連続もの。無くても「シーズン2」「第2期」は連続もの
  const isSeries =
    Boolean(episode?.includes('話')) || /シーズン\s*[0-9０-９]|第[0-9０-９一二三四五六七八九十]+期/.test(title)
  return {
    title,
    raw,
    // CLI の内訳表示に出る。`showTypeOf` の /映画/ 判定もここを見る
    category: isSeries ? 'シリーズ（配信開始）' : '映画・スペシャル',
    date,
    note: [episode, note].filter(Boolean).join(' ') || undefined,
    showType: isSeries ? 'series' : 'movie',
  }
}

/**
 * Netflix の「新作情報」（`about.netflix.com/ja/new-to-watch`）を解析する。
 *
 * ■ ここを読む理由
 * Netflix には**月次ラインナップの記事**が日本に無い（ニュースルームは作品ごとのPRだけ）。
 * 長いあいだ「報道各社しか出どころが無い」と整理していたが、
 * このページが**一次情報・構造化・robots許可**の3つを満たしていた（2026-08-30 発見）。
 *
 *   about.netflix.com/robots.txt … `User-agent: * / Disallow: /api/` だけ
 *   www.netflix.com/robots.txt   … `User-agent: * / Disallow: /`（**読まない**）
 *
 * ★ 禁止されているのは `/api/` なので、**ページ本体だけを読む。**
 *   クライアントが続きを取りに行く先は `/api/` 配下で、そこは叩かない。
 *   結果として1回で取れるのは**先頭20件・約11日先まで**になる
 *   （ページ側の申告は `totalItems: 46, totalPages: 3, perPage: 20`。
 *    `?page=2` の類はどれも1ページ目を返すので、続きはURLからは取れない）。
 *
 *   ★ **それでも取りこぼさない。** 並びは配信開始日の昇順なので、
 *     21件目以降は日が進めば先頭20件に入ってくる。毎日読んでいれば順に拾える。
 *
 * ■ ローリング窓であることが前提
 * このページは「月ぶんの一覧」ではなく**先頭20件が進んでいく窓**。
 * 1回読んだだけでは月の全体は取れない。**毎日読んで貯める**運用で月がつながる。
 * 同じ作品を何度読んでも、`sourceId`（videoID）が同じなので台帳が弾く。
 *
 * ■ 何が取れて、何が取れないか
 * 取れる: 邦題・配信開始日時（JST 16:00）・videoID・作品ページのURL
 * 取れない: **ジャンル区分（アニメ／洋画／邦画）**。このページは作品の国も種別も
 *   持っていない（`genre` は数値IDだけで、対応する名前がページに無い）。
 *   したがって `genres.ts` の `fromAnnouncementCategory` は当たらず、
 *   **ジャンル軸の記事（`upcoming --genre`）には出ない。**当て推量で振り分けない。
 *   Netflix の先出しを書くなら、いまは主題軸の特報
 *   （`special --kind upcoming --service netflix`）を使う。
 * 取れない: **旧作のライセンス作品**。このページは新作（オリジナル中心）で、
 *   実測では Netflix の `new` イベントの61%が2024年以前の作品だった（2026-08）。
 *   つまりこれは**月次ラインナップの全部ではなく、先出しできる部分**。
 *   残りは従来どおり配信APIが配信開始日に拾う。
 *
 * ■ データの形
 * Next.js の `__NEXT_DATA__` にそのまま入っている。HTMLの見た目に依存しない。
 *   { title1: "恋わずらい", startTime: 1788310800000, videoID: 81262894, genre: 1307182 }
 *
 * ■ ★ 対象月で絞らない（`ym` を使わない）
 * 月次ページ型の解析器は「そのページはその月のもの」なので対象月で絞ってよい。
 * こちらは違う。**窓は進んでいき、通り過ぎたものは二度と取れない。**
 *
 * 収集の既定の対象月は「翌月」なので、月の途中に走った日に翌月で絞ると、
 * 窓に入っている**当月ぶんが毎日そのまま捨てられる**（9月10日の窓は9月10〜21日で、
 * 10月で絞ると0件になる）。落としたぶんは後日どこからも拾えない。
 *
 * そこで**窓に見えたものは全部返す。** 月の切り分けは記事側がやる
 * （`shared.ts` の `isTargetMonth` が `at` で選ぶ）。取り込みすぎても
 * 台帳が重複を弾くだけで害が無く、取りこぼしは取り返しがつかない。
 */
export function parseNetflixNewToWatch(html: string, _ym: string): AnnouncedItem[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) {
    throw new Error(
      'Netflix 新作情報ページに __NEXT_DATA__ が見つかりません。' +
        'ページの作りが変わった可能性があります' +
        '（pipeline/sources/announcement.ts の parseNetflixNewToWatch）',
    )
  }

  let rows: unknown
  try {
    rows = (JSON.parse(m[1]!) as Record<string, any>)?.props?.pageProps?.data?.data
  } catch (e) {
    throw new Error(`Netflix 新作情報ページの __NEXT_DATA__ を読めません: ${String(e)}`)
  }
  if (!Array.isArray(rows)) {
    throw new Error(
      'Netflix 新作情報ページに作品の配列（props.pageProps.data.data）がありません。' +
        'ページの作りが変わった可能性があります',
    )
  }

  const out: AnnouncedItem[] = []
  for (const row of rows as Array<Record<string, unknown>>) {
    const title = String(row.title1 ?? row.title2 ?? '').trim()
    const startTime = Number(row.startTime)
    if (!title || !Number.isFinite(startTime)) continue

    // 配信開始は JST の暦日で見る（表示も 2026/09/01 と JST）
    const jst = new Date(startTime + JST_OFFSET_MS)
    const date = jst.toISOString().slice(0, 10)

    const videoID = row.videoID == null ? undefined : String(row.videoID)
    out.push({
      title,
      raw: title,
      // 告知側は「映画／シリーズ／特別シリーズ」で分けているが、
      // 1件ごとの区分はこのデータに入っていない。**推測しない。**
      category: 'Netflix 新作情報',
      date,
      sourceId: videoID,
      link: videoID ? `https://www.netflix.com/title/${videoID}` : undefined,
      // ★ 種別が分からないので series に寄せる。`showTypeOf` は使わない
      //   （カテゴリに「映画」の字が無いので、どのみち series になる）。
      showType: 'series',
    })
  }
  return out
}

/** JST は UTC+9。Netflix の startTime は epoch ミリ秒で返る */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

const PARSERS: Record<string, (html: string, ym: string) => AnnouncedItem[]> = {
  'about-amazon': parseAboutAmazon,
  'disney-recommend': parseDisneyRecommend,
  'netflix-new-to-watch': parseNetflixNewToWatch,
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
  // ★ 告知元が作品IDを持っているならそれを使う。
  //   題名＋日付のハッシュは「配信日が後から変わると別作品になる」弱さがあり、
  //   同じ告知を2件として取り込んでしまう。IDならその心配が無い。
  if (item.sourceId) return `ann-${service}-${item.sourceId}`
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
      link: item.link,
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
