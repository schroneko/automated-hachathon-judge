# Cloud execution decision

2026-10-18: 会場のMacBook Airではブラウザだけを使う構成です。Mac Studioの起動、接続、ローカルサーバー、ローカル保存に依存しません。

## Selected services

Workersで画面とAPIを提供し、既存の共有D1 `wordplay-arcade-budget` の `devday_judge_` テーブルだけを使います。新しいD1の作成枠は不要です。既存テーブル・データは変更しません。

作成済みのCloudflare Queue `devday-judge-20261018` に審査ID・イベント・区分・試行番号を送り、Workerのconsumerで有限の採点を実行します。ブラウザを閉じても開始済みの採点と残りのキュー処理が続きます。Durable ObjectsとBrowser Renderingは使用しません。旧Durable Objectのmigration履歴と拒否用classだけを保持します。

公開Git smart HTTP refs広告でdefault branchとSHAを固定し、recursive treeのREST取得を1試行につき1回に抑えます。refsは最大256KB、tree応答は最大2MB、証拠は最大24ファイル・各12KB・合計120KBです。GitHub token、対象コードの実行、リンク巡回は不要です。

主催者は既存の `RUNNER_TOKEN` をブラウザで使います。トークンの主催者への受け渡しは未完了です。採点キーは既存1Password Environmentの `OPENAI_API_KEY_20261018_HACKATHON` をWorker secretとして扱い、値を表示せずに注入する手順は検証中です。

## Bounds and cost

| 項目 | 上限 |
| --- | --- |
| 登録 | 本番40件、検証20件 |
| 試行・送信 | 初回と主催者の明示的な再試行を合わせて1件につき最大3回 |
| Queue送信 | 最大180件、審査IDなど1KB未満のmetadataだけ |
| Consumer | batch 1、同時4件、自動再試行0 |
| GitHub取得 | 1試行につき全体45秒 |
| OpenAI採点 | 各API呼び出し最大180秒 |
| OpenAI費用 | 予約を含め本番$90、検証$20 |
| Queue保持 | Workers Freeの24時間 |
| 結果・費用台帳 | イベント後90日を目安。削除は別途確認 |

Queueの通常配信は書き込み・読み取り・削除で1通あたり3操作です。180通なら通常約540操作で、Workers Freeの10,000操作/日というアカウント枠を下回ります。重複配信は追加読み取りになり得ますが、条件付きclaimで再採点を拒否します。上限はこのイベントの送信数に対するもので、他サービスの利用量を含むアカウント全体の予約ではありません。

変更のないリクエスト、空のキュー、重複登録、処理済みメッセージの重複配信は書き込み0件です。常駐ポーリング、定期heartbeat、Cronはありません。再試行で過去の精算や未確定の費用予約を消さず、同じ区分の上限へ含めます。登録上限・送信上限・試行上限・費用予約・停止フラグをテストしてから公開します。

本番はSolのhigh、検証はlowが既定で、検証区分に限りhighで再検証できます。ルーブリック `2026-10-18-v1` の `0 / 2 / 4 / 6 / 8 / 10` を画面と両APIで共有し、根拠と次の段階に不足する条件を示します。

料金・制限の確認元: [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)、[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)。

## Setup and stop

Wranglerの既存OAuthセッションを使います。1Passwordはアプリ用OpenAIキーの取得にだけ使い、Cloudflare用credentialは取得・注入しません。

Queueは作成済みで、共有D1には審査専用migrationを適用します。新規D1やQueueを毎回作成しません。正規の公開手順は [Deployment](deployment.md) にまとめます。

受付停止は `SUBMISSIONS_OPEN: false`、採点停止は `JUDGING_ENABLED: false` です。採点停止は新しいclaimとAPI費用予約を拒否し、実行済みAPIの精算・結果保存は許可します。停止設定は正規の `wrangler deploy` で反映します。未確定の費用予約を解放して再開しません。

公開に失敗した場合は受付と採点を停止状態に保ち、以前の停止済みWorkerへ戻せるよう公開versionを記録します。D1の新しいテーブルや旧Durable Objectのnamespaceを削除するrollbackは行いません。イベント後は書き出しを保管し、90日を目安に審査専用データの削除対象と影響を別途確認します。
