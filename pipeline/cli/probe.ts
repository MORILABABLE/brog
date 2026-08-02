/**
 * APIの生レスポンスをそのまま表示する。
 *
 *   npm run probe -- /changes country=jp change_type=expiring item_type=show catalogs=netflix
 *   npm run probe -- /shows/search/filters country=jp catalogs=netflix show_type=movie
 *
 * アダプタ側の型定義は実レスポンスでの検証がまだ済んでいない。
 * フィールド名がドキュメントと違っていた場合、これで確認して
 * pipeline/sources/streaming-availability.ts を直す。
 *
 * 注意: 実行するたびに無料枠(500req/月)を1消費する。
 */
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

async function main(): Promise<void> {
  const [path, ...rest] = process.argv.slice(2)
  if (!path?.startsWith('/')) {
    throw new Error(
      '使い方: npm run probe -- /changes country=jp change_type=new item_type=show catalogs=netflix',
    )
  }

  const params: Record<string, string> = {}
  for (const kv of rest) {
    const idx = kv.indexOf('=')
    if (idx > 0) params[kv.slice(0, idx)] = kv.slice(idx + 1)
  }

  const theme = await loadTheme()
  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY ?? '', theme)

  const res = await source.raw(path, params)
  console.log(JSON.stringify(res, null, 2))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
