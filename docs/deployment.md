# Deployment and event operation

## Cloudflare

公開はmise管理のWranglerと既存OAuth認証を使います。Cloudflare API token、1Password経由のCloudflare認証、Pagesは使いません。自動公開のworkflowはありません。

```bash
mise up npm:wrangler
wrangler whoami
```

`wrangler.jsonc` の `JUDGE_DB` は既存の共有D1 `wordplay-arcade-budget`、`SCORING_QUEUE` と `EXPLANATION_QUEUE` は作成済みの採点Queue `devday-judge-20261018` と理由生成Queue `devday-judge-explanations-20261018` を参照します。再作成は不要です。D1は `devday_judge_` 専用テーブルと `devday_judge_migrations` だけを使い、既存サービスのテーブルとデータを削除・変更しません。

Queue consumerの設定はbatch 1、同時8件、自動再試行0です。各審査の試行と通常送信は最大3回、本番40件・検証140件の合計で、メモリ待機を除く採点メッセージの初回・明示再試行を最大540回に制限します。claim前のメモリ待機は同じ仕事を5秒後に再配送し、チェーンごと最大360回です。通常待機ではAPI・D1書き込み・試行回数・費用予約を増やさず、停止設定や上限で有限に止めます。

```bash
wrangler d1 migrations apply JUDGE_DB --remote
npm run typecheck
npm test
npm run build
wrangler deploy
```

旧Durable Objectのmigrationに `deleted_classes` を追加しません。旧namespaceを保持し、現在のWorkerにbindingを置きません。

## Secrets and public operation

審査画面のログインやトークン入力はありません。APIは本番開始時刻、提出期限、件数、重複、batchの冪等性、費用上限を検証します。別originからの書き込み要求を拒否します。結果の閲覧も公開です。受付を開けている間は公開された操作なので、イベント専用の件数・費用上限と停止フラグを必ず維持します。

採点は既存1Password Environmentの `OPENAI_API_KEY_20261018_HACKATHON` をWorker secretとして使います。APIキーをブラウザへ入力・送信しません。指定キーだけを非表示のプロセス間pipeで `wrangler secret put` の標準入力へ渡し、保存ファイルを作らずに設定します。Wranglerのプロセス環境からOP関連変数とAPIキーを除き、既存OAuthセッションで設定する手順を確認済みです。

1Passwordを使うのはアプリ用キーの取得だけです。Environment対応beta版 `op`、既存サービスアカウント、`OP_ENVIRONMENT_ID` を使い、`op whoami` のtypeが `SERVICE_ACCOUNT` であることを先に確認します。Cloudflareの認証・公開・管理に `op`、1PasswordのCloudflare credential、`CLOUDFLARE_API_TOKEN` は使いません。Wranglerは既存OAuthセッションで実行します。

```bash
op --version
op environment --help
op run --help
op whoami --format json
op run --environment "$OP_ENVIRONMENT_ID" -- node -e 'console.log(Boolean(process.env.OPENAI_API_KEY_20261018_HACKATHON))'
```

## Venue operation

1. Googleフォームの回答シートを開き、見出しと回答行をコピーします。
2. [審査画面](https://hackathon.nukoevi.app/) へ最大30件をまとめて貼り付け、プレビューを確認します。提出日時は日本時間として扱い、17:15:59を過ぎた回答は除外します。不要列は送信しません。
3. 17:30以降に本番の一括審査を開始します。全件のコミットを固定・保存してから最大8件を並列採点します。点数と順位は理由待ちの間も表示します。
4. 別Queueが保存した証拠から理由を生成します。理由の待機・失敗を点数と区別します。採点済みの確認メモへの操作は不要で、確定点・順位・同点全員通過を維持します。CSV・JSONを書き出せます。画面を閉じても処理は継続します。

10位と同点は全員通過します。発表モードは同点を含む通過全チームを低い点数から発表し、人数を10に制限しません。開始ボタンを押すとオリジナルBGMが流れ、音量とミュートを操作できます。発表画面を閉じると音源・タイマーを破棄して停止します。音声を開始できないブラウザでも発表は続けられます。

点数と攻撃判定はDecisions APIの `gpt-6-luna`、理由生成はResponses APIの `gpt-6.1-sol` です。理由の推論強度は本番medium、検証lowが既定です。検証区分ではmediumとhighも選べます。各段階で必要なモデルの利用権限を確認します。理由生成は点数を変更できません。

評価対象の発表機能、ソースとの照合、20条件の算出例と確認メモの扱いは [審査方法](judging-method.md) を参照します。審査画面の「審査の仕組み」でも概要を表示します。

画面、Decisions API、理由生成は [同じルーブリック](../src/shared/rubric.ts)と[20個の段階条件](../src/shared/decision-conditions.ts)を使います。採点の版は `2026-10-18-v4`、各観点は `0 / 2 / 4 / 6 / 8 / 10`、合計40点です。Decisionsのpredicate確率が0.8以上の条件を確認済みとして、下位条件を連続して満たした最高段階をコードで確定します。矛盾は要確認で保持し、Solは理由で指摘しても点数や条件を変更しません。実装ファイルのない提出は選考対象外です。過去のv2・v3結果は保持し、理由再生成にも当時の基準を使います。

GitHubの公開refs広告からdefault branchとSHAを固定し、[Gitの部分取得](https://git-scm.com/docs/gitprotocol-capabilities)で不要物を除いた対象テキストを全文読みます。参加者のGit属性や除外設定で実装を隠せないよう、アーカイブを使わず元のblobを取得します。匿名REST APIのIP共有クォータに依存せず、GitHub tokenや、会場端末のGitHub CLI認証は使いません。両APIに同じ全文を渡し、公式トークン計数で容量を検証します。取得の失敗やサイズ上限は未実装の0点と混同せず、要確認で停止します。修復後の再試行も同じSHAと全文hashを保持します。

全文は最大4MiBを512KiBずつD1へ分割保存します。公開後の検証では512KiBを超える実証拠の保存・復元と、理由生成での同一hashの再利用も確認します。

空のQueueで採点処理は起動しません。常駐ポーリング、定期heartbeat、定期再採点はありません。

## Budget and stop

本番$90、検証$40を独立管理します。使用済みと未精算予約を合わせて制限し、usage不明の予約を解放しません。再試行しても過去の精算と予約を保持します。台帳を消したりリセットしたりして再開しないでください。

受付停止は `SUBMISSIONS_OPEN: false`、新しい採点開始とAPI費用予約の停止は `JUDGING_ENABLED: false` にして正規の `wrangler deploy` で反映します。実行済みAPIの精算と結果保存は許可します。停止フラグだけで送信済みのOpenAI要求が取り消されたとは扱いません。

イベント運用中は両方trueです。停止時は両方falseへ変更して公開します。

失敗結果と30分以上進まない審査は主催者が状態と費用を確認して再試行します。自動再試行はありません。初回と再試行を合わせて最大3回です。ローカルspoolや外部callbackの再送操作はありません。

主催者が採点範囲の変更に伴う再採点を明示した場合は、`POST /api/submissions/:id/rescore` に `{"confirm":true,"requestId":"新しいUUID"}` を送信します。同じ操作の再送には同じUUIDを使います。完了・失敗状態だけを受け付け、未精算予約がある提出は拒否します。通常の `retry` は採点済みの点数を変えず、理由生成だけを再試行します。

再採点は旧提出行を `devday_judge_scoring_history` に保存し、固定SHA・試行回数・送信回数・費用台帳を維持します。旧証拠は元のテーブルに保持し、新しい全文は `devday_judge_rescore_evidence_manifests` と `devday_judge_rescore_evidence_chunks` に世代別で保存します。追加の採点も既存予算と最大3回の上限を消費します。導入には追加migration `0011_scoring_revisions.sql` の適用が必要です。

課金前の実行環境停止は別に復旧できます。開始後5分以上経過した未採点処理で、API予約履歴・証拠保存が両方0件なら「課金前の停止を復旧」から同じSHAと試行を1回続行します。APIが最終条件を検査し、過去の予約があれば拒否します。callback世代と専用の復旧送信回数を更新し、試行・通常送信・費用履歴を消しません。

## Post-event shutdown on 2026-10-18

イベント終了後は両停止フラグをfalseにし、`./public/closed` の静的な終了ページを配信します。`run_worker_first: false` と `not_found_handling: single-page-application` を使い、`workers_dev` と `preview_urls` もfalseにします。両方の稼働フラグがtrueでない場合、Workerは全API・internal要求をD1アクセス前に遮断します。受付状態はclosed、実行状態はofflineを返し、それ以外は410です。QueueハンドラもD1へ接続せず全メッセージをackします。採点・理由生成の両QueueはOAuth認証のWranglerで配送を停止済みです。

停止時はWorker secretの `OPENAI_API_KEY_20261018_HACKATHON` も削除し、1Password Environmentの値は保持します。共有D1と審査結果・証拠・費用台帳は削除しません。停止確認時のdashboard取得は失敗し、Wranglerの読み取りはD1 Freeの日次行読み取り上限超過（code 7500）を返しました。最終費用や実行中件数0は確認できていません。有料プランへの変更は行いません。

終了ページは無料の静的アセット配信です。D1 Freeの上限超過は有料利用へ自動切替せず、停止前に発生した利用料は取り消されません。アカウントの契約プランは変更しません。

再開には明示的な運用判断が必要です。アセットを `./dist/client` に戻し、`run_worker_first` を `/api/*` に戻し、両稼働フラグ・Worker secretを復元して公開したうえで、両Queueの配送を再開します。停止処理ではこれらの再開操作を行いません。

## Verify publication

終了後は終了ページ、受付closed、実行offline、変更APIの拒否を確認します。以下は稼働中の確認手順です。

```bash
curl -fsS https://hackathon.nukoevi.app/api/dashboard
```

日付、段階別ルーブリック、検証区分、本番予算、Queueの実API結果、攻撃表示の80%閾値、デスクトップ・短い画面・モバイルの表示を確認します。公開URLが変更後の結果を返すことと、Mac Studio側のプロセスに依存しないことを完了条件とします。

## Event data

受付は本番40件・検証140件で制限します。イベント後は受付と採点を停止し、CSV・JSONを書き出します。D1の保存期間はイベント後90日を目安とし、削除する専用テーブルと影響は別途確認します。無期限保存や自動削除を前提にしません。共有D1そのものや旧Durable Objectは削除しません。
