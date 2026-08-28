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
 * 消したあとに `npm run sections -- --write` と `npm run thumbs -- --no-posters` を
 * 実行すれば、**生成ポスター**（ジャンルの色と絵柄に作品名を組んだ自前の絵）と
 * **ジャンル汎用画像だけの表**が作り直される（記事も常設ページも崩れない）。
 *
 * ★ **`--write` を忘れないこと。** 記事に残っている `/sections/posters/…` の参照は
 *   ここで消したファイルを指しており、書き換えないと画像が壊れたままになる。
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
/*
 * ★ public/thumbs も消す。ポスターを縮めた画像が入っている。
 *   ジャンル汎用画像（genre-*.webp）も一緒に消えるが、あれは自前の生成物なので
 *   `npm run thumbs` を流せばすぐ戻る。**混ざっているぶん、まとめて消すのが安全。**
 */
const generated = [
  join(root, 'public', 'sections'),
  join(root, 'public', 'heroes'),
  join(root, 'public', 'thumbs'),
]
for (const dir of generated) rmSync(dir, { recursive: true, force: true })

console.log(['削除しました:', cache, ...generated].join('\n  '))
console.log('`npm run sections -- --write` で生成ポスターに置き換えられます（--write が要ります）。')
console.log('`npm run thumbs -- --no-posters` でジャンル汎用画像だけの表に戻せます。')
console.log(
  '記事の frontmatter に残った `heroImage: \'/heroes/…\'` も消すこと' +
    '（画像が無いとカードはカテゴリ色のタイルに戻る）。',
)
