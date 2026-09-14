/**
 * Hulu の広告を出してはいけないページを見分ける。
 *
 * ■ 何のためにあるか
 * Hulu の掲載ガイドライン（afb・2026-09-14 受領）の１）は、
 * **使えるタイトルを「配信中の作品のみ」に限ったうえで、
 * TBS作品・ディズニー作品・配信終了タイトルの掲載を禁じている。**
 * 「※訴求自体がNG」と明記されていて、違反は**提携解除・成果全却下**。
 *
 * ■ U-NEXT とは禁止の範囲が違う。**流用してはいけない**
 *
 * | 権利元 | U-NEXT | Hulu |
 * |---|---|---|
 * | TBS | ✕ | ✕ |
 * | **日テレ** | **✕** | **○**（Hulu は日本テレビ系。むしろ主力） |
 * | FOD / HBO | ✕ | ○ |
 * | **ディズニー** | ○ | **✕** |
 *
 * `data/unext-ng.json` をそのまま読むと、**日テレ作品のページでも Hulu の広告が
 * 消える。** Hulu にとって最も噛み合うページを自分で潰すことになるので、
 * TBS の一覧だけを借りる（`worksByMenu.tbs`）。
 *
 * ■ 「配信終了タイトル」はここでは判定しない
 * **当サイトは Hulu の配信状況を取得できない**（利用規約が自動アクセスを禁止。
 * docs/SOURCES-UNEXT-HULU.md）。つまり「配信中の作品のみ」を作品単位で
 * 満たす方法が構造的に無い。だから**広告の文言に作品名を入れない**ことで守る
 * （`hulu-ad.ts`）。作品を訴求していなければ、配信中かの判定が要らない。
 *
 * ■ 当て方は `ng-match.ts`（U-NEXT と同じ規則）
 * 規則がずれると「U-NEXTでは止まるのに Hulu では素通りする」が起きる。
 * **正規化・区切りの規則を変えるときは ng-match.ts を直すこと。**
 */
import { readFileSync } from 'node:fs'
import { buildNgIndex, type NgHit, type NgIndex, type NgSource } from './ng-match'
import { findDataFile, unextNgFile } from './unext-ng'

export type { NgHit }

interface HuluNgFile extends NgSource {
  guidelineRevision?: string
}

let file: HuluNgFile | null = null

function load(): HuluNgFile {
  if (file) return file
  const path = findDataFile('data', 'hulu-ng.json')
  if (!path) {
    // 無くてもビルドは通す。**ただし何も止まらない**ので、
    // 広告を出す前に必ずファイルがあることを確かめること（check:ads が見る）。
    file = {}
    return file
  }
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as HuluNgFile
  } catch {
    file = {}
  }
  return file
}

/**
 * TBS作品の一覧。**U-NEXT のために集めたものを借りる。**
 *
 * ★ `worksByMenu.tbs` が無い古いファイルのときは `works` 全体に落ちる。
 *   日テレ・FOD の作品まで止まるので Hulu にとっては止め過ぎだが、
 *   **取りこぼすより安い**ので安全側に倒してある。
 *   `npm run unext:ng` を一度流し直すと TBS だけに絞られる。
 */
export function tbsWorks(): { works: Record<string, string>; narrowed: boolean } {
  const unext = unextNgFile()
  const tbs = unext.worksByMenu?.tbs
  if (tbs && Object.keys(tbs).length > 0) return { works: tbs, narrowed: true }
  return { works: unext.works ?? {}, narrowed: false }
}

let index: NgIndex | null = null

function idx(): NgIndex {
  if (index) return index
  const own = load()
  index = buildNgIndex({
    titles: own.titles,
    rightsHolders: own.rightsHolders,
    // 手書きのディズニー作品 ＋ 借りてきたTBS作品。**どちらも区切り照合**。
    works: { ...(own.works ?? {}), ...tbsWorks().works },
  })
  return index
}

/**
 * その文章に、Hulu の広告と同居させてはいけないものが含まれているか。
 *
 * **1件でも返ってきたら、そのページに Hulu の広告を出さない。**
 *
 * @param text 記事本文（Markdown のままでよい）や作品名を並べた文字列
 */
export function huluNgHitsIn(text: string): NgHit[] {
  return idx().hitsIn(text)
}

/** テスト・再読込用 */
export function resetHuluNg(): void {
  file = null
  index = null
}
