/**
 * **需要（外の話題）と在庫（自前の観測）を突き合わせる。**
 *
 * ■ なぜ要るか
 * 記事の主題はこれまで在庫の側からしか決まっていなかった。
 * 「2社以上で同時に終わる束」（`series-candidates.ts`）は在庫の中の偶然で、
 * **読者がいまその作品を探しているかどうかは一度も見ていない。**
 *
 * 逆に、話題だけを見て主題を決めるのも間違い。当サイトが書けるのは
 * **答えを持っている作品だけ**（docs/STOCK.md 4節「観測データが1行も入らない記事は書かない」）。
 *
 * だから両側から挟む。**話題があり、かつ答えを持っているものだけを候補にする。**
 *
 * ■ 「答え」は2種類しかない
 *
 *   until … 未来の終了予定がある → 「いつまで観られるか」に答えられる
 *   where … 見放題に入った観測がある → 「どこで観られるか」に答えられる
 *
 * `upcoming`（配信予定）は候補にしない。**個別作品の配信開始日は予測しないと決めている**
 * （docs/KEYWORDS.md 4節）。観測として持っていても、記事の答えにはしない。
 *
 * ■ 機械にできるのは候補出しまで
 * `series-candidates.ts` と同じ立場。ここが決めるのは
 * 「話題があり、答えを持っている」ところまでで、
 * **どの記事にするか・主題を何と呼ぶかは人が決める。**
 * スコアを1つの数字に畳まないのはそのため（下の `AFFILIATE_SERVICES` の★）。
 *
 * ■ 誤爆をどう止めているか（**実測で見つかった順**）
 * 2026-09-15 に7日ぶんで試したとき、素の突き合わせは85件返り、
 * そのうち `イルカ` `スイス` `ひまわり` `ジョン・レノン` のような
 * 「作品名と同じ文字列だが、話題は作品ではないもの」が混ざっていた。
 *
 *   1. **観測のある作品だけを在庫とする** … いちばん効いた（85 → 32件）
 *   2. **正規化して4文字未満は捨てる** … `イルカ` `トロイ` の類
 *   3. **人物名を捨てる** … `data/cast.json` `data/directors.json` の日本語表記 10,539件
 *   4. **前方一致は3件以上の束のときだけ** … `Taka` が宝塚の番組4本に当たるのを止める
 *   5. **人が捨てた語**（`data/demand-ng.json`）… 上の4つで落ちないものを手で足す
 *
 * ★ **狭く出す。** 候補を広く出すと、無関係な行を毎回読み飛ばすことになる
 *   （`series-candidates.ts` の同じ★と同じ理由）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeEvent, ChangeKind } from '../sources/types.ts'
import type { DemandSignal } from '../sources/demand/types.ts'
import type { PublishedPost } from './coverage.ts'

/** 人が「これは作品の話題ではない」と判断した語の置き場 */
export const DEMAND_NG_PATH = join('data', 'demand-ng.json')

/**
 * 正規化して何文字未満を捨てるか。
 * ★ 3文字にすると `イルカ` `トロイ` が通る。4文字は実測で決めた下限。
 */
const MIN_WORD_LENGTH = 4

/** 前方一致を「束」と認めるのに要る作品数。`series-candidates.ts` の `MIN_WORKS` と同じ値 */
const MIN_BUNDLE_WORKS = 3

/**
 * 束と認めるのに要るサービス数。**2社以上＝横断**。
 *
 * ■ なぜ束にだけ課すのか（題名が一致した作品には課さない）
 * 理由が2つあり、**どちらも実測から来ている**（2026-09-15）。
 *
 *   1. `series-candidates.ts` の `MIN_SERVICES` と同じ理屈。
 *      1社で閉じた束は、そのサービスの月次記事が扱える。
 *   2. **人物名の束が混ざるのを止められる。** 7日ぶんの実測で、
 *      `GACKT` `Juice=Juice` `モーニング娘。` `FUNKY MONKEY BΛBY'S` `Taka` の5件が、
 *      いずれも**U-NEXT のライブ映像・舞台番組の束**に前方一致していた。
 *      話題の中身は人物・グループであって、その映像作品ではない。
 *
 * ★ **これは近似であって、正しい判定ではない。**
 *   本来は「話題の対象が作品か人物か」を見るべきだが、
 *   `data/cast.json` に載るのは出演者だけで、音楽アーティストは入っていない。
 *   1社で閉じた良い束を落とすことがあるのは承知のうえ。
 *   落ちて困るものが出たら、ここを 1 に戻して `data/demand-ng.json` 側で捌く。
 */
const MIN_BUNDLE_SERVICES = 2

/**
 * 収益導線のあるサービス。**候補の並べ替えには使わない。表示するだけ。**
 *
 * ■ なぜ数式に入れないか
 * 「話題 × 期限 × 導線」を1つのスコアに畳むと、**重みを決めた日の判断が固定される。**
 * U-NEXT の提携状況は動くし（docs/AFFILIATE.md）、Netflix に導線が無いことは
 * 「Netflix の記事を書かない」理由にはならない（流入そのものには意味がある）。
 * **運営者が見て決める材料として出す。**
 *
 * ★ 出どころは docs/AFFILIATE.md。状態（審査中かどうか）はここに書かない。
 *   書くと必ず古くなる。
 */
const AFFILIATE_SERVICES: Record<string, string> = {
  'prime-video': 'Amazon',
  'u-next': 'U-NEXT',
}

/**
 * 突き合わせ用に題名をならす。
 * ★ `pipeline/cli/genres.ts` の `normalize()` と同じ考え方だが、
 *   こちらは**外から来た語**も通すので、全角・大文字も畳む（NFKC + 小文字化）。
 */
export function normalizeTitle(s: string): string {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[・:：\-—–ー~〜!！?？。、,.'’"”「」『』()（）[\]【】#&+/／]/g, '')
}

/** 在庫の1作品 */
export interface InventoryWork {
  id: string
  title: string
  events: ChangeEvent[]
}

export interface Inventory {
  /** 正規化した題名 → その題名を持つ作品 */
  byTitle: Map<string, InventoryWork[]>
  /** 作品数（異なり） */
  size: number
}

/**
 * 観測（`data/events`）から在庫を組む。
 *
 * ★ **観測のある作品だけを在庫とする。** `data/titles.json` や
 *   `data/unext-catalog` にも題名はあるが、そちらは「知っている作品」であって
 *   「答えを持っている作品」ではない。混ぜると、話題に当たっても
 *   記事に書けることが1行も無い候補が並ぶ。
 */
export function buildInventory(events: ChangeEvent[], excludedIds = new Set<string>()): Inventory {
  const works = new Map<string, InventoryWork>()
  for (const e of events) {
    const id = String(e.work.id)
    if (excludedIds.has(id)) continue
    const title = (e.work.localizedTitle ?? e.work.title ?? '').trim()
    if (!title) continue
    const found = works.get(id)
    if (found) found.events.push(e)
    else works.set(id, { id, title, events: [e] })
  }

  const byTitle = new Map<string, InventoryWork[]>()
  for (const w of works.values()) {
    const key = normalizeTitle(w.title)
    if (!key) continue
    const list = byTitle.get(key)
    if (list) list.push(w)
    else byTitle.set(key, [w])
  }
  return { byTitle, size: works.size }
}

/** 記事の答えの型 */
export type AnswerShape = 'until' | 'where'

export interface DemandCandidate {
  /** 需要側の語 */
  word: string
  /** どの取得元で出たか */
  sources: string[]
  /** 1日あたりの最大（Wikipedia の閲覧数／Trends のおおよその検索数） */
  peak: number
  /** 期間中に何日ランクインしたか。**1日だけなら瞬間の話題** */
  days: number
  /** いちばん新しく観測した日 */
  lastDay: string
  /** 直近日の数字 ÷ 期間の最大。1に近いほど「まだ伸びている」 */
  freshness: number
  /** 当たり方。exact は題名が一致、bundle は在庫側の題名がこの語で始まる */
  how: 'exact' | 'bundle'
  /** 当たった作品 */
  works: InventoryWork[]
  /** 答えられる問い */
  answer: AnswerShape
  /** いちばん近い未来の終了予定（ISO）。`until` のときだけ入る */
  deadline?: string
  /** またがっているサービス */
  services: string[]
  /** そのうち収益導線のあるサービスの表示名 */
  affiliates: string[]
  /** 観測の種類 */
  kinds: ChangeKind[]
  /**
   * その作品を既に載せている公開済み記事の slug。
   *
   * ★ **候補から外さない。** 記事があるのに話題が立っているなら、
   *   やることは「書く」ではなく**「書き直す」か「前に出す」**。
   *   外すと、いちばん手の早い一手が一覧から消える。
   */
  covered: string[]
}

export interface MatchOptions {
  /** 人が捨てた語（正規化済み） */
  ngWords?: Set<string>
  /** 人物名（正規化済み） */
  people?: Set<string>
  /** いまの時刻。終了予定が未来かどうかの判定に使う */
  now?: Date
  /**
   * 公開済み記事。渡すと、候補に「もう記事がある」印が付く。
   * 渡さなければ `covered` は常に空。
   */
  posts?: PublishedPost[]
}

export interface MatchReport {
  candidates: DemandCandidate[]
  /** 落とした理由ごとの件数。**候補が少ないときに原因を見るため** */
  dropped: Record<string, number>
  /** 突き合わせた語の異なり数 */
  words: number
}

/**
 * 需要の観測を語ごとに畳んで、在庫と突き合わせる。
 *
 * @param signals 需要の観測（日ごとの行）。同じ語が複数日ぶん入っていてよい
 * @param inventory `buildInventory()` の結果
 */
export function matchDemand(
  signals: DemandSignal[],
  inventory: Inventory,
  options: MatchOptions = {},
): MatchReport {
  const now = (options.now ?? new Date()).toISOString()
  const ngWords = options.ngWords ?? new Set<string>()
  const people = options.people ?? new Set<string>()
  const posts = options.posts ?? []
  const dropped: Record<string, number> = {}
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1
  }

  /** 語ごとに畳んだもの（同じ語が Wikipedia と Trends の両方に出ることがある） */
  interface Folded {
    word: string
    sources: Set<string>
    peak: number
    days: Set<string>
    lastDay: string
    lastCount: number
  }
  const folded = new Map<string, Folded>()
  for (const s of signals) {
    const f = folded.get(s.word)
    if (!f) {
      folded.set(s.word, {
        word: s.word,
        sources: new Set([s.source]),
        peak: s.count,
        days: new Set([s.day]),
        lastDay: s.day,
        lastCount: s.count,
      })
      continue
    }
    f.sources.add(s.source)
    f.peak = Math.max(f.peak, s.count)
    f.days.add(s.day)
    if (s.day >= f.lastDay) {
      f.lastDay = s.day
      f.lastCount = s.count
    }
  }

  const candidates: DemandCandidate[] = []
  for (const f of folded.values()) {
    const key = normalizeTitle(f.word)
    if (key.length < MIN_WORD_LENGTH) {
      drop('短すぎる語')
      continue
    }
    if (ngWords.has(key)) {
      drop('人が捨てた語（demand-ng.json）')
      continue
    }

    const exact = inventory.byTitle.get(key) ?? []
    let works = exact
    let how: DemandCandidate['how'] = 'exact'

    if (works.length === 0) {
      /*
       * 在庫側の題名がこの語で始まるもの＝シリーズの束。
       * ★ **語の側が在庫より短いときだけ**見る（`名探偵コナン` → `名探偵コナン 黒鉄の魚影`）。
       *   逆向き（在庫の題名のほうが短い）を許すと、`ONE PIECE FILM RED` の話題が
       *   `ONE PIECE` の在庫に当たって、別の作品の終了日を答えることになる。
       */
      const bundle: InventoryWork[] = []
      for (const [invKey, list] of inventory.byTitle) {
        if (invKey.startsWith(key) && invKey.length > key.length) bundle.push(...list)
      }
      if (bundle.length < MIN_BUNDLE_WORKS) {
        drop(bundle.length > 0 ? '束が小さい（3作未満）' : '在庫に無い')
        continue
      }
      const bundleServices = new Set(bundle.flatMap((w) => w.events.map((e) => e.service)))
      if (bundleServices.size < MIN_BUNDLE_SERVICES) {
        drop('束が1社に閉じている（人物名の束が混ざるため）')
        continue
      }
      works = bundle
      how = 'bundle'
    }

    /*
     * 人物名は落とす。**題名が人物名そのものの作品も巻き込むが、それでよい**
     * （docs/KEYWORDS.md 4節: 人物軸は記事にしないと決めている）。
     */
    if (people.has(key)) {
      drop('人物名')
      continue
    }

    const events = works.flatMap((w) => w.events)
    const expiring = events
      .filter((e) => e.kind === 'expiring' && e.at && e.at > now)
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))

    let answer: AnswerShape
    if (expiring.length > 0) answer = 'until'
    else if (events.some((e) => e.kind === 'new')) answer = 'where'
    else {
      // 観測はあるが、答えられる問いが無い（upcoming だけ／終了済みだけ）
      drop('答えられる観測が無い')
      continue
    }

    const services = [...new Set(events.map((e) => e.service))]
    candidates.push({
      word: f.word,
      sources: [...f.sources],
      peak: f.peak,
      days: f.days.size,
      lastDay: f.lastDay,
      freshness: f.peak > 0 ? Math.round((f.lastCount / f.peak) * 100) / 100 : 0,
      how,
      works,
      answer,
      deadline: expiring[0]?.at,
      services,
      affiliates: [
        ...new Set(
          services.map((s) => AFFILIATE_SERVICES[s]).filter((v): v is string => Boolean(v)),
        ),
      ],
      kinds: [...new Set(events.map((e) => e.kind))],
      /*
       * ★ 突き合わせは**題名が本文に出ているか**だけ（`mentionsByTitle` と同じ既定）。
       *   表に載っているかまでは見ない。ここで要るのは
       *   「この話題はもう扱ったか」の粗い判定で、厳密さより取りこぼさないことが優先。
       */
      covered: posts
        .filter((p) => !p.draft && works.some((w) => p.body.includes(w.title)))
        .map((p) => p.slug),
    })
  }

  /*
   * 並び順。**スコアを1つに畳まない。**
   *   1. 答えられる問いの強さ（いつまで > どこで）
   *   2. 期限の近さ（`until` のみ）
   *   3. 話題の大きさ
   * 収益導線は並べ替えに使わない（上の AFFILIATE_SERVICES の★）。
   */
  candidates.sort(
    (a, b) =>
      (a.answer === 'until' ? 0 : 1) - (b.answer === 'until' ? 0 : 1) ||
      (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
      b.peak - a.peak,
  )

  return { candidates, dropped, words: folded.size }
}

/** `data/demand-ng.json` を読む。無ければ空 */
export function loadNgWords(path = DEMAND_NG_PATH): Set<string> {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { words?: { word: string }[] }
    return new Set((json.words ?? []).map((w) => normalizeTitle(w.word)))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
}

/**
 * 人物名を集める。`data/cast.json` と `data/directors.json` の**値**（日本語表記）。
 *
 * ★ キーは作品IDで、人物名ではない。値の配列のほうを見ること。
 *   `pipeline/sources/types.ts` が書いているとおり API はローマ字で返すが、
 *   このキャッシュは Wikidata で日本語表記に解決したあとの値が入っている。
 */
export function loadPeople(dir = 'data'): Set<string> {
  const out = new Set<string>()
  for (const file of ['cast.json', 'directors.json']) {
    try {
      const json = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<
        string,
        string[] | null
      >
      for (const names of Object.values(json)) {
        if (!Array.isArray(names)) continue
        for (const n of names) {
          const key = normalizeTitle(n)
          if (key.length >= MIN_WORD_LENGTH) out.add(key)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return out
}

/** `data/excluded-works.json` の作品ID。記事にも常設ページにも出さないもの */
export function loadExcludedIds(path = join('data', 'excluded-works.json')): Set<string> {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { works?: { id: string }[] }
    return new Set((json.works ?? []).map((w) => String(w.id)))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
}
