/**
 * 収集された変化を運用者に通知する。**サイトには何も出さない。**
 *
 *   npm run notify                 前回の通知以降に収集された変化を送る
 *                                  （変化が無くても、本日から配信が始まる作品があれば送る）
 *                                  （同じく、**書き直しどきの記事**があれば送る）
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
import { loadArticleTypes, loadTheme } from '../theme.ts'
import { loadLedger, readAllEvents } from '../core/events.ts'
import { buildDigest } from '../core/digest.ts'
import { readUsage } from '../core/api-usage.ts'
import { formatIsoDate } from '../core/datetime.ts'
import { POSTS_DIR, readPublishedPosts } from '../core/coverage.ts'
import { liveElsewhereRows, staleArticles } from '../core/stale.ts'
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
  const now = new Date()
  const today = formatIsoDate(now.toISOString(), theme.utc_offset_minutes)

  /*
   * ★ **書き直しどきの記事**（`core/stale.ts`）。収集の差分とは無関係に毎回数える。
   *   終了日が過ぎるのは収集の差分に出てこない出来事なので、
   *   差分を待っていると「終了予定の記事が終了済みになった」瞬間は永久に届かない。
   *   読むのは記事ファイルと控えだけで、APIは呼ばない。
   */
  const types = await loadArticleTypes(theme)
  const ledger = await loadLedger()
  const posts = await readPublishedPosts(POSTS_DIR)
  const stale = await staleArticles(types, events, ledger, posts, { theme, now })
  /*
   * ★ **「終了しました」と書いた作品が、他社では生きている観測のまま**（同上）。
   *   公開中の記事が誤りになりうる唯一の形なので、書き直しとは別に数える。
   */
  const live = await liveElsewhereRows(types, events, ledger, posts, { theme, now })
  /*
   * 顔ぶれの印。**片づくまで毎日同じものが残る**ので、日付ではなく中身で持つ
   * （`notify/state.ts` の `staleSignature`）。理由まで入れるのは、
   * 同じ記事でも「期日切れが増えた」ときに知らせ直したいため。
   *
   * ★ 要確認（`live`）も同じ印に入れる。**別々に持つ必要が無い**（どちらも
   *   「顔ぶれが変わった日だけ送る」で、歯止めの掛け方が同じ）。
   */
  const staleSignature = [
    ...stale.map(
      (s) => `${s.record.slug}:${s.reasons.join('+')}:${s.passed.length}/${s.missing.length}`,
    ),
    ...live.map((r) => `live:${r.slug}:${r.title}:${r.liveLabel}:${r.kind}`),
  ]
    .sort()
    .join(',')

  const digest = buildDigest(fresh, {
    theme,
    collectedAt: fresh.map((e) => e.collectedAt),
    usage: await readUsage(theme.utc_offset_minutes),
    // 「まもなく見放題配信開始」は差分ではなく**在庫**から出す（core/digest.ts の SOON_DAYS）。
    // 告知は月に一度しか出ないので、差分だけでは配信が始まる日に何も届かない。
    stock: events,
    stale,
    live,
    now,
  })

  // 収集の差分が無い日でも、その日から配信が始まる作品があれば送る。
  // ただし同じ日に二度は送らない。通知は collect と announce の両方から呼ばれるので、
  // これが無いと**同じ内容の Issue が1日に何本も立つ**。
  if (fresh.length === 0) {
    /*
     * 収集の差分が無い日でも送る理由は2つ。**歯止めの持ち方が違う。**
     *   本日から配信開始 … その日だけの知らせ → 同じ日に二度送らない
     *   書き直しどき     … 書き直すまで毎日残る → **顔ぶれが変わった日だけ送る**
     * 後者を日付で持つと、運用者が書き直すまで毎日 Issue が立ち続ける。
     */
    const startsTodayIsNews = digest.startsToday > 0 && state.startsTodayDate !== today
    const staleIsNews =
      digest.staleCount + digest.liveCount > 0 && staleSignature !== state.staleSignature

    if (!startsTodayIsNews && !staleIsNews) {
      if (digest.startsToday === 0 && digest.staleCount + digest.liveCount === 0) {
        console.log(`前回の通知（${since}）以降に新しい収集はありません。送信しません。`)
      } else {
        console.log(`本日（${today}）に知らせるべき変化はすでに知らせています。送信しません。`)
      }
      return
    }
    const why = [
      startsTodayIsNews ? `本日から配信が始まる作品が ${digest.startsToday}件` : '',
      staleIsNews && digest.staleCount ? `書き直しどきの記事が ${digest.staleCount}本` : '',
      staleIsNews && digest.liveCount ? `要確認の作品が ${digest.liveCount}件` : '',
    ].filter(Boolean)
    console.log(`収集の差分はありませんが、${why.join('・')}あります。`)
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
  // 本日ぶんを知らせたなら日付を、書き直しどきを知らせたなら顔ぶれを記録する。
  await saveNotifyState(
    latest,
    digest.startsToday ? today : state.startsTodayDate,
    /*
     * ★ 0本のときも**空文字で上書きする。** 書き直しが済んだあとに
     *   前回の印を残したままにすると、次に同じ顔ぶれが古くなったときに
     *   「知らせ済み」と判定して黙ってしまう。
     */
    staleSignature,
  )
  console.log(`通知しました。次回はこれ以降の収集ぶんが対象になります（${latest}）。`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
