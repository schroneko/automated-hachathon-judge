# Cloud execution decision

2026-10-18: 会場のMacBook Airではブラウザだけを使う構成です。Mac Studioの起動、接続、ローカルサーバー、ローカル保存に依存しません。

## Selected services

Workersで画面とAPIを提供し、既存の共有D1 `wordplay-arcade-budget` の `devday_judge_` テーブルだけを使います。新しいD1の作成枠は不要です。既存テーブル・データは変更しません。

採点Queue `devday-judge-20261018` と理由生成Queue `devday-judge-explanations-20261018` に審査ID等の有限メッセージを送り、Workerのconsumerで処理します。Decisionsの点数を先に保存し、Solの理由生成が採点の進行を占有しません。ブラウザを閉じても処理が続きます。Durable ObjectsとBrowser Renderingは使用しません。旧Durable Objectのmigration履歴と拒否用classだけを保持します。

公開Git smart HTTP refs広告でdefault branchとSHAを固定し、部分取得でcommit・treeと必要なblobを読みます。匿名REST APIのIP共有クォータには依存しません。refsは最大256KB、PACKは圧縮16MiB・展開32MiB・単一オブジェクト4MiB・50,000エントリーです。不要物を除いた対象UTF-8テキストを最大2,000ファイル・合計3MiBで全文取得します。途中切りや参加者の除外設定は使いません。GitHub token、対象コードの実行、リンク巡回は不要です。

画面のログインやトークン入力はありません。採点キーは既存1Password Environmentの `OPENAI_API_KEY_20261018_HACKATHON` をWorker secretへ非表示のpipeで設定済みです。ブラウザへ渡しません。

## Bounds and cost

| 項目 | 上限 |
| --- | --- |
| 登録 | 本番40件、検証100件。一括最大30件 |
| 試行・送信 | 初回と主催者の明示的な再試行を合わせて1件につき最大3回 |
| 採点Queue送信 | 最大420件、審査IDなど1KB未満のmetadataだけ |
| 理由生成Queue送信 | 1件につき最大3回、合計最大420件 |
| コミット固定Queue送信 | batchにつき最大3回、合計最大420件 |
| 課金前停止の復旧Queue送信 | 各提出につき最大1回、合計最大140件 |
| Consumer | 両Queueともbatch 1、最大同時8件、自動再試行0 |
| GitHub取得 | 1試行につき全体45秒 |
| 固定証拠 | 最大4MiB、512KiBずつ最大8分割。各提出で1個を再利用 |
| OpenAI採点 | 各API呼び出し最大180秒 |
| OpenAI費用 | 予約を含め本番$90、検証$20 |
| Queue保持 | Workers Freeの24時間 |
| 結果・費用台帳 | イベント後90日を目安。削除は別途確認 |

Queueの通常配信は書き込み・読み取り・削除で1通あたり3操作です。採点・理由生成・コミット固定・課金前復旧の合計最大1,400通なら、通常配信は約4,200操作です。新規batchには少なくとも1件の新規審査が必要で、合計140件の登録上限がbatch数の上限にもなります。重複配信は追加読み取りになり得ますが、条件付きclaimで再処理を拒否します。この上限は他サービスの利用量を含むアカウント全体の予約ではありません。

変更のないリクエスト、空のキュー、重複登録、処理済みメッセージの重複配信は書き込み0件です。常駐ポーリング、定期heartbeat、Cronはありません。再試行で過去の精算や未確定の費用予約を消さず、同じ区分の上限へ含めます。登録上限・送信上限・試行上限・費用予約・停止フラグをテストしてから公開します。

本番はSolのmedium、検証はlowが既定で、検証区分ではmediumとhighも選べます。ルーブリック `2026-10-18-v4` の `0 / 2 / 4 / 6 / 8 / 10` と20個の段階条件を画面と両APIで共有します。Decisionsが条件を個別判定し、確率が0.8以上の条件を確認済みとして、最高連続段階をコードで採点します。実装ファイルのない提出は選考対象外です。両モデルは同じSHA・同じ全文を読み、Solは点数・条件・要確認の保持を変更できません。過去のv2・v3結果と理由再生成は当時の基準を保持します。

採点前に公式APIで両モデルの入力トークンを計数します。入力上限922,000トークンと説明用の余裕を確認し、長文料金の割増を含めて予約します。容量不足は要確認として停止し、黙ってソースを切りません。

料金・制限の確認元: [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)、[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)。

## Setup and stop

Wranglerの既存OAuthセッションを使います。1Passwordはアプリ用OpenAIキーの取得にだけ使い、Cloudflare用credentialは取得・注入しません。

Queueは作成済みで、共有D1には審査専用migrationを適用します。新規D1やQueueを毎回作成しません。正規の公開手順は [Deployment](deployment.md) にまとめます。

受付停止は `SUBMISSIONS_OPEN: false`、採点停止は `JUDGING_ENABLED: false` です。採点停止は新しいclaimとAPI費用予約を拒否し、実行済みAPIの精算・結果保存は許可します。停止設定は正規の `wrangler deploy` で反映します。未確定の費用予約を解放して再開しません。

公開に失敗した場合は受付と採点を停止状態に保ち、以前の停止済みWorkerへ戻せるよう公開versionを記録します。D1の新しいテーブルや旧Durable Objectのnamespaceを削除するrollbackは行いません。イベント後は書き出しを保管し、90日を目安に審査専用データの削除対象と影響を別途確認します。
