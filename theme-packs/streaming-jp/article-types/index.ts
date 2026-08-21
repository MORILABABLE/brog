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
 * ■ 総合記事とジャンル別記事を並べる場合
 * 1つの記事タイプに2つのモードを持たせず、別々のタイプとして登録する。
 * 総合とジャンル別では読者に渡すものが違い、テンプレートも分かれるため。
 *   例) `leaving`（総合）と、今後足す `leaving-genre`（ジャンル別・より詳細）
 */
import type { ArticleType } from '../../../pipeline/core/article.ts'
import { leavingArticle } from './leaving.ts'
import { arrivalsArticle } from './arrivals.ts'

export const ARTICLE_TYPES: ArticleType[] = [leavingArticle, arrivalsArticle]
