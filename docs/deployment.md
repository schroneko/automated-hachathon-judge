# Deployment and event operation

## Cloudflare

公開はmise管理のWranglerと既存OAuth認証を使います。Cloudflare API token、1Password経由のCloudflare認証、Pagesは使いません。自動公開のworkflowはありません。

```bash
mise up npm:wrangler
wrangler whoami
```

`wrangler.jsonc` の `JUDGE_DB` は既存の共有D1 `wordplay-arcade-budget`、`SCORING_QUEUE` と `EXPLANATION_QUEUE` は作成済みの採点Queue `devday-judge-20261018` と理由生成Queue `devday-judge-explanations-20261018` を参照します。再作成は不要です。D1は `devday_judge_` 専用テーブルと `devday_judge_migrations` だけを使い、既存サービスのテーブルとデータを削除・変更しません。

Queue consumerの設定はbatch 1、同時8件、自動再試行0です。各審査の試行と送信は最大3回、本番40件・検証40件の合計で採点メッセージは最大240回に制限します。

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
2. [審査画面](https://hackathon.nukoevi.app/) へ最大30件をまとめて貼り付け、プレビューを確認します。提出日時は日本時間として扱い、17:15を過ぎた回答は除外します。不要列は送信しません。
3. 17:30以降に本番の一括審査を開始します。全件のコミットを固定・保存してから最大8件を並列採点します。点数と順位は理由待ちの間も表示します。
4. 別Queueが保存した証拠から理由を生成します。理由の待機・失敗・要確認を点数と区別し、上位10チームの境界や同点を確認してCSV・JSONを書き出します。画面を閉じても処理は継続します。

点数と攻撃判定はDecisions APIの `gpt-6-luna`、理由生成はResponses APIの `gpt-6.1-sol` です。理由の推論強度は本番medium、検証lowが既定です。検証区分ではmediumとhighも選べます。各段階で必要なモデルの利用権限を確認します。理由生成は点数を変更できません。

画面、Decisions API、最終採点は [同じルーブリック](../src/shared/rubric.ts) を使います。版は `2026-10-18-v1`、各観点は `0 / 2 / 4 / 6 / 8 / 10`、合計40点です。各段階の全条件に照らし、根拠と次の段階に不足する条件を確認します。

GitHubの公開refs広告からdefault branchとSHAを固定し、treeのREST取得は1試行につき1回です。GitHub tokenや、会場端末のGitHub CLI認証は使いません。RESTのrate limitに達した場合は失敗を確認し、制限解除後に主催者が再試行します。

空のQueueで採点処理は起動しません。常駐ポーリング、定期heartbeat、定期再採点はありません。

## Budget and stop

本番$90、検証$20を独立管理します。使用済みと未精算予約を合わせて制限し、usage不明の予約を解放しません。再試行しても過去の精算と予約を保持します。台帳を消したりリセットしたりして再開しないでください。

受付停止は `SUBMISSIONS_OPEN: false`、新しい採点開始とAPI費用予約の停止は `JUDGING_ENABLED: false` にして正規の `wrangler deploy` で反映します。実行済みAPIの精算と結果保存は許可します。停止フラグだけで送信済みのOpenAI要求が取り消されたとは扱いません。

イベント運用中は両方trueです。停止時は両方falseへ変更して公開します。

失敗結果と30分以上進まない審査は主催者が状態と費用を確認して再試行します。自動再試行はありません。初回と再試行を合わせて最大3回です。ローカルspoolや外部callbackの再送操作はありません。

## Verify publication

```bash
curl -fsS https://hackathon.nukoevi.app/api/dashboard
```

日付、段階別ルーブリック、検証区分、本番予算、Queueの実API結果、攻撃表示の80%閾値、デスクトップ・短い画面・モバイルの表示を確認します。公開URLが変更後の結果を返すことと、Mac Studio側のプロセスに依存しないことを完了条件とします。

## Event data

受付は本番40件・検証40件で制限します。イベント後は受付と採点を停止し、CSV・JSONを書き出します。D1の保存期間はイベント後90日を目安とし、削除する専用テーブルと影響は別途確認します。無期限保存や自動削除を前提にしません。共有D1そのものや旧Durable Objectは削除しません。
