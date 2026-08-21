/**
 * 収集ソースの抽象。
 *
 * LLM を差し替え可能にしたのと同じ発想で、データソースも差し替え可能にしておく。
 * パイプライン本体は ChangeEvent / Work の形しか知らない。
 */

export type ChangeKind = 'new' | 'removed' | 'expiring' | 'upcoming'

/** 作品1件の正規化された情報。テーマ固有の情報は meta に逃がす。 */
export interface Work {
  /** ソース内での一意ID */
  id: string
  /** 原題。Streaming Availability API からは英語で返る。 */
  title: string
  /**
   * サイトの言語での正式タイトル（邦題）。Wikidata から解決する。
   * 解決できなかった場合は undefined で、記事側は title にフォールバックする。
   */
  localizedTitle?: string
  /**
   * 原語でのタイトル。**日本の作品は日本語表記のまま返る**
   * （例: Dear Family → ディア・ファミリー、Last Mile → ラストマイル）。
   * Wikidata に項目が無い作品でも、これがあれば邦題と作品の出自が分かる。
   */
  originalTitle?: string
  /** movie | series */
  type: string
  /** 公開年。不明なら undefined */
  year?: number
  overview: string
  /** 0-100 に正規化した評価 */
  rating?: number
  genres: string[]
  /**
   * 監督。**ローマ字表記で返る**（例: Sho Tsukikawa）。
   * 日本語表記への変換は邦題と同じく推測が効かないので、記事側で勝手に訳さないこと。
   */
  directors?: string[]
  /** 主な出演者。監督と同じくローマ字表記。 */
  cast?: string[]
  posterUrl?: string
  /** 作品ページへのリンク（出典として記事に載せる） */
  link?: string
  meta: Record<string, unknown>
}

/** 配信状況の変化1件 */
export interface ChangeEvent {
  /** 収集した時刻 */
  collectedAt: string
  /** theme.yaml で定義したサービスキー */
  service: string
  kind: ChangeKind
  /** 変化が起きる/起きた時刻。expiring で日付不明なら undefined */
  at?: string
  work: Work
}

export interface CollectOptions {
  /** 何日前までの変化を取るか */
  sinceDays: number
  /** 取得する変化の種類 */
  kinds: ChangeKind[]
}

/**
 * 収集ソース。
 * 実装は pipeline/sources/ 配下に置き、テーマ側から選択する。
 */
export interface Source {
  readonly name: string
  /** 配信状況の変化を集める */
  collectChanges(opts: CollectOptions): Promise<ChangeEvent[]>
  /** ランキング記事の素材として、条件に合う作品を集める */
  collectWorks(query: WorkQuery): Promise<Work[]>
}

export interface WorkQuery {
  /** theme.yaml のサービスキー。省略時は全サービス */
  services?: string[]
  type?: 'movie' | 'series'
  genres?: string[]
  keyword?: string
  ratingMin?: number
  yearMin?: number
  yearMax?: number
  /** 取得上限。API のページングを内部で回す */
  limit: number
}
