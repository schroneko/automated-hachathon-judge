# Deployment

## 1. Cloudflare configuration

`wrangler.jsonc` の次の値を自分の環境へ変更します。

- `name`: Worker 名
- `routes`: custom domain
- `CALLBACKS_ENABLED`: 初回は `false`
- `JUDGE_STATE_ROWS_WRITTEN_DAILY_LIMIT`: UTC 日次 hard limit。既定値は `50000`
- `JUDGE_STATE_ROWS_WRITTEN_DAILY_WARNING`: UTC 日次 warning。既定値は `25000`
- `MAX_ACCEPTED_SUBMISSIONS`: event 全体の投稿上限
- `RUNNER_ENABLED`: 初回は `false`
- `SUBMISSIONS_OPEN`: 初回は `false` を推奨
- `UNRANKED_OWNERS`: 主催者の GitHub owner。不要なら空文字

既存の `migrations` は Durable Object の履歴なので削除しないでください。

clone、依存関係の導入、test、build だけでは Cloudflare への deploy や課金は発生しません。以降の deploy を実行すると、自分の Cloudflare account で Worker と Durable Objects の利用量が計測されます。

Cloudflare dashboard の Manage Account > Billing > Billable Usage で、account 全体の従量課金額に `$1` と `$10` の Budget Alert を設定します。Budget Alert は日次集計による遅延がある通知機能です。Budget Alert は Worker、Durable Object、従量課金を自動停止しません。

## 2. Runner token

Runner と Worker の間で使う random token を作成します。

```bash
mkdir -p "$HOME/Library/Application Support/Hackathon Judge"
openssl rand -hex 32 > "$HOME/Library/Application Support/Hackathon Judge/runner-token"
chmod 600 "$HOME/Library/Application Support/Hackathon Judge/runner-token"
wrangler secret put RUNNER_TOKEN < "$HOME/Library/Application Support/Hackathon Judge/runner-token"
```

Linux では repository 外の任意の absolute path を使い、`RUNNER_TOKEN_FILE` と `RUNNER_SPOOL_DIR` を明示してください。

## 3. Deploy Worker

Wrangler の OAuth session を確認し、build と deploy を実行します。

```bash
wrangler whoami
npm run build
wrangler deploy
```

## 4. Authenticate Runner host

GitHub と Codex へ sign in します。

```bash
gh auth login
codex login
```

Runner は `gh auth token` を process memory に読み込みます。Codex SDK は Runner host の Codex authentication を利用します。

## 5. Enable and start Runner

投稿受付を閉じたまま `CALLBACKS_ENABLED` と `RUNNER_ENABLED` を `true` にして deploy します。

```json
"CALLBACKS_ENABLED": "true",
"RUNNER_ENABLED": "true",
"SUBMISSIONS_OPEN": "false"
```

```bash
npm run build
wrangler deploy
```

`RUNNER_BASE_URL` は必須です。公開中の別環境へ接続する既定値はありません。

```bash
RUNNER_BASE_URL=https://judge.example.com \
RUNNER_TOKEN_FILE="$HOME/Library/Application Support/Hackathon Judge/runner-token" \
RUNNER_CONCURRENCY=10 \
npm run runner:start
```

production では launchd、systemd、または同等の process supervisor を使用してください。Runner 起動時に中断 job の recovery が走るため、同じ Worker に対して複数の独立 Runner process を同時起動しないでください。並列処理は 1 process 内の slot で行います。

## 6. Verify

Runner 起動後に public endpoint を確認します。

```bash
curl https://judge.example.com/api/runner-status
curl https://judge.example.com/api/submission-status
curl https://judge.example.com/api/ranking
RUNNER_TOKEN="$(<"$HOME/Library/Application Support/Hackathon Judge/runner-token")"
curl -H "Authorization: Bearer $RUNNER_TOKEN" \
  https://judge.example.com/internal/runner/write-budget
```

## 7. Open submissions

Runner が online であることを確認してから、`wrangler.jsonc` の `SUBMISSIONS_OPEN` を `true` に変更し、再度 deploy します。

```bash
npm run build
wrangler deploy
```

イベント終了時は、最初に `SUBMISSIONS_OPEN` と `RUNNER_ENABLED` を `false`、`CALLBACKS_ENABLED` を `true` にして deploy します。新しい job の取得を止めた状態で処理中 callback の完了を確認し、`CALLBACKS_ENABLED` も `false` にして再度 deploy します。その後、process supervisor から Runner を停止します。既存ランキングは残ります。

課金や障害への緊急対応では、`CALLBACKS_ENABLED`、`RUNNER_ENABLED`、`SUBMISSIONS_OPEN` を同時に `false` にして deploy し、Runner process を停止します。無効化後の投稿、claim、heartbeat、recover、callback は Durable Object へ到達しません。

状態保存は差分方式です。待機中の claim、拒否された submission と callback、変更のない recover は 0 write です。job の更新は保存済み履歴件数に比例せず、event 全体の投稿総数にも上限があります。

日次書き込みガードは、`JUDGE_STATE` binding が参照する `global` JudgeState instance で成功した `storage.put` と `storage.delete` の key 数を UTC 日ごとに記録します。25,000 行に達すると構造化 warning を 1 回記録します。50,000 行の hard limit を超える保存は拒否します。Runner は HTTP `507` を受けると停止し、未送信結果を spool directory に残します。

`GET /internal/runner/write-budget` は Runner bearer token で認証した read-only endpoint です。UTC 日付、成功した put / delete の key 数、warning、hard limit、停止状態を返し、Durable Object Storage を更新しません。

日次書き込みガードの計測値は、Cloudflare 請求書に記載される Durable Objects Rows Written そのものではありません。別の Durable Object namespace、Cloudflare 内部処理、Requests、Duration は日次書き込みガードの計測対象外です。

## Update procedure

```bash
git pull --ff-only
npm install
npm run typecheck
npm test
npm run build
wrangler deploy
```

Runner code を更新した場合は、build 後に supervisor から Runner process を再起動してください。
