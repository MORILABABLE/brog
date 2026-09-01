/**
 * 収集された変化を運用者に通知する。**サイトには何も出さない。**
 *
 *   npm run notify                 前回の通知以降に収集された変化を送る
 *                                  （変化が無くても、本日から配信が始まる作品があれば送る）
 *   npm run notify -- --dry-run    送らずに本文だけ表示する（状態も進めない）
 *   npm run notify -- --since 2026-08-01T00:00:00Z   起点を手で指定する
 *   npm run notify -- --all        収集済みの全件を対象にする（初回の確認用）
 *   npm run notify -- --channel console
 *
 * ■ APIを消費しない
 * 読むのは `data/events/*.jsonl` だけで、外部APIには一切触らない。
 * だから収集の頻度を上げずに通知だけを足せる。
 * （無料枠500req/月に対し、週2回の収集で約250。頻度を上げる余地は小さい）
 *
 * ■ 収集とは別のコマンドにした理由
 * 収集が成功して通知だけ失敗したときに、収集をやり直さずに通知だけ再送できる。
 * 逆に通知先を差し替えても収集のコードは無傷でいられる。
 */
import { loadTheme } from '../theme.ts'
import { readAllEvents } from '../core/events.ts'
import { buildDigest } from '../core/digest.ts'
import { readUsage } from '../core/api-usage.ts'
import { formatIsoDate } from '../core/datetime.ts'
import { createChannels } from '../notify/index.ts'
import { loadNotifyState, saveNotifyState } from '../notify/state.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かず、環境変数を直接渡す
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

async function main(): Promise<void> {
  const theme = await loadTheme()
  const dryRun = flag('dry-run')
  const all = flag('all')

  const events = await readAllEvents()
  if (events.length === 0) {
    console.log('収集済みのイベントがありません。先に npm run collect を実行してください。')
    return
  }

  const latest = events.map((e) => e.collectedAt).sort().at(-1)!
  const state = await loadNotifyState()
  const since = all ? '' : (arg('since') ?? state.lastCollectedAt)

  // 初回の保護。何も記録が無い状態で走らせると収集済みの全件（1,000件超）が
  // 1通に流れ込む。それは通知ではなく事故なので、起点だけ記録して黙って終わる。
  // 過去ぶんを本当に見たいときは --all を明示する。
  if (!all && !arg('since') && !state.lastCollectedAt) {
    if (!dryRun) await saveNotifyState(latest)
    console.log(
      `通知の起点を ${latest} に設定しました（初回のため送信はしません）。\n` +
        '次回の収集ぶんから通知されます。過去ぶんを見るには --all を付けてください。',
    )
    return
  }

  const fresh = since ? events.filter((e) => e.collectedAt > since) : events
  const today = formatIsoDate(new Date().toISOString(), theme.utc_offset_minutes)

  const digest = buildDigest(fresh, {
    theme,
    collectedAt: fresh.map((e) => e.collectedAt),
    usage: await readUsage(theme.utc_offset_minutes),
    // 「まもなく見放題配信開始」は差分ではなく**在庫**から出す（core/digest.ts の SOON_DAYS）。
    // 告知は月に一度しか出ないので、差分だけでは配信が始まる日に何も届かない。
    stock: events,
  })

  // 収集の差分が無い日でも、その日から配信が始まる作品があれば送る。
  // ただし同じ日に二度は送らない。通知は collect と announce の両方から呼ばれるので、
  // これが無いと**同じ内容の Issue が1日に何本も立つ**。
  if (fresh.length === 0) {
    if (digest.startsToday === 0) {
      console.log(`前回の通知（${since}）以降に新しい収集はありません。送信しません。`)
      return
    }
    if (state.startsTodayDate === today) {
      console.log(`本日（${today}）から始まる作品はすでに知らせています。送信しません。`)
      return
    }
    console.log(`収集の差分はありませんが、本日から配信が始まる作品が ${digest.startsToday}件あります。`)
  }

  const channels = createChannels(dryRun ? 'console' : arg('channel'))
  console.log(`対象 ${fresh.length}件  通知先: ${channels.map((c) => c.name).join(', ')}`)

  for (const channel of channels) {
    await channel.send(digest)
  }

  // 状態を進めるのは全ての通知先に送れたときだけ。
  // 途中で落ちたら進めないので、次回に取りこぼしぶんごと再送される。
  if (dryRun) {
    console.log('\n--dry-run のため、通知の記録は更新していません。')
    return
  }
  // 本日ぶんを知らせたなら日付を記録する（同じ日の二重送信よけ）。
  await saveNotifyState(latest, digest.startsToday ? today : state.startsTodayDate)
  console.log(`通知しました。次回はこれ以降の収集ぶんが対象になります（${latest}）。`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
