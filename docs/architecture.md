# Architecture

## Components

### Cloudflare Worker

静的 frontend と public API、Runner 用 internal API を配信します。`SUBMISSIONS_OPEN` を fail-closed で判定し、受付停止中は submission を Durable Object へ渡しません。

### JudgeState Durable Object

submission、queue、callback token、IP cooldown、Runner heartbeat、最新 completed result を SQLite-backed storage に保存します。queue は normalized repository 名から決まる 10 bucket で構成します。

`JUDGE_STATE` binding は `global` JudgeState instance を参照します。JudgeState は、成功した `storage.put` と `storage.delete` の key 数を metadata と同じ transaction で UTC 日ごとに記録します。no-op または拒否された処理は counter を更新しません。

日次書き込み件数が 25,000 行に達すると、JudgeState は構造化 warning を 1 回記録します。50,000 行の hard limit を超える保存は拒否します。`GET /internal/runner/write-budget` は Runner bearer token で認証した read-only endpoint で、counter、warning 記録状態、停止状態を返します。

### Runner

Worker を polling し、最大 10 slot で job を処理します。GitHub API の認証には環境変数 `GITHUB_TOKEN` を使い、未設定時は `gh auth token` を実行します。

Runner は callback 前に結果を local spool へ保存します。callback が完了するまで exponential backoff で再送し、process 再起動時にも spool を replay します。

Runner は Worker または JudgeState から HTTP `507` を受けると停止します。hard limit により callback が拒否された場合、Runner は未送信結果を local spool に残します。

### Evidence collector

default branch と現在の commit SHA を GitHub REST API で解決します。tree から評価に有用な text file を優先順位付きで選び、raw content API から取得します。

以下は行いません。

- `git clone`
- commit history の取得
- archive の download または展開
- repository code の実行
- README 内リンクの追跡

### Codex scorer

証拠 snapshot だけを read-only workspace に保存します。Codex SDK thread は `approvalPolicy: never`、`sandboxMode: read-only`、network disabled、web search disabled で開始し、strict JSON schema の結果だけを受け付けます。

## Data flow

```text
Browser
  -> Cloudflare Worker
  -> JudgeState Durable Object
  <- Mac or Linux Runner
  -> GitHub API
  -> Codex SDK
  -> per-job callback
  -> JudgeState Durable Object
  -> public ranking
```

## Trust boundaries

- Browser input は untrusted です。GitHub URL 以外を拒否し、request body を 2 KB に制限します。
- GitHub repository content は untrusted です。実行せず、prompt instruction として扱わないよう system prompt で境界を示します。
- Runner endpoint は shared bearer token で保護します。
- callback は job 固有 token で保護し、public response には含めません。
- Codex authentication と GitHub authentication は Runner host にだけ保持します。

## Persistence

Durable Object は metadata と job records を分けて保存します。ranking は normalized repository ごとの最新 completed submission から都度生成します。古い job record は履歴として残るため、長期運用では retention policy の追加が必要です。

日次書き込み counter は `global` JudgeState instance から実行した put / delete の key 数です。Cloudflare 請求書の Durable Objects Rows Written そのものではなく、別の Durable Object namespace、Cloudflare 内部処理、Requests、Duration を含みません。

## Failure behavior

- Runner offline: submission 作成を `503` で拒否
- 受付停止: submission 作成を `403` で拒否
- 同一 repository が処理中: `409`
- IP cooldown: `429`
- GitHub で評価材料なし: 0 点で completed
- scoring failure: failed として確定
- callback failure: local spool から再送
- 日次 warning 到達: 構造化 warning を 1 回記録し、処理を継続
- 日次 hard limit 到達: finalize を含む追加保存を `507` で拒否し、Runner は未送信結果を local spool に保持
