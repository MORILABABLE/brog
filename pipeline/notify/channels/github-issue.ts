/**
 * GitHub の Issue を立てて知らせる。
 *
 * ■ なぜこれを既定にしたか
 * - **追加の秘密情報が要らない。** Actions が自動で渡す `GITHUB_TOKEN` だけで動く。
 *   SMTP のパスワードや Webhook URL のように、失効して静かに止まるものが無い。
 * - GitHub が購読者にメールを送るので、結果として**メールで受け取れる**。
 *   スマホの GitHub アプリにも同じ通知が出る。
 * - Issue が残るので、あとから遡れて、対応したら閉じられる。流れて消えない。
 * - private リポジトリの中で完結する。収集データが第三者の手に渡らないので、
 *   API利用規約の再配布禁止（DESIGN.md 8章）に触れない。
 *
 * ■ 通知が届かないときに見るところ
 * リポジトリの Watch 設定。自分のリポジトリは既定で購読状態だが、
 * 過去に外していると Issue が立っても静かになる。`NOTIFY_MENTION` を
 * 設定しておくと本文で @メンションするので、購読状態に関わらず届く。
 */
import type { Channel, Notification } from '../types.ts'

const DEFAULT_API = 'https://api.github.com'

export class GitHubIssueChannel implements Channel {
  readonly name = 'github-issue'

  async send(n: Notification): Promise<void> {
    // Actions が自動で入れる環境変数。手元から試すときだけ自分で渡す。
    const repo = process.env.GITHUB_REPOSITORY
    const token = process.env.GITHUB_TOKEN
    const api = process.env.GITHUB_API_URL ?? DEFAULT_API

    if (!repo) {
      throw new Error(
        'GITHUB_REPOSITORY が未設定です（例: owner/repo）。\n' +
          '  GitHub Actions では自動で入ります。手元から試す場合は環境変数で渡してください。',
      )
    }
    if (!token) {
      throw new Error(
        'GITHUB_TOKEN が未設定です。\n' +
          '  ワークフローに permissions: issues: write を書き、\n' +
          '  env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} を渡してください。',
      )
    }

    const mention = process.env.NOTIFY_MENTION?.replace(/^@/, '').trim()
    const body = mention ? `${n.body}\n\ncc @${mention}` : n.body

    const res = await fetch(`${api}/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        // GitHub API は User-Agent が無いと 403 を返す
        'user-agent': 'brog-notify',
      },
      body: JSON.stringify({ title: n.subject, body }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const hint =
        res.status === 403 || res.status === 404
          ? '\n  権限不足の可能性があります。ワークフローの permissions に issues: write がありますか？'
          : ''
      throw new Error(`Issue の作成に失敗しました (${res.status}): ${detail.slice(0, 300)}${hint}`)
    }

    const created = (await res.json()) as { html_url?: string }
    console.log(`Issue を作成しました: ${created.html_url ?? '(URL不明)'}`)
  }
}
