/**
 * ソースを見張って、変わったら `npm run build` を回す（2026-09-14 追加）。
 *
 * ■ 何のためにあるか
 * `npm run dev` は速いが、**本番と同じ出力ではない**。
 * サイトマップの間引き（`prune-sitemap`）・画像の最適化・`prebuild` の
 * カード/セクション/サムネイル生成は**ビルドにしか無い**。
 * 「作品ページの見た目を本番と同じ形で確かめたい」ときに、
 * 毎回 `npm run build` を手で叩かなくて済むようにするのがこれ。
 *
 *     npm run build:watch     ← ここ（保存すると自動でビルド）
 *     npm run preview         ← 別のターミナルで。http://localhost:4321
 *
 * ★ **依存を足していない。** Node 標準の `fs.watch` だけで動く
 *   （`chokidar` などを入れると、本番に要らない依存がサイト側に増える）。
 *
 * ★ **`dev` の代わりではない。** 書きながら直すなら `npm run dev` のほうが速い。
 *   これは「ビルド後の形」を見たいときのもの。
 *
 * ★ ブラウザの自動再読込はしない。`preview` は静的配信なので、
 *   ビルドが終わったら手で再読込する（下の行に出る「ビルド完了」が合図）。
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { join } from 'node:path'

/** 見張る場所。**ここに無いものを直しても走らない。** */
const TARGETS = [
  'src',
  'plugins',
  'public',
  'scripts',
  'astro.config.mjs',
  join('..', 'data'),
  join('..', 'theme-packs'),
]

/**
 * 🔴 **キャッシュを消してからビルドし直す必要がある場所。**
 *
 * Astro は**記事の描画結果（HTML）をキャッシュする**ので、`.md` が変わらない限り
 * 再描画されない。つまり **rehype プラグインを直しても、プラグインが読む
 * `data/` を更新しても、普通の `npm run build` には出てこない**
 * （`scripts/clear-cache.mjs` の冒頭。何度も踏んでいる罠）。
 *
 * 2026-09-14 にこの watch でも踏んだ: `rehype-find-links.ts` を直して保存し、
 * ビルドは成功したのに**古い並びのまま**だった。
 * ここに当たる変更のときだけ `build:fresh`（キャッシュを消してから）に切り替える。
 */
const NEEDS_FRESH = /(^|[\\/])(plugins|data)([\\/]|$)|astro\.config/

/**
 * 無視するもの。**ビルドが書き出す先を見張ると無限に回る。**
 * `dist` と `.astro` は出力、`node_modules` は関係ない。
 *
 * 🔴 **`prebuild` の書き出し先を必ず入れること**（2026-09-14 に実際に踏んだ）。
 *   `make-cards` → `public/cards`、`make-sections` → `public/sections` と
 *   `data/image-manifest.json`、`make-thumbs` → `public/thumbs`。
 *   1つでも漏れると、**ビルドが自分の出力を拾って永久に回り続ける。**
 *   `public/posters` `public/heroes` も画像生成が触る。
 */
const IGNORE =
  /(^|[\\/])(dist|\.astro|node_modules|\.image-cache|\.git|cards|sections|thumbs|posters|heroes|image-manifest\.json)([\\/]|$)/

/** まとめて直したときに何度も走らせないための待ち時間（ms） */
const DEBOUNCE = 400

/**
 * ビルド直後の**落ち着き待ち**（ms）。
 *
 * IGNORE をすり抜けた書き出し（画像の最適化キャッシュなど）が
 * ビルド終了の直後に届くことがある。ここで捨てないと
 * **1回の保存が2回のビルドになる。**
 */
const SETTLE = 2000
let settleUntil = 0
let timer = null
let running = false
let queued = false
/** 次のビルドでキャッシュを消すか（上の NEEDS_FRESH） */
let fresh = false

function build() {
  if (running) {
    queued = true
    return
  }
  running = true
  const useFresh = fresh
  fresh = false
  const started = Date.now()
  console.log(`\n[watch] ビルド開始 ${new Date().toLocaleTimeString('ja-JP')}${useFresh ? '（キャッシュを消してから）' : ''}`)
  const child = spawn('npm', ['run', useFresh ? 'build:fresh' : 'build'], {
    stdio: 'inherit',
    shell: true,
  })
  child.on('exit', (code) => {
    running = false
    const sec = ((Date.now() - started) / 1000).toFixed(1)
    console.log(
      code === 0
        ? `[watch] ビルド完了（${sec}秒）。preview を開いているタブを再読込してください`
        : `[watch] ビルド失敗（終了コード ${code}）。上のエラーを直すと、次の保存でまた走ります`,
    )
    settleUntil = Date.now() + SETTLE
    if (queued) {
      queued = false
      build()
    }
  })
}

function schedule(dir, file) {
  // fs.watch が渡すのは**見張っている場所からの相対パス**なので、足してから判定する
  const rel = file ? join(dir, file) : dir
  if (IGNORE.test(rel)) return
  // ビルドが起こした書き出しを拾わない（上の SETTLE）
  if (Date.now() < settleUntil) return
  if (NEEDS_FRESH.test(rel)) fresh = true
  clearTimeout(timer)
  timer = setTimeout(build, DEBOUNCE)
}

for (const dir of TARGETS) {
  try {
    watch(dir, { recursive: true }, (_event, file) => schedule(dir, file ?? ''))
    console.log(`[watch] 見張り: ${dir}`)
  } catch {
    // 無い場所は黙って飛ばす（theme-packs はテーマによって位置が変わる）
    console.log(`[watch] 見つからないので飛ばす: ${dir}`)
  }
}

console.log('[watch] 保存するとビルドします。Ctrl+C で停止。')
console.log('[watch] 別のターミナルで  npm run preview  を動かしておくと、そのまま見られます。')
build()
