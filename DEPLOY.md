# 公開手順（ドメイン取得 → Cloudflare Pages）

サーバー契約は不要。必要なのは**独自ドメインだけ**。

---

## 1. ドメインを取得する

### どこで買うか

| レジストラ | .com の年額 | 特徴 |
|---|---|---|
| **Cloudflare Registrar**（推奨） | **約1,500円** | **原価販売で更新料も上がらない**。Cloudflare Pages と同じ管理画面で完結し、DNS設定が自動。Whois代行が標準で無料 |
| お名前.com | 初年度1円〜／更新 約1,600円 | 初年度が安いが**更新時に高くなる**。メール営業が多い |
| ムームードメイン | 約1,700円 | 管理画面が分かりやすい |

**Cloudflare Registrar を推奨します。** 理由は3つ:

1. **更新料が上がらない** — 原価（レジストリ卸値）で売っているため。他社は初年度を安くして更新で回収する
2. **設定作業がゼロ** — Pages と同じアカウントなので、DNSレコードが自動で設定される。他社だとネームサーバーの変更作業が必要
3. **Whois代行が無料** — 個人情報（氏名・住所・電話）が公開されない。他社では有料の場合がある

> ⚠️ Cloudflare Registrar は**新規登録に対応していない TLD がある**。
> `.com` は問題なく登録できる。`.jp` は非対応なので、`.jp` が欲しい場合はお名前.com等を使う。

### 取得手順（Cloudflare Registrar）

1. https://dash.cloudflare.com/sign-up でアカウント作成（無料）
2. 左メニューの **Domain Registration → Register Domain**
3. `mihoudairader` で検索し、`.com` が空いていることを確認
   （2026-08-23 に Cloudflare Registrar で取得済み。年額 約$10.5）
4. カード情報を入力して購入（**Auto-renew は ON のままにする**。切れるとドメインを失う）
5. 数分で `Websites` 一覧に自分のドメインが表示される

> 取得後、**Whois の連絡先メールに届く確認メールを必ず開いて認証する**こと。
> 15日以内に認証しないとドメインが停止される（ICANN のルール）。

### 取得したら

`site/src/config.ts` の `SITE.url` と `site/public/robots.txt` の Sitemap 行は
**すでに `mihoudairader.com` に設定済み**。別のドメインにした場合のみ書き換える。

> **ドメイン選定の記録（2026-08-01）**
> `nanimiru.com` は2024年12月に第三者が登録済みだったため断念。
> ハイフン版（`nani-miru.com`）は取得可能だったが、ハイフンなしを他者が保有していると
> 口頭で伝えた際のタイプイン流出が起きるため見送った。
> `mitokou.com`（観とこう）はハイフンなしで取得でき、サイトの目的
> 「配信終了前に観ておく」がそのまま名前になる点を評価して採用。
> なお**ハイフンの有無自体は Google のランキング要因ではない**（判断材料は流出リスクと語感）。

> **改名の記録（2026-08-23）— 観とこう → 見放題レーダー**
>
> **なぜ変えたか。** 「観とこう」は読みが確定しない（「観」を「み」と読ませるのは
> 「観る」からの訓読みなので、単独では「かんとこう」と読まれる）。
> ひらがな「みとこう」への統一を検討したが、実測で**ブランド名として使えない**と判明した。
>
> | 検査（2026-08-23 実測） | みとこう | 見放題レーダー |
> |---|---|---|
> | 完全一致の占有者 | 水戸黄門（TBS 43部・1,127回）＋水戸市＋水戸工業高 | **なし（0件）** |
> | Googleサジェスト | 水戸黄門関連で10件埋まる | **空配列** |
> | 自分の名前で1位を取れるか | 事実上不可能 | 公開後ほぼ確実 |
>
> **判断の要点は「ブランドクエリで1位を取れるかは、後から取り返せない唯一の項目」。**
> 記事6本・独自ドメイン未割当・外部言及ゼロの時点なら、改名コストは実質ゼロだった。
> 逆に言えば、**この時期を逃すと同じ作業のコストが跳ね上がる**。
>
> **却下した案と理由**（再提案を防ぐため）
> - `見放題カレンダー` — 競合1位2位（animephilia.net「Netflix 配信終了予定カレンダー」等）の
>   ページタイトルと文字列衝突し、ブランドクエリが競合に吸われる
> - `観れるうちに` — ら抜き言葉のため SERP が国語解説サイトに占領され、表記ゆれが4通り
> - `見逃し〇〇` — TVer の「見逃し配信」と概念衝突
> - `配信〇〇`（単体） — ライブ配信・Vtuber 文脈に汚染される（`配信終了` の複合ならクリーン）
> - `見放題ぜんぶ` — U-NEXT・Hulu・DMM TV は API 非対応（DESIGN.md 参照）なので事実に反する
>
> **運用上の注意（実測に基づく）**
> 1. **「見放題」と略させない。** Googleサジェスト `見放題␣` の10件中7件は
>    音楽フェス「見放題」（mihoudai.jp、大阪/東京/名古屋）。動画配信の意味はサジェストに無い。
>    ロゴ・タイトル・SNSハンドルは常に「見放題レーダー」7文字を1単位で出す。
> 2. **「レーダーサイト」と自称しない。** 航空自衛隊の施設名（サジェスト実測）。
> 3. **綴りは `rader`。** 英語の正しい綴りは `radar`。`mihoudairadar.com` は
>    2026-08-23 時点で未登録なので、タイプイン流出が気になるなら防衛取得してリダイレクトする。
> 4. **商標は確認済み（2026-08-23）。** J-PlatPat で `見放題` を照会し、問題なしと判断した。

---

## 2. GitHub にリポジトリを作る

### GitHub は何のために要るのか

このプロジェクトで GitHub は3つの役割を持つ。

1. **ファイルの保管場所** — 記事やコードの置き場
2. **自動実行の場所** — 配信情報の収集と記事生成を定期実行する（GitHub Actions）
3. **公開のトリガー** — ここに push すると Cloudflare Pages が自動でサイトを更新する

つまり「GitHub に置く＝サイトが動き出す」ので、避けて通れない。以下の手順どおりに進めれば詰まらない。

---

### 手順1: アカウントを作る

https://github.com/signup

メールアドレス・パスワード・**ユーザー名**を決めるだけ。ユーザー名はURLの一部になる
（`github.com/ユーザー名`）ので、多少は考えて決める。後から変更もできる。

---

### 手順2: git に名前とアドレスを登録する（設定済み）

**GitHub は既定で「実メールアドレスを含む push をブロック」する。**
Private リポジトリでも同じく働く（守っているのはリポジトリの中身ではなく
アドレスそのものなので）。実メールのまま push すると、認証を通過した後に
サーバー側で次のように拒否される:

```
remote: error: GH007: Your push would publish a private email address.
```

そのため **noreply アドレス（GitHubが配る身代わりアドレス）を使う。**
新規アカウントでは設定画面にチェックボックスとして現れないことがあるが、
アドレス自体は全アカウントで有効。

#### noreply アドレスの求め方

`<数値ID>+<ユーザー名>@users.noreply.github.com`

数値IDは公開APIで分かる（設定画面を探す必要はない）:

```powershell
(Invoke-RestMethod "https://api.github.com/users/<ユーザー名>" -Headers @{'User-Agent'='setup'}).id
```

#### 設定

```powershell
cd C:\Users\grate\brog
git config user.name  "grate"
git config user.email "152237527+MORILABABLE@users.noreply.github.com"
```

> `--global` を付けていないので、この設定はこのプロジェクトの中だけに効く。
> 他の作業に影響しない。

既にコミットを作った後に気づいた場合は、著者情報を書き換える:

```powershell
git commit --amend --reset-author --no-edit
```

---

### 手順3: 最初のコミットを作る（作成済み）

```powershell
git add -A
git commit -m "初期構築: 収集パイプライン + サイト土台 + 記事生成"
```

「コミット」は**変更内容のスナップショットを1つ記録する**操作。
まだ手元に保存されただけで、GitHub には送られていない。

---

### 手順4: GitHub 上にリポジトリ（置き場）を作る

https://github.com/new を開き、以下のとおり入力する。

| 項目 | 設定 |
|---|---|
| Repository name | `brog`（好きな名前でよい） |
| Public / Private | **Private** を選ぶ |
| Add a README file | **チェックしない** |
| Add .gitignore | **None のまま** |
| Choose a license | **None のまま** |

> **なぜ Private でよいか**: Private の GitHub Actions 無料枠は月2,000分。
> 本プロジェクトの使用量は collect（週2回×約2分）＋ write（週3回×約2分）で
> **月40分程度**なので、無料枠に十分収まる。
> Public にすると Actions は無制限になるが、コミットのメールアドレスが
> 公開されるトレードオフがあり、この使用量では見合わない。

> 下3つにチェックを入れると、GitHub 側にもファイルができてしまい、
> 手元のファイルと衝突して push が失敗する。**必ず空のまま作る。**

**Create repository** を押すと、次の画面にコマンドが表示される。無視してよい（次の手順で使う）。

---

### 手順5: GitHub に送る（push）

```powershell
git remote add origin https://github.com/<ユーザー名>/brog.git
git push -u origin main
```

初回は**ブラウザが自動で開き、GitHub のログイン画面が出る**。
承認すればパスワードやトークンの入力は不要（Git Credential Manager が処理する）。

完了後、`https://github.com/<ユーザー名>/brog` を開いてファイルが並んでいれば成功。

---

### 手順6: APIキーを GitHub に登録する

自動収集と記事生成をGitHub上で走らせるために、APIキーを渡しておく。

1. リポジトリの **Settings** タブ → 左メニュー **Secrets and variables** → **Actions**
2. **New repository secret** を押す
3. 以下の2つを登録する

| Name | Secret |
|---|---|
| `STREAMING_API_KEY` | `.env` に書いた配信情報APIのキー |
| `ANTHROPIC_API_KEY` | Claude のAPIキー（記事生成用・P3で使う） |

> `.env` は `.gitignore` 済みなので、キーがコミットに含まれることはない。
> Secrets に登録したキーは、登録後は本人にも再表示されない（安全な保管場所）。

---

### つまずいたときの対処

| 症状 | 原因と対処 |
|---|---|
| `GH007: Your push would publish a private email address` | 実メールでコミットしている。手順2の noreply アドレスに変更し `git commit --amend --reset-author --no-edit` してから再push |
| `usage: git remote add [<options>] <name> <url>` | リモート名 `origin` が抜けている。`git remote add origin <URL>` と2つ指定する |
| ブラウザで承認後 `ERR_CONNECTION_RESET` | 認証結果の受け口が消えている。**通常のPowerShellウィンドウ**（Windowsキー → PowerShell）から実行する。時間制限のある環境ではブラウザ認証が間に合わない |
| `push` が `rejected` / `fetch first` | 手順4でREADME等を作ってしまった。`git pull --rebase origin main` してから再push |
| `Authentication failed` が続く | `cmdkey /delete:git:https://github.com` で古い認証情報を消してから再push |
| `remote origin already exists` | すでに登録済み。`git remote set-url origin <URL>` で上書きする |
| ブラウザ認証がどうしても通らない | デバイスコード方式に切替: `git config credential.gitHubAuthModes device` |

---

## 3. Cloudflare Pages に接続する

1. Cloudflare ダッシュボード → **Workers & Pages → Create → Pages → Connect to Git**
2. GitHub アカウントを連携し、作成したリポジトリを選択
3. ビルド設定を以下のように入力する

| 項目 | 値 |
|---|---|
| Framework preset | `Astro` |
| **Root directory** | **`site`** ← ここが重要 |
| Build command | `npm run build` |
| Build output directory | `dist` |

> **Root directory を `site` にすること。** リポジトリのルートには
> 収集パイプライン（別の package.json）があるため、指定しないとビルドに失敗する。

> **Node のバージョン**は `site/.node-version` で 22.12.0 に固定済み。
> Astro 7 は Node 22.12.0 以上を要求するが、Cloudflare の既定バージョンは
> それより古いことがあり、指定しないと `Unsupported engine` でビルドが落ちる。
> Cloudflare Pages はこのファイルを読んで自動でバージョンを合わせる。

> **Private リポジトリなので、GitHub連携時にアクセス許可を明示的に与える必要がある。**
> 連携画面で **Only select repositories** を選び、`brog` を選択する
> （All repositories でもよい）。Public リポジトリと違い、この操作をしないと
> Cloudflare 側の一覧にリポジトリが出てこない。

4. **Save and Deploy**
5. 数分で `https://<プロジェクト名>.pages.dev` で見られるようになる

---

## 4. 独自ドメインを割り当てる

> ⚠️ **左メニューに `Pages` という項目は無い。**メニューを探さず、下のリンクを開くこと。
>
> ```
> https://dash.cloudflare.com/?to=/:account/workers-and-pages
> ```
>
> プロジェクトの Custom domains に直行する場合（`brog-ez1` はプロジェクト名）:
>
> ```
> https://dash.cloudflare.com/?to=/:account/pages/view/brog-ez1/domains
> ```
>
> `:account` はダッシュボード側が自動で解決するので、アカウントIDを調べる必要はない。

1. 上のリンクで **Workers & Pages** を開き、`brog-ez1` を選択
2. 上部タブの **Custom domains → Set up a domain**
3. 取得したドメイン（例: `mihoudairader.com`）を入力 → **Continue**
4. Cloudflare Registrar で取得していれば、**DNSレコードは自動で作成される**
5. 数分〜十数分で HTTPS 込みで公開される（証明書も自動）。Status が `Active` になれば完了

`www` ありでもアクセスさせたい場合は、`www.mihoudairader.com` も同様に追加する。

> **`Pages` がメニューに見当たらないとき**（2026-08 時点で実際に詰まった箇所）
>
> 1. **ドメインの中に入っていないか確認する。** アカウントのホームから
>    `mihoudairader.com` をクリックすると、左メニューが**そのドメイン専用の項目**
>    （DNS / SSL-TLS / Caching / Rules …）に切り替わり、Workers & Pages は消える。
>    左上のパンくず（アカウント名）をクリックして**アカウント階層に戻る**。
> 2. **メニューが再編された。** Cloudflare は Workers に静的アセット配信を統合し、
>    新規の静的サイトを Workers に寄せる方針に変えた。その過程で `Pages` は
>    独立項目ではなくなり、**`Compute & AI` グループの下の `Workers & Pages`** に入った。
>    探すときは `Pages` ではなく **`Compute`** を目印にする。
>
> **既存の Pages プロジェクトはそのまま動く。**移行は不要。変わったのは新規作成の導線だけ。

---

## 5. 公開後にやること

### すぐに

- [ ] `site/src/pages/contact.astro` の `CONTACT` に**実在する連絡先**を設定
      （Googleフォームが最も手軽。AdSense審査で連絡手段の存在が確認される）
- [ ] `site/src/config.ts` の `SITE.author` を実際の運営者名に変更
- [ ] Google Search Console にサイトを登録し、`sitemap-index.xml` を送信

### 記事が20〜30本たまったら

- [ ] AdSense に申請
- [ ] 通過後、`site/.env` に `PUBLIC_ADSENSE_CLIENT=ca-pub-xxxx` を設定
      （Cloudflare Pages の環境変数にも同じものを登録する）
- [ ] A8.net / もしもアフィリエイト に登録し、`theme.yaml` の
      `search_links` をASPのディープリンクに差し替え

---

## 自動デプロイの流れ

```
収集(週2) ──→ 記事生成(P2) ──→ PR作成(P3)
                                  │
                          人がマージ（スマホ可）
                                  ↓
                          main への push
                                  ↓
                    Cloudflare Pages が自動ビルド
                                  ↓
                            本番に反映
```

PRごとにプレビューURLが自動生成されるので、**マージ前に実際の見た目を確認できる。**
