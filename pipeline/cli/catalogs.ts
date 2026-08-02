/**
 * 対象国で利用可能な配信サービスの一覧を表示する。
 *
 *   npm run catalogs
 *
 * theme.yaml の catalogs[].id を確定させるために使う。
 * 特に日本ローカルのサービス(U-NEXT / Hulu / DMM TV)のIDは未検証なので、
 * このコマンドの出力を正として theme.yaml を修正すること。
 */
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

interface CountryService {
  id?: string
  name?: string
  streamingOptionTypes?: Record<string, boolean>
}

interface CountryResponse {
  countryCode?: string
  name?: string
  services?: CountryService[] | Record<string, CountryService>
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY ?? '', theme)

  const res = (await source.raw(`/countries/${theme.country}`, {})) as CountryResponse
  const list = Array.isArray(res.services)
    ? res.services
    : Object.values(res.services ?? {})

  console.log(`=== ${res.name ?? theme.country} で利用可能なサービス: ${list.length}件 ===\n`)
  for (const s of list.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))) {
    const types = Object.entries(s.streamingOptionTypes ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ')
    console.log(`  ${(s.id ?? '?').padEnd(24)} ${s.name ?? ''}${types ? `  [${types}]` : ''}`)
  }

  console.log('\n--- theme.yaml の突き合わせ ---')
  const ids = new Set(list.map((s) => s.id))
  for (const c of theme.catalogs) {
    const base = c.id.split('.')[0]!
    console.log(
      ids.has(base)
        ? `  OK   ${c.label.padEnd(20)} id=${c.id}`
        : `  MISS ${c.label.padEnd(20)} id=${c.id} … この国に存在しません。上の一覧から選び直してください`,
    )
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
