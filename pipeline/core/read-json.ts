/**
 * `data/` の JSON を読む。**壊れていたときに、何が壊れたのかを言う。**
 *
 * ■ なぜ要るか（2026-09-15 追加）
 * 素の `JSON.parse` は、ファイル名を知らない。
 *
 *   Expected double-quoted property name in JSON at position 129548 (line 4156 column 1)
 *
 * これが GitHub Actions のログに1行だけ出て、収集が48秒で落ちた
 * （2026-09-14 の collect-unext）。**どのファイルの話なのかが書いていない**ので、
 * 手元で当たりを付けて探すことになった。実際の原因はこれだった。
 *
 *     ],
 *     <<<<<<< HEAD
 *       "updatedAt": "2026-09-14T22:05:37.784Z"
 *     =======
 *       "updatedAt": "2026-09-14T22:27:36.753Z"
 *     >>>>>>> 3d6afac…
 *     }
 *
 * `data/ledger.json` に**コンフリクトの跡がそのままコミットされていた。**
 * 収集は GitHub Actions が `data/` に書き、人も手元で書く。
 * 同じファイルを両側から触るので、この衝突は**これからも起きる**
 * （docs の「/article の前に git pull」も同じ根から出ている）。
 *
 * 起きること自体は止められない。**起きたときに1行で分かるようにする。**
 */

/**
 * git がコンフリクトのときに書き込む印。
 *
 * ★ **行頭のものだけを見る。** 記事の本文やテストデータに
 *   `<<<<<<<` が出てくることはありうるので、行頭7文字＋空白で絞る。
 */
const CONFLICT_MARKERS = [/^<{7} /m, /^={7}$/m, /^>{7} /m]

/** その文字列に、git のコンフリクトの跡が残っているか */
export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_MARKERS.every((re) => re.test(text))
}

/**
 * JSON を読む。壊れていたら、**ファイル名と原因を添えて**投げ直す。
 *
 * @param raw  ファイルの中身
 * @param path 読んだファイル（メッセージに出すためだけ。読みはしない）
 */
export function parseDataJson<T>(raw: string, path: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (hasConflictMarkers(raw)) {
      throw new Error(
        `${path} に git のコンフリクトの跡（<<<<<<< / ======= / >>>>>>>）が残っています。\n` +
          `  そのままコミットされたものが読み込まれています。\n` +
          `  直し方: そのファイルを開いて印の行を消すか、\n` +
          `          git checkout --theirs -- ${path} などで片方を採ってから commit してください。\n` +
          `  元のエラー: ${why}`,
      )
    }
    throw new Error(`${path} が JSON として読めません。\n  ${why}`)
  }
}
