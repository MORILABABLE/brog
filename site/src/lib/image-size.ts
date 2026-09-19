/**
 * `public/` に置いた画像の寸法を、**ビルド時にファイルから読む。**
 *
 * ■ 何のためにあるか
 * 広告バナー（`components/AmazonBanner.astro`）は**原稿を差し替えられる**前提で作ってある。
 * 差し替えるたびに `width` / `height` を手で書き直すのでは、
 * **書き忘れた瞬間に画像が伸び縮みする**（属性が無いと、届くまで高さが決まらず画面も跳ねる）。
 * ファイルから読めば、置いた絵の寸法がそのまま属性になる。
 *
 * ■ なぜ Astro の画像機能（`astro:assets`）を使わないか
 * あちらは `src/assets/` の画像を**再エンコードして最適化する。**
 * 広告のクリエイティブは広告主が作ったものなので、**バイト列を変えずにそのまま出す。**
 * だから `public/` に置き、寸法だけをここで読む。
 *
 * ■ 対応している形式
 * JPEG / PNG / GIF / WebP。**ヘッダーだけを見る**ので、何MBの画像でも一瞬で終わる。
 * 読めない形式・壊れたファイルは `null`（呼び出し側が「原稿が無い」ものとして扱う）。
 */
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

export interface ImageSize {
  width: number
  height: number
}

/**
 * `public/` の下のパス（`/ads/foo.jpg`）から実ファイルを探す。
 *
 * ★ ビルドは `site/` で走るが、**念のため直上からも探す**
 *   （lib/works.ts の `findUpPublic`・components/TopCalendar.astro の `largePoster` と同じ事情）。
 */
function resolvePublic(path: string): string | null {
  const rel = path.replace(/^\//, '')
  for (const base of [join(process.cwd(), 'public'), join(process.cwd(), 'site', 'public')]) {
    const full = join(base, rel)
    if (existsSync(full)) return full
  }
  return null
}

/** ファイルの先頭を読む。**ヘッダーだけで足りる**ので 64KB で打ち切る。 */
function head(file: string, bytes = 65536): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** PNG。`IHDR` は必ず先頭にあり、位置が決まっている。 */
function png(b: Buffer): ImageSize | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** GIF。論理画面の幅・高さ（リトルエンディアン）。 */
function gif(b: Buffer): ImageSize | null {
  if (b.length < 10 || b.subarray(0, 3).toString('latin1') !== 'GIF') return null
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
}

/**
 * JPEG。**セグメントを順に飛ばして SOF を探す。**
 * ★ `SOF0`〜`SOF15` のうち `C4`（ハフマン表）`C8`（予約）`CC`（算術符号表）は
 *   フレームヘッダーではないので飛ばすこと。ここを外すと嘘の寸法を返す。
 */
function jpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/** WebP（VP8 / VP8L / VP8X の3種）。 */
function webp(b: Buffer): ImageSize | null {
  if (b.length < 30 || b.subarray(0, 4).toString('latin1') !== 'RIFF') return null
  if (b.subarray(8, 12).toString('latin1') !== 'WEBP') return null
  const kind = b.subarray(12, 16).toString('latin1')
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  if (kind === 'VP8L') {
    const n = b.readUInt32LE(21)
    return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8X') {
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16)
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16)
    return { width: w + 1, height: h + 1 }
  }
  return null
}

/** 読めた寸法をファイルごとに覚える。**同じ絵を何百ページでも1回しか読まない。** */
const cache = new Map<string, ImageSize | null>()

/**
 * `public/` の画像の寸法。**無いファイル・読めない形式は `null`。**
 *
 * @param path `/ads/foo.jpg` のような、公開時のパス
 */
export function publicImageSize(path: string): ImageSize | null {
  const hit = cache.get(path)
  if (hit !== undefined) return hit
  const file = resolvePublic(path)
  const b = file ? head(file) : null
  const size = b ? (png(b) ?? jpeg(b) ?? gif(b) ?? webp(b)) : null
  cache.set(path, size)
  return size
}
