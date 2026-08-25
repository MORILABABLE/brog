/**
 * 取得済みの作品ポスターをすべて消す。
 *
 *   cd site && npm run posters:purge
 *
 * ■ 使うとき
 * **配信API(Movie of the Night)の利用をやめたとき。**
 * 規約上、契約終了後は画像を使えない。手元のキャッシュと、
 * 生成済みのセクション画像（ポスターを焼き込んである）の両方を消す。
 *
 * 消したあとに `npm run sections` を実行すれば、
 * ポスターの無い**文字だけのカード**が作り直される（記事は崩れない）。
 *
 * ※ 取得した画像は git に入れていないので、ここで消せば履歴にも残らない。
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { purge } from './posters.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repo = join(root, '..')

const cache = purge(repo)
const sections = join(root, 'public', 'sections')
rmSync(sections, { recursive: true, force: true })

console.log(`削除しました:\n  ${cache}\n  ${sections}`)
console.log('`npm run sections` で文字だけのカードを作り直せます。')
