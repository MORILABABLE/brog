/**
 * このテーマパックが提供する記事タイプの一覧。
 *
 * ■ ここが唯一の登録場所
 * パイプライン（`pipeline/cli/write.ts`）はこのファイルだけを見る。
 * **記事を1種類増やすときに直すのはこのファイルと、追加する記事タイプだけ。**
 * CLI もスラッシュコマンドも触らなくてよい。
 *
 * ■ 記事を1種類増やす手順
 *   1. `templates/<新しいタイプ>.md` に構成と文体を書く
 *   2. `templates/fixed-phrases.md` に `<新しいタイプ>-` で始まる固定文言を足す
 *   3. `article-types/<新しいタイプ>.ts` を作る（共通処理は `shared.ts` にある）
 *   4. このファイルの ARTICLE_TYPES に足す
 *
 * ■ 軸（`axis`）は必ず決める
 * 記事タイプは `axis: 'service' | 'genre'` を宣言しなければ型が通らない。
 * サービス軸なら**他社を混ぜない**、ジャンル軸なら**横断してよい**。
 * 軸とタイトルの決まりは `templates/naming.md` にあり、
 * 検査は `shared.ts` の `titleIssues()`（`verifyTitle` から呼ぶ）。
 * 判断の根拠と実測は docs/ARTICLE-RULES.md。
 *
 * ★ **`axis: 'genre'` にすると、記事の frontmatter に `genre` が自動で入る**
 *   （2026-08-27〜）。値は選ばれたバリアントの `key` で、
 *   入れているのは `pipeline/cli/write.ts` の `articleGenre()`。記事タイプ側は何もしなくてよい。
 *   ジャンル軸なのに `variants` を宣言していないと `--apply` がそこで止まる
 *   （ジャンルの付いていない記事が黙って1本できるのを防ぐため）。
 *
 *   バリアントの `key` は `../genres.ts` の `GENRES` から来る。
 *   **`site/src/content.config.ts` の `genre` の enum と揃っていること。**
 *   揃っていなければサイトのビルドが落ちる。それが検知の仕組み。
 *   ジャンルを1つ増やすときは `genres.ts` / `content.config.ts` /
 *   `site/src/config.ts` の `GENRES` の**3か所**を直す。
 *
 * ■ ショート動画の台本を付けるかどうか
 * `buildShortPrompt` を実装すれば付く。実装しなければ付かない。それだけ。
 * 中身は `shared.ts` の `shortScriptSection()` に集めてあるので、
 * 記事タイプ側は「日付の呼び方・素材が邦題か・固有の注意」の3つを渡すだけでよい。
 * 現状 `leaving` と `arrivals` が実装し、`ended` は意図的に実装していない
 * （理由は `ended.ts` の冒頭）。
 *
 * ■ サービス別とジャンル別を並べる場合
 * 1つの記事タイプに2つのモードを持たせず、別々のタイプとして登録する。
 * 軸が違えば読者に渡すものが違い、テンプレートも検査も分かれるため。
 *   例) `arrivals-service`（サービス別）と `arrivals`（ジャンル別）は別タイプ。
 *
 * ★ **配信終了側にジャンル別を作らないこと**（2026-08-27 に決定）。
 *   読者は「Netflixで何が終わるのか」を探しに来る。終了はサービス別だけにする
 *   （docs/ARTICLE-RULES.md 1節C）。
 */
import type { ArticleType } from '../../../pipeline/core/article.ts'
import { leavingArticle } from './leaving.ts'
import { endedArticle } from './ended.ts'
import { arrivalsArticle } from './arrivals.ts'
import { arrivalsServiceArticle } from './arrivals-service.ts'
import { specialArticle } from './special.ts'
import { upcomingArticle } from './upcoming.ts'

export const ARTICLE_TYPES: ArticleType[] = [
  leavingArticle,
  endedArticle,
  arrivalsArticle,
  arrivalsServiceArticle,
  specialArticle,
  upcomingArticle,
]
