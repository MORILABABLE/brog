/**
 * **候補のうち「サイトに出すぶん」を1ファイルに書き出す。**`data/demand-picks.json`。
 *
 * ■ 何のためにあるか（docs/DEMAND.md 6節の出口A）
 * 需要の突き合わせ（`demand-match.ts`）が出すのは運用者向けの一覧で、
 * **サイトは何も知らない。** ここはその一覧から、ビルド時にサイトが読める形だけを
 * 取り出して置く場所。読む側は `site/src/lib/demand-picks.ts`。
 *
 * ■ 書くのはこのファイルだけ。**記事（.md）には一切触らない**
 * 記事の frontmatter を自動で書き換えると、`data/articles.json`（台帳）・
 * `npm run write -- --refresh`・品質ゲートと二重管理になる。
 * **自動で動いてよいのは「どれを前に出すか」までで、記事の中身は人が決める**
 * （`demand-match.ts` 冒頭「機械にできるのは候補出しまで」と同じ線）。
 *
 * ■ 入れ替えに慣性を持たせる（`KEEP_DAYS`）
 * 需要は日次で動く。そのまま出すと**棚の中身が毎日入れ替わる。**
 *
 *   - 内部リンクが安定しない（クローラが毎回違う先を見る）
 *   - 読者が昨日見たものを today 見つけられない
 *
 * だから**一度載ったものは7日間は残す。** 消えるのは
 * 「7日間まったく需要側に出てこなかった」か「終了日が過ぎた」ときだけ。
 *
 * 🔴 **需要の数字はこのファイルに入れない。** 入れるとサイト側から読めてしまい、
 *   うっかり画面に出る道ができる。当サイトの観測でないものを当サイトの主張として
 *   出さない、という決まり（docs/DEMAND.md 2節の🔴）を**データの形で守る。**
 *   並び順だけが需要を反映し、画面に出る言葉は終了日とサービス名から組む。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AnswerShape, DemandCandidate } from './demand-match.ts'

export const DEMAND_PICKS_PATH = join('data', 'demand-picks.json')

/**
 * 一度載ったものを何日残すか。**棚の中身を安定させるための慣性。**
 * 短くすると毎日入れ替わり、長くすると需要が去ったものが居座る。
 */
const KEEP_DAYS = 7

/**
 * ファイルに持つ上限。サイトが実際に並べる本数はサイト側が決める
 * （`site/src/lib/demand-picks.ts` の `SHELF_MAX`）。
 * ここを絞りすぎると、サイト側で作品ページが作られていないものを飛ばしたときに
 * 棚が空く。**少し多めに持って、絞るのは読む側。**
 */
const MAX_PICKS = 24

export interface DemandPick {
  /** 当たった作品のID。`/works/<id>` になる */
  workIds: string[]
  /** 見出しに使う題名（作品ページ側が持つ題名が正。ここは控え） */
  title: string
  /** 答えられる問い */
  answer: AnswerShape
  /** いちばん近い未来の終了予定（ISO）。`until` のときだけ */
  deadline?: string
  /** いちばん新しい「終わった」観測（ISO）。`ended` のときだけ */
  endedAt?: string
  /** またがっているサービスのキー */
  services: string[]
  /** この作品を載せている公開済み記事の slug。**サイトは自分で引き直す**（控え） */
  covered: string[]
  /** 初めて棚に載った日（YYYY-MM-DD） */
  firstSeen: string
  /** 最後に需要側に出てきた日（YYYY-MM-DD） */
  lastSeen: string
}

export interface DemandPicksFile {
  generatedAt: string
  /** 読む側が「いつのものか」を出せるように、日付だけ別に持つ */
  asOf: string
  note: string
  picks: DemandPick[]
  /**
   * 最後に Issue で知らせた「新規記事の候補」の顔ぶれ。
   *
   * ★ `data/notify-state.json` を使わない。あちらは**収集の差分**を追う台帳で、
   *   `collect` / `announce` の両方が書く。需要の通知は走る周期が違う（毎日）ので、
   *   同じ行を別の周期で書き合うと、どちらの通知が落ちたのか分からなくなる。
   *   顔ぶれで持つ理由は `notify/state.ts` の `staleSignature` と同じ
   *   （書くまで毎日同じものが残るので、日付で持つと鳴りっぱなしになる）。
   */
  notifiedSignature: string
}

const EMPTY: DemandPicksFile = {
  generatedAt: '',
  asOf: '',
  note: '',
  picks: [],
  notifiedSignature: '',
}

const NOTE =
  'npm run demand -- --picks が書く。手で編集しない。' +
  '需要の数字は入れない（並び順だけが需要を反映する）。読む側は site/src/lib/demand-picks.ts。'

export async function readPicks(path = DEMAND_PICKS_PATH): Promise<DemandPicksFile> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<DemandPicksFile>
    return { ...EMPTY, ...raw, picks: raw.picks ?? [] }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY }
    throw err
  }
}

/** 1件ぶんの同一性。**作品IDの集合**で見る（語の表記は揺れる） */
function keyOf(pick: { workIds: string[] }): string {
  return [...pick.workIds].sort().join(',')
}

export interface BuildPicksResult {
  file: DemandPicksFile
  added: number
  kept: number
  dropped: number
  /** 前回と中身が同じなら false。**同じなら書かない**（無意味な再ビルドを起こさない） */
  changed: boolean
}

/**
 * 候補から picks を組む。前回ぶんと突き合わせて、慣性を効かせる。
 *
 * @param candidates `matchDemand()` の結果（並び順のまま渡す）
 * @param previous 前回の `data/demand-picks.json`
 * @param now いまの時刻
 */
export function buildPicks(
  candidates: DemandCandidate[],
  previous: DemandPicksFile,
  now = new Date(),
): BuildPicksResult {
  const today = now.toISOString().slice(0, 10)
  const nowIso = now.toISOString()
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)

  const byKey = new Map<string, DemandPick>()
  for (const p of previous.picks) byKey.set(keyOf(p), p)

  let added = 0
  const fresh: DemandPick[] = []
  for (const c of candidates) {
    const workIds = c.works.map((w) => w.id)
    if (workIds.length === 0) continue
    const key = workIds.slice().sort().join(',')
    const before = byKey.get(key)
    if (!before) added++
    fresh.push({
      workIds,
      title: c.works[0]?.title ?? c.word,
      answer: c.answer,
      deadline: c.deadline,
      endedAt: c.endedAt,
      services: c.services,
      covered: c.covered,
      firstSeen: before?.firstSeen ?? today,
      lastSeen: today,
    })
    byKey.delete(key)
  }

  /*
   * 今回出てこなかったぶん。**すぐには落とさない**（上の■「慣性」）。
   *   - 7日まったく出てこなかった → 落とす
   *   - 終了日が過ぎた            → 落とす（**読者にできることが無くなっている**）
   *
   * ★ 数えているのは**最後に書き込んだ日**からの7日。中身が同じ回はファイルを書かないので
   *   （下の `changed`）、`lastSeen` はそのぶん古いまま残る。**短めに落ちる方向のずれ**で、
   *   実害は「7日の慣性が6日になることがある」だけ。
   *   毎回書いて日付だけ進めると、**中身が同じ日にも再ビルドが走る**ほうの害が大きい。
   */
  let dropped = 0
  const carried: DemandPick[] = []
  for (const p of byKey.values()) {
    if (p.lastSeen < cutoff) {
      dropped++
      continue
    }
    if (p.answer === 'until' && p.deadline && p.deadline <= nowIso) {
      dropped++
      continue
    }
    carried.push(p)
  }

  /*
   * 並び。**需要の順（`candidates` の順）を先に置き、持ち越しを後ろに足す。**
   * 持ち越しどうしは終了日の近い順（他に比べるものが無い）。
   */
  carried.sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'))
  const picks = [...fresh, ...carried].slice(0, MAX_PICKS)

  /*
   * ★ **件数は上限で切ったあとに数える。** 切る前の数を出すと
   *   「新規42件」と言いながらファイルには24件しか無い、という表示になる。
   */
  const before = new Set(previous.picks.map(keyOf))
  added = picks.filter((p) => !before.has(keyOf(p))).length
  const kept = picks.length - added

  const file: DemandPicksFile = {
    generatedAt: nowIso,
    asOf: today,
    note: NOTE,
    picks,
    notifiedSignature: previous.notifiedSignature,
  }

  /*
   * ★ **`generatedAt` を比べない。** 毎回変わるので、それを見ると
   *   中身が同じでも「変わった」になり、**毎回コミット＝毎回再ビルド**になる。
   *   比べるのは並びと中身だけ（`lastSeen` も毎日動くので外す）。
   */
  const shape = (f: DemandPicksFile) =>
    JSON.stringify(
      f.picks.map((p) => [p.workIds, p.answer, p.deadline ?? '', p.endedAt ?? '', p.services, p.covered]),
    )
  const changed = shape(file) !== shape(previous)

  return { file, added, kept, dropped, changed }
}

/** 書き出す。**中身が同じ回は書かない**（呼び出し側が `changed` を見る） */
export async function savePicks(file: DemandPicksFile, path = DEMAND_PICKS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(file, null, 2) + '\n', 'utf8')
}
