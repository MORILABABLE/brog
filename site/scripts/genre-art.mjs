/**
 * 作品画像が無いときに使う、ジャンル別の汎用画像の定義。
 *
 * ■ なぜ「カテゴリ色のタイル」ではないのか
 * ポスターを取れない作品は少なくない。**U-NEXT 由来の作品は718件すべてに
 * 画像が無い**（収集がメニュー経由で、APIのように画像URLが付いてこない）。
 * その全部を同じ色のタイルで埋めると表が一色に潰れ、
 * 「なんとなく気になった作品をクリックする」導線として機能しない。
 * ジャンルごとに絵柄と色を変えれば、画像が無くても行ごとの手掛かりが残る。
 *
 * ■ 第三者の権利が一切絡まない
 * 作中の画像もポスターも使わない。**その場で描く幾何学図形だけ**なので、
 * 許諾も出典表記も要らず、URLの失効も無い。
 * （作品ポスターそのものの扱いは posters.mjs の冒頭を参照）
 *
 * ■ 文字を入れない理由
 * 表示は48×72で、ジャンル名を焼き込んでも読めない。
 * 代わりに絵柄と色で区別し、**作品名は必ず絵の隣に文字で出す**。
 * 画像は装飾（alt=""）で、意味は文字側が持つ。
 *
 * ★ このファイルは2か所から読まれる。**片方だけ直さないこと。**
 *     scripts/make-thumbs.mjs … 画像を生成する（key ごとに1枚）
 *     src/lib/work-links.ts   … 作品からどの画像を使うかを引く
 */

/**
 * ジャンルの定義。
 *
 * `aliases` は収集データの `work.genres` に実際に入る文字列。
 * 英語は Streaming Availability API、日本語は U-NEXT のカテゴリ名で、
 * **出どころが違うので両方を並べてある**（`npm run thumbs -- --audit` で照合できる）。
 *
 * `rank` は1作品に複数ジャンルが付いたときの優先順位。**小さいほうが勝つ。**
 * 「Drama / Science Fiction」なら SF を採る。Drama や Comedy はほぼ全作品に
 * 付いてくるので、素直に先頭を採ると表がドラマ一色になる。
 *
 * `hue` は HSL の色相。彩度と明度は下の genreSvg() で共通なので、
 * **ここを変えるだけで色が変わる**。近い番号どうしを隣に並べないこと。
 */
export const GENRE_ART = [
  // --- 絵柄がはっきり決まるもの（rank 10番台） ---
  { key: 'scifi', label: 'SF', rank: 10, hue: 205, aliases: ['Science Fiction'] },
  { key: 'horror', label: 'ホラー', rank: 10, hue: 352, aliases: ['Horror'] },
  { key: 'fantasy', label: 'ファンタジー', rank: 11, hue: 278, aliases: ['Fantasy'] },
  { key: 'war', label: '戦争', rank: 11, hue: 30, aliases: ['War'] },
  { key: 'frontier', label: '西部劇', rank: 12, hue: 42, aliases: ['Western'] },
  { key: 'music', label: '音楽', rank: 12, hue: 312, aliases: ['Music', '音楽・ライブ'] },
  { key: 'stage', label: '舞台', rank: 12, hue: 338, aliases: ['舞台・演劇'] },
  {
    key: 'documentary',
    label: 'ドキュメンタリー',
    rank: 13,
    hue: 186,
    aliases: ['Documentary', '報道・スペシャル'],
  },
  { key: 'animation', label: 'アニメ', rank: 13, hue: 228, aliases: ['Animation', 'アニメ'] },
  { key: 'asia', label: '韓流・アジア', rank: 13, hue: 8, aliases: ['韓流・アジア'] },
  { key: 'family', label: 'ファミリー', rank: 14, hue: 98, aliases: ['Family', 'キッズ'] },
  { key: 'history', label: '歴史', rank: 14, hue: 48, aliases: ['History'] },
  { key: 'crime', label: 'クライム', rank: 15, hue: 246, aliases: ['Crime'] },
  { key: 'mystery', label: 'ミステリー', rank: 15, hue: 265, aliases: ['Mystery'] },
  { key: 'romance', label: 'ロマンス', rank: 16, hue: 328, aliases: ['Romance'] },
  {
    key: 'variety',
    label: 'バラエティ',
    rank: 16,
    hue: 160,
    aliases: ['Reality', 'Talk Show', 'News', 'TV番組・エンタメ'],
  },

  // --- 多くの作品に重ねて付くもの（rank 20番台） ---
  { key: 'thriller', label: 'スリラー', rank: 20, hue: 258, aliases: ['Thriller'] },
  { key: 'action', label: 'アクション', rank: 21, hue: 14, aliases: ['Action'] },
  { key: 'adventure', label: 'アドベンチャー', rank: 22, hue: 132, aliases: ['Adventure'] },

  // --- ほぼ全作品に付く／区分でしかないもの（rank 30番台） ---
  { key: 'comedy', label: 'コメディ', rank: 30, hue: 58, aliases: ['Comedy'] },
  { key: 'jp-drama', label: '国内ドラマ', rank: 31, hue: 172, aliases: ['国内ドラマ'] },
  { key: 'overseas-drama', label: '海外ドラマ', rank: 31, hue: 218, aliases: ['海外ドラマ'] },
  { key: 'drama', label: 'ドラマ', rank: 32, hue: 198, aliases: ['Drama'] },
  { key: 'foreign', label: '洋画', rank: 33, hue: 212, aliases: ['洋画'] },
  { key: 'japanese', label: '邦画', rank: 33, hue: 20, aliases: ['邦画'] },

  // --- どれにも当たらなかったとき ---
  { key: 'other', label: '作品', rank: 99, hue: 215, aliases: [] },
]

/** 既定のジャンル。`work.genres` が空でも必ず1枚に決まる。 */
export const FALLBACK_GENRE = 'other'

/** key → 定義 */
export const GENRE_BY_KEY = new Map(GENRE_ART.map((g) => [g.key, g]))

/** ジャンル名 → 定義。1度だけ組む。 */
const byAlias = new Map()
for (const g of GENRE_ART) {
  for (const a of g.aliases) byAlias.set(a, g)
}

/**
 * 作品のジャンル配列から、使う汎用画像の key を決める。
 *
 * 当たらないジャンル名は**黙って無視する**。APIが新しいジャンルを返し始めても
 * ビルドは落ちず、その作品が 'other' に落ちるだけで済む。
 * 取りこぼしを一覧したいときは `npm run thumbs -- --audit`。
 *
 * @param {readonly string[] | undefined} genres
 * @returns {string}
 */
export function genreKeyOf(genres) {
  let best
  for (const name of genres ?? []) {
    const hit = byAlias.get(name)
    if (hit && (!best || hit.rank < best.rank)) best = hit
  }
  return best?.key ?? FALLBACK_GENRE
}

/** 汎用画像のファイル名。`/thumbs/` からの相対。 */
export function genreThumbName(key) {
  return `genre-${GENRE_BY_KEY.has(key) ? key : FALLBACK_GENRE}.webp`
}

// --- 絵柄 -------------------------------------------------------------------

/**
 * 絵柄。100×150 の座標系で描く。線の太さと色は genreSvg() が一括で指定するので、
 * ここでは形だけを書く（塗りたい図形にだけ `fill="CURRENT"` を足す）。
 *
 * ★ 48×72 で表示される。**細い線と小さい要素は潰れる。**
 *   要素は3つまで、線幅は 7 を基準に、と考えて足すこと。
 */
const MOTIF = {
  // 惑星と環
  scifi:
    '<circle cx="50" cy="73" r="17"/><ellipse cx="50" cy="73" rx="31" ry="11" transform="rotate(-22 50 73)"/>',
  // 三日月
  horror: '<path d="M63 51a23 23 0 1 0 0 44 27 27 0 0 1 0-44Z" fill="CURRENT" stroke="none"/>',
  // 城の狭間
  fantasy: '<path d="M27 96V60l9 9 14-17 14 17 9-9v36Z"/>',
  // 盾
  war: '<path d="M50 49l24 8v19c0 14-11 22-24 26-13-4-24-12-24-26V57Z"/>',
  // サボテン（★ 星は animation で使っているので、バッジにしないこと）
  frontier: '<path d="M50 98V50"/><path d="M50 78H35V62"/><path d="M50 86h15V66"/>',
  // 音符
  music:
    '<path d="M42 93V56l28-7v37"/><circle cx="35" cy="94" r="8" fill="CURRENT"/><circle cx="63" cy="87" r="8" fill="CURRENT"/>',
  // 舞台のアーチ（プロセニアム）
  stage: '<path d="M27 96V71a23 23 0 0 1 46 0v25"/><path d="M20 96h60"/>',
  // カメラ
  documentary:
    '<rect x="24" y="62" width="52" height="34" rx="5"/><circle cx="50" cy="79" r="11"/><path d="M39 62l5-9h12l5 9"/>',
  // 星
  animation: '<path d="M50 47l8 20 22 2-17 15 5 21-18-11-18 11 5-21-17-15 22-2Z"/>',
  // 提灯（★ 扇は 48×72 では菱形にしか見えない。実測で差し替えた）
  asia: '<ellipse cx="50" cy="74" rx="20" ry="24"/><path d="M37 57h26M37 91h26M50 47v10M50 91v8"/>',
  // 家
  family: '<path d="M26 75 50 53l24 22"/><path d="M33 72v25h34V72"/>',
  // 神殿の柱
  history: '<path d="M27 58h46M31 92h38M34 58v34M50 58v34M66 58v34"/>',
  // 手錠（★ 輪を離して鎖を挟む。詰めると眼鏡に見える）
  crime:
    '<circle cx="31" cy="82" r="11"/><circle cx="69" cy="82" r="11"/><rect x="44" y="77" width="12" height="10" rx="3"/><path d="M31 71V59M69 71V59"/>',
  // 虫めがね
  mystery: '<circle cx="45" cy="68" r="18"/><path d="M58 81 74 97"/>',
  // ハート
  romance: '<path d="M50 96C30 82 26 71 26 64a13 13 0 0 1 24-7 13 13 0 0 1 24 7c0 7-4 18-24 32Z"/>',
  // テレビ
  variety: '<rect x="26" y="63" width="48" height="34" rx="5"/><path d="M38 51l10 12M62 51 52 63"/>',
  // 心電図（★ 渦にすると horror の三日月と紛れる）
  thriller: '<path d="M23 76h13l8-19 9 38 8-26 6 7h10"/>',
  // 稲妻
  action: '<path d="M57 46 34 82h13l-5 24 24-38H53Z"/>',
  // 方位磁針
  adventure: '<circle cx="50" cy="73" r="23"/><path d="M50 54v38M50 54l8 13M50 54l-8 13"/>',
  // 吹き出し（★ 笑顔にすると drama の仮面と紛れる）
  comedy: '<path d="M24 57h52v30H55L41 99V87H24Z"/>',
  // 鳥居
  'jp-drama': '<path d="M24 55h52M29 66h42M38 66v32M62 66v32M38 78h24"/>',
  // 摩天楼
  'overseas-drama': '<path d="M24 98V70h13v28M43 98V52h14v46M63 98V64h13v34"/>',
  // 仮面
  drama:
    '<path d="M31 55h38v22c0 13-8 21-19 21s-19-8-19-21Z"/><path d="M41 68h.1M59 68h.1M43 82a9 9 0 0 0 14 0"/>',
  // カチンコ
  foreign:
    '<rect x="25" y="68" width="50" height="28" rx="4"/><path d="M25 68 28 54l48 7-2 7"/><path d="M42 57l-3 12M58 59l-3 11"/>',
  // 富士山
  japanese: '<path d="M22 95 44 55l11 17 6-9 19 32Z"/><path d="M35 74h19"/>',
  // 再生ボタン
  other: '<circle cx="50" cy="73" r="23"/><path d="M44 62l18 11-18 11Z"/>',
}

/**
 * ジャンル1つぶんの「絵柄と色」を取り出す。
 *
 * genreSvg() は 48×72 のサムネ用に組み上がった1枚を返すが、
 * make-sections.mjs は**同じ絵柄をポスター大（480×720）で組み直す**ので、
 * 出来上がりではなく部品が要る。ここはその窓口。
 *
 * `path` の中の `CURRENT` は塗り色のプレースホルダなので、
 * **呼び出し側が必ず置換すること**（genreSvg() と同じ約束）。
 *
 * @param {string} key
 * @returns {{ path: string, hue: number, label: string }}
 */
export function genreMotif(key) {
  const g = GENRE_BY_KEY.get(key) ?? GENRE_BY_KEY.get(FALLBACK_GENRE)
  return { path: MOTIF[g.key] ?? MOTIF.other, hue: g.hue, label: g.label }
}

/**
 * ジャンル1枚ぶんの SVG。
 *
 * ★ `<text>` を使わないこと。SVG のテキストは描画するマシンのフォントで出るため、
 *   Cloudflare（Linux・日本語フォント無し）では豆腐になる。
 *   文字を入れたくなったら make-cards.mjs と同じくパスへ変換すること。
 *
 * @param {string} key
 * @param {number} w 出力幅
 * @param {number} h 出力高さ
 */
export function genreSvg(key, w, h) {
  const g = GENRE_BY_KEY.get(key) ?? GENRE_BY_KEY.get(FALLBACK_GENRE)
  const hue = g.hue
  // 彩度と明度は全ジャンル共通。**色相だけを変える**ので、
  // 何枚並べても1組のデザインに見える。
  const top = `hsl(${hue} 34% 30%)`
  const bottom = `hsl(${hue} 40% 19%)`
  const fg = `hsl(${hue} 52% 74%)`
  const motif = (MOTIF[g.key] ?? MOTIF.other).replaceAll('CURRENT', fg)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 100 150">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
  </linearGradient></defs>
  <rect width="100" height="150" fill="url(#g)"/>
  <g fill="none" stroke="${fg}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.92">${motif}</g>
</svg>`
}
