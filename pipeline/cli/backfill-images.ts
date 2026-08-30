/**
 * 告知から取り込んだ作品に、あとから画像を入れる。
 *
 *   npm run backfill:images              入れられるものを入れる
 *   npm run backfill:images -- --dry-run 何が入るかだけ見る（書き換えない）
 *
 * ■ なぜ要るか
 * 告知（`kind: upcoming`）は**配信が始まる前**の情報なので、その時点では
 * 作品がまだどこにも無い。画像の経路（邦題→Wikidata→配信API）は空振りする。
 * 実測: Netflix の9月ぶん20件は**Wikidataに1件も項目が無く、画像0件**だった。
 *
 * ところが**配信が始まれば配信APIが同じ作品を返す**。そこには画像が付いている。
 * つまり画像は「取れない」のではなく「**まだ取れないだけ**」で、
 * 後から突き合わせれば入る。それをやるのがこのコマンド。
 *
 * ★ **APIを消費しない。** 読むのは `data/events/*.jsonl` だけで、
 *   すでに収集済みのイベントどうしを突き合わせるだけ。
 *   だから毎日の収集のあとに素通しで走らせてよい。
 *
 * ■ 突き合わせのキー（**強いIDだけを使う**）
 *   1. サービス側の作品ID  Netflix の `netflix.com/title/{videoID}`
 *   2. imdbId              Wikidata で解決できた告知（Prime Video 由来に多い）
 *
 * ★ **題名では突き合わせない。** 同名の別作品・シリーズの各シーズンが混ざり、
 *   ポスターが1枚違うだけで記事の信用が落ちる（docs/ANNOUNCEMENTS.md 4節の
 *   「間違えるくらいなら載せない」と同じ判断）。強いIDが無い作品は入らないままでよい。
 *
 * ■ 何を書き換えるか
 * 告知イベントの `work` に **画像と、画像と一緒に取れた事実だけ**を入れる。
 *   posterUrl / backdropUrl / year / rating / genres / directors / cast
 * 題名・日付・`meta` は**触らない**。告知が一次情報である部分を上書きしないため。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeEvent, Work } from '../sources/types.ts'

const EVENT_DIR = join('data', 'events')

const flag = (name: string) => process.argv.includes(`--${name}`)

/** `https://www.netflix.com/title/81262894` → `netflix:81262894` */
function serviceWorkKey(service: string, work: Work): string | undefined {
  const m = /netflix\.com\/title\/(\d+)/.exec(work.link ?? '')
  if (m) return `${service}:nf:${m[1]}`
  return undefined
}

function imdbKey(work: Work): string | undefined {
  const id = work.meta?.imdbId
  return typeof id === 'string' && id ? `imdb:${id}` : undefined
}

/** この作品は画像を配れるか */
function hasImage(work: Work): boolean {
  return Boolean(work.posterUrl)
}

/**
 * 画像と一緒に取れた事実だけを移す。**題名・日付・meta は触らない。**
 * 告知が一次情報である部分（何がいつ始まるか）を、後から来た値で上書きしない。
 */
function merge(target: Work, source: Work): boolean {
  let changed = false
  const copy = <K extends keyof Work>(key: K) => {
    const v = source[key]
    if (v !== undefined && target[key] === undefined) {
      target[key] = v
      changed = true
    }
  }
  copy('posterUrl')
  copy('backdropUrl')
  copy('year')
  copy('rating')
  copy('directors')
  copy('cast')
  if (source.genres?.length && !target.genres?.length) {
    target.genres = source.genres
    changed = true
  }
  return changed
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run')

  let files: string[]
  try {
    files = (await readdir(EVENT_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    console.log('収集済みのイベントがありません。先に npm run collect を実行してください。')
    return
  }

  // ファイルごとに行を保持する（書き戻すため）
  const byFile = new Map<string, ChangeEvent[]>()
  for (const f of files) {
    const raw = await readFile(join(EVENT_DIR, f), 'utf8')
    byFile.set(
      f,
      raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ChangeEvent),
    )
  }
  const all = [...byFile.values()].flat()

  // --- 画像を配れる側の索引 ---
  //
  // 告知（source: 'announcement'）は配る側ではない。配信APIが返したものだけを入れる。
  const donors = new Map<string, Work>()
  for (const e of all) {
    if (e.work.meta?.source === 'announcement') continue
    if (!hasImage(e.work)) continue
    for (const key of [serviceWorkKey(e.service, e.work), imdbKey(e.work)]) {
      if (key && !donors.has(key)) donors.set(key, e.work)
    }
  }

  // --- 画像の無い告知を埋める ---
  const filled: { title: string; service: string; via: string }[] = []
  const dirty = new Set<string>()
  let targets = 0

  for (const [file, events] of byFile) {
    for (const e of events) {
      if (e.kind !== 'upcoming') continue
      if (hasImage(e.work)) continue
      targets++

      const candidates: [string, string | undefined][] = [
        ['作品ID', serviceWorkKey(e.service, e.work)],
        ['imdbId', imdbKey(e.work)],
      ]
      for (const [via, key] of candidates) {
        const donor = key ? donors.get(key) : undefined
        if (!donor) continue
        if (merge(e.work, donor)) {
          filled.push({
            title: e.work.localizedTitle ?? e.work.title,
            service: e.service,
            via,
          })
          dirty.add(file)
        }
        break
      }
    }
  }

  console.log(`画像の無い告知 ${targets}件 / 今回入れられた ${filled.length}件`)
  for (const f of filled) console.log(`  ${f.service}  ${f.title}（${f.via} で一致）`)

  if (filled.length === 0) {
    console.log('入れられるものはありませんでした。配信が始まればAPIが返すので、次回また試します。')
    return
  }
  if (dryRun) {
    console.log('\n--dry-run のため書き換えていません。')
    return
  }

  for (const file of dirty) {
    const events = byFile.get(file)!
    await writeFile(
      join(EVENT_DIR, file),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
  }
  console.log(`\n${dirty.size}ファイルを書き換えました。`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
