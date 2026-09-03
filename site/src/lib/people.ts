/**
 * 人物ページ（`/person/<id>`）のデータ。
 *
 * ■ 何をするファイルか
 * **作品ページを人物で束ね直すだけ。** 新しい取得は1件もしない。
 * 監督・出演は `data/directors.json` / `data/cast.json`（Wikidata・CC0）から
 * すでに `works.ts` が読み込んでいるので、ここはその結果を裏返すだけでよい。
 *
 * ■ なぜ作るのか（docs/GROWTH.md 3-3 ／ docs/STOCK.md S-3）
 * **人物ページは配信状況が変わっても古くならない。**
 * 作品ページは終了日が過ぎれば「終了済み」に倒れていくが、
 * 「誰が撮ったか・誰が出ているか」は変わらない。**劣化しないストック。**
 * 狙う語は「〇〇 配信」「〇〇 Netflix」で、競合は各サービスの俳優ページと
 * Wikipedia くらいしか居ない。
 *
 * ■ 絶対に守ること
 * 作品ページと同じ。**「配信中」と書かない。** 状態の言い回しは works.ts の
 * `WorkState` の表に従い、ここで新しい言い方を作らない。
 *
 * ■ URL に名前を入れていない理由
 * **人物には安定したIDが無い。** 収集しているのは Wikidata の**日本語ラベル**だけで、
 * QID は保存していない（`data/directors.json` は作品ID→名前の配列）。
 * 名前をそのまま URL に入れると
 *   - 日本語のファイル名が `dist/` に並ぶ（Windows と Cloudflare で扱いが揺れる）
 *   - 同姓同名を分けられない
 * ので、**名前から作った短いハッシュ**を使う。作品ページが邦題ではなく
 * 作品IDを使っているのと同じ考え方（docs/GROWTH.md 3-1 の★）。
 *
 * ★ QID を収集できるようになったら、そちらへ移すこと。そのときは
 *   `personId()` だけを差し替えれば済む（URLは変わるので301が要る）。
 */
import { createHash } from 'node:crypto'
import { STATE_ORDER_KEYS, publishableWorkPages } from './works'
import type { WorkPage, WorkState } from './works'

/**
 * ページを作る下限。**この人数だけページが増える。**
 *
 * ■ なぜ3作品なのか（2026-08-30 の実測で決めた）
 *
 * | 下限 | 人数 |
 * |---|---|
 * | 2作品以上 | **467人**（うち321人がちょうど2作品） |
 * | **3作品以上** | **146人** |
 * | 4作品以上 | 69人 |
 *
 * docs/GROWTH.md 3-3 は「2作品以上」と書いていたが、**第1弾は3作品以上にする。**
 * 2作品のページは「名前＋2行」で、作品ページ第1弾で踏んだ
 * 「薄いページをまとめて出すとインデックスに入らない」に当たりやすい
 * （docs/GROWTH.md 3-1 の品質ゲート）。**146枚のインデックス率を見てから広げる。**
 *
 * ★ 広げるときはこの数字を 2 にするだけでよい。他は何も直さなくてよい。
 */
const MIN_WORKS = 3

/**
 * **検索結果に出す**人物ページの最低作品数（2026-09-03 追加）。
 *
 * ■ なぜページを作る条件（MIN_WORKS）と分けるのか
 * この2つは別の問いに答えている。
 *
 *   MIN_WORKS       … ページとして成立するか（内部リンクの受け皿になるか）
 *   INDEX_MIN_WORKS … **検索結果に出して読者の役に立つか**
 *
 * 人物ページは作品ページから辿る受け皿として意味があるので、
 * 3本でもページ自体は作ってよい。だが3本の表と定型文だけのページを
 * 索引に出しても、読者が検索から来て得るものが無い。
 *
 * ■ 実測（2026-09-03・全145枚）
 * 3本=78枚 / 4本=36枚 / 5本=15枚 / 6本=9枚 / 7本以上=7枚。
 * `<main>` の文字数は3本で540〜650字、**2枚を比べると語彙の70%が定型文**。
 * 5本未満（114枚・79%）を索引から外し、31枚を残す。
 *
 * ★ **ページは消さない。** 作品ページからのリンク先として残り、
 *   `noindex,follow` なのでクロールも内部リンクの評価も通る。
 *   作品が増えれば自動的に索引対象へ戻る（service-pages.ts と同じ考え方）。
 *
 * ★ 索引から外したページは**XMLサイトマップからも外すこと。**
 *   載せたままだと Search Console に「noindex のURLを送信しました」が
 *   114件出続ける。除外は astro.config.mjs の sitemap filter
 *   （`noindexPersonPaths()` を読んでいる）。**片方だけ直さないこと。**
 */
const INDEX_MIN_WORKS = 5

/** 1ページに並べる作品の上限。多作の人でもページがリンクの塊にならないように。 */
const WORKS_LIMIT = 60

export interface PersonWork {
  work: WorkPage
  /** その作品での関わり方。両方のことがある */
  roles: ('director' | 'cast')[]
}

export interface Person {
  /** 名前から作った短いID。URL に使う */
  id: string
  name: string
  /** 行動が要る順（終了予定 → 経過 → 終了済み → 配信開始）、同じ状態なら日付順 */
  works: PersonWork[]
  directedCount: number
  castCount: number
  /** 見放題の終了予定を持つ作品の数 */
  leavingCount: number
  /** 最も近い終了予定。無ければ undefined */
  nextLeaving?: { at: Date; serviceLabel: string; title: string }
}

/**
 * 名前 → URL に使うID。
 *
 * 10桁の16進（sha1 の頭）。146人で衝突する確率は事実上ゼロだが、
 * **衝突したらビルドを落とす**（下の build() で見ている）。
 * 静かに1人ぶんのページが消えるほうが困る。
 */
export function personId(name: string): string {
  return createHash('sha1').update(name).digest('hex').slice(0, 10)
}

const STATE_RANK = new Map<WorkState, number>(STATE_ORDER_KEYS.map((s, i) => [s, i]))

function byAction(a: PersonWork, b: PersonWork): number {
  const ra = STATE_RANK.get(a.work.state) ?? 9
  const rb = STATE_RANK.get(b.work.state) ?? 9
  if (ra !== rb) return ra - rb
  // 同じ状態なら日付順。終了予定は近い順、それ以外は新しい順
  const at = (w: WorkPage) => w.services[0]!.at.getTime()
  return a.work.state === 'leaving' ? at(a.work) - at(b.work) : at(b.work) - at(a.work)
}

let people: Map<string, Person> | null = null

function build(): Map<string, Person> {
  if (people) return people

  /** 名前 → その人の作品 */
  const byName = new Map<string, PersonWork[]>()

  const add = (name: string, work: WorkPage, role: 'director' | 'cast') => {
    const list = byName.get(name) ?? []
    // 監督と出演を兼ねる作品は1行にまとめる（同じ作品を2回並べない）
    const hit = list.find((x) => x.work.id === work.id)
    if (hit) {
      if (!hit.roles.includes(role)) hit.roles.push(role)
      return
    }
    list.push({ work, roles: [role] })
    byName.set(name, list)
  }

  for (const w of publishableWorkPages()) {
    for (const n of w.directors) add(n, w, 'director')
    for (const n of w.cast) add(n, w, 'cast')
  }

  const out = new Map<string, Person>()
  for (const [name, list] of byName) {
    if (list.length < MIN_WORKS) continue

    const works = list.sort(byAction).slice(0, WORKS_LIMIT)
    const leaving = works
      .map((x) => ({ work: x.work, s: x.work.services.find((y) => y.state === 'leaving') }))
      .filter((x): x is { work: WorkPage; s: NonNullable<typeof x.s> } => x.s !== undefined)
      .sort((a, b) => a.s.at.getTime() - b.s.at.getTime())

    const id = personId(name)
    const clash = out.get(id)
    // ★ 静かに1人ぶん消えるのを防ぐ。**握りつぶさない。**
    if (clash) throw new Error(`人物IDが衝突しました: ${clash.name} と ${name}（${id}）`)

    out.set(id, {
      id,
      name,
      works,
      directedCount: works.filter((x) => x.roles.includes('director')).length,
      castCount: works.filter((x) => x.roles.includes('cast')).length,
      leavingCount: leaving.length,
      nextLeaving: leaving[0]
        ? {
            at: leaving[0].s.at,
            serviceLabel: leaving[0].s.label,
            title: leaving[0].work.title,
          }
        : undefined,
    })
  }

  people = out
  return out
}

/**
 * ページを作る人物を、**作品の多い順**に返す。
 * 同数のときは名前順。**最後に必ず決まった順にする**（ビルドのたびに順が変わらないように）。
 */
export function publishablePeople(): Person[] {
  return [...build().values()].sort(
    (a, b) => b.works.length - a.works.length || a.name.localeCompare(b.name, 'ja'),
  )
}

/**
 * その人物ページを検索結果に出すか。**false なら `noindex,follow`。**
 * 判断の理由は上の `INDEX_MIN_WORKS`。
 */
export function personIsIndexable(person: Person): boolean {
  return person.works.length >= INDEX_MIN_WORKS
}

/**
 * 索引から外す人物ページのパス（`/person/<id>`）。
 * **XMLサイトマップの除外に使う**（astro.config.mjs）。
 */
export function noindexPersonPaths(): string[] {
  return publishablePeople()
    .filter((p) => !personIsIndexable(p))
    .map((p) => `/person/${p.id}`)
}

/** IDから引く。ページが無ければ undefined。 */
export function personPage(id: string): Person | undefined {
  return build().get(id)
}

/**
 * その名前の人物ページがあるか。**作品ページから人名をリンクにするときに必ず通す。**
 * 通さずにリンクを組むと 404 になる。
 */
export function hasPersonPage(name: string): boolean {
  return build().has(personId(name))
}

/** 人物ページのURL。ページが無ければ undefined（＝リンクにしない） */
export function personHref(name: string): string | undefined {
  return hasPersonPage(name) ? `/person/${personId(name)}` : undefined
}

/**
 * 左の枠に出す上位。**全ページで同じ並び・同じ顔ぶれにする。**
 * ページごとに入れ替えると、移動のたびに枠の中身が変わって読者が混乱する
 * （components/LeftRail.astro の「並びは全ページで固定」と同じ理由）。
 */
export function topPeople(limit: number): Person[] {
  return publishablePeople().slice(0, limit)
}

/** テスト・再読込用 */
export function resetPeople(): void {
  people = null
}
