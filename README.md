# Automated Hackathon Judge

公開 GitHub リポジトリを、4 つの観点で自動ジャッジしてランキングを公開する Web アプリです。Cloudflare Workers と Durable Objects が受付と状態管理を担当し、別ホストの Codex SDK Runner がリポジトリの証拠を読み取って採点します。

稼働例: https://hackathon.nukoevi.app/

稼働例ではイベント終了後のため新規投稿を停止しています。ランキングと既存結果は閲覧できます。

## Features

- 入力は公開 GitHub リポジトリ URL のみ
- default branch の現在の commit SHA を固定して評価
- clone、archive 展開、リポジトリ内コード実行を行わない
- README 内の外部リンクを評価対象にしない
- 4 観点を各 0〜10 点、合計 40 点で 1 回だけ採点
- リポジトリごとの最新 completed 結果だけをランキングへ反映
- 最大 10 件を並列処理
- prompt injection の兆候を通常点とは別の「ぬこスコア」として検出
- 設定値だけで投稿受付の停止と再開が可能

## Scoring

| 観点 | 確認内容 |
| --- | --- |
| 技術的な実装 | completeness、architecture、robustness、security |
| デザインとユーザー体験 | UI structure、flow、consistency、accessibility |
| 潜在的なインパクト | importance、audience、practicality、growth potential |
| アイデアの質 | originality、problem-solution fit、insight |

点数の共通基準は、0 が評価可能な証拠なし、1〜2 が初期段階、3〜4 が大きな不足あり、5〜6 が基準到達、7〜8 が明確に強い、9〜10 がハッカソンとして突出、です。

採点結果には短い公開理由と根拠ファイルパスを含めます。chain-of-thought や非公開の推論は保存しません。

## Architecture

1. frontend が GitHub URL を Worker へ送信します。
2. Worker が入力、受付状態、Runner の稼働状態、IP cooldown、同一リポジトリの重複処理を検証します。
3. Durable Object が submission と 10 個の bucket queue を永続化します。
4. Runner が job を取得し、認証済み GitHub API で default branch と commit SHA を解決します。
5. Runner が上限付きのテキスト snapshot を作り、read-only の Codex SDK thread へ渡します。
6. Codex が strict JSON schema に従って採点します。
7. Runner が job 固有の callback token で結果を返し、ランキングを更新します。

詳細は [Architecture](docs/architecture.md) を参照してください。

## Requirements

- Node.js 20.19 以上
- npm
- Cloudflare Workers と Durable Objects を利用できる Cloudflare account
- global installation の `wrangler`
- GitHub CLI `gh`
- Codex CLI で利用できる OpenAI account
- Runner を継続稼働させる macOS または Linux host

Codex SDK は server-side の Node.js で動作します。Runner host で `codex login` を実行すると、ChatGPT sign-in または API key sign-in の認証を Codex SDK が利用します。公式情報は [Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) と [OpenAI authentication](https://learn.chatgpt.com/docs/auth) を参照してください。

## Setup

依存関係を導入し、検証します。

```bash
npm install
npm run typecheck
npm test
npm run build
```

Cloudflare と Runner のセットアップは [Deployment](docs/deployment.md) を参照してください。

リポジトリの clone、依存関係の導入、test、build だけでは Cloudflare への deploy や課金は発生しません。課金が始まるのは、自分の Cloudflare account へ明示的に deploy して Worker を利用した後です。

## Local development

frontend と Worker を起動します。

```bash
npm run build:client
wrangler dev
```

別 terminal で Runner を起動します。ローカルで投稿を受け付ける場合は `wrangler.jsonc` の `CALLBACKS_ENABLED`、`RUNNER_ENABLED`、`SUBMISSIONS_OPEN` を `true` にします。

```bash
RUNNER_BASE_URL=http://127.0.0.1:8787 \
RUNNER_TOKEN_FILE=/absolute/path/to/runner-token \
RUNNER_SPOOL_DIR=/absolute/path/to/spool \
npm run runner:start
```

## Configuration

Worker の設定は `wrangler.jsonc` に置きます。

| 名前 | 種類 | 説明 |
| --- | --- | --- |
| `CALLBACKS_ENABLED` | Worker variable | `true` のときだけ認証済み scoring callback を許可。未設定時は停止 |
| `MAX_ACCEPTED_SUBMISSIONS` | Worker variable | 1 event で受け付ける submission の総数。未設定時は `500` |
| `RUNNER_TOKEN` | Worker secret | internal Runner endpoint の bearer token |
| `RUNNER_ENABLED` | Worker variable | `true` のときだけ claim、heartbeat、recover を許可。未設定時は停止 |
| `PUBLIC_BASE_URL` | Worker variable | callback URL の public origin。未設定時は request origin |
| `SUBMISSIONS_OPEN` | Worker variable | `true` のときだけ新規投稿を許可。未設定時は停止 |
| `UNRANKED_OWNERS` | Worker variable | ランキング末尾へ送る GitHub owner のカンマ区切り一覧 |

Runner の環境変数です。

| 名前 | 既定値 | 説明 |
| --- | --- | --- |
| `RUNNER_BASE_URL` | なし。必須 | Worker の origin。未設定時は Runner を起動しない |
| `RUNNER_TOKEN_FILE` | macOS Application Support 配下 | `RUNNER_TOKEN` と同じ値を入れた file |
| `RUNNER_SPOOL_DIR` | macOS Application Support 配下 | callback 完了前の結果を保護する directory |
| `RUNNER_CONCURRENCY` | `10` | 並列数。1〜10 |
| `RUNNER_POLL_INTERVAL_MS` | `2000` | queue polling の初期間隔。待機中は最大 30000 ms まで自動的に延長 |
| `CODEX_MODEL` | `gpt-5.4` | Runner が使用する Codex model |
| `GITHUB_TOKEN` | `gh auth token` の結果 | GitHub API token。未設定時は Runner が `gh` から取得 |

## Submission control

`SUBMISSIONS_OPEN` は新規投稿だけを制御します。Runner と Durable Object への定期アクセスも止める場合は、`RUNNER_ENABLED` も `false` にします。

受付を停止する場合:

```json
"SUBMISSIONS_OPEN": "false"
```

受付を再開する場合:

```json
"SUBMISSIONS_OPEN": "true"
```

変更後に `npm run build` と `wrangler deploy` を実行してください。API は停止中の新規投稿へ `403` を返します。

完全停止する場合:

```json
"CALLBACKS_ENABLED": "false",
"RUNNER_ENABLED": "false",
"SUBMISSIONS_OPEN": "false"
```

`RUNNER_ENABLED` が `false` のとき、claim、heartbeat、recover は Durable Object へ到達する前に拒否されます。処理中の結果を完了させながら停止する場合だけ `CALLBACKS_ENABLED` を一時的に `true` のまま残します。緊急停止では両方を `false` にします。

## API

| Method | Path | 用途 |
| --- | --- | --- |
| `POST` | `/api/submissions` | submission の作成 |
| `GET` | `/api/submission-status` | 受付状態 |
| `GET` | `/api/submissions/:id` | submission の状態と結果 |
| `GET` | `/api/results/:id` | submission の状態と結果 |
| `GET` | `/api/recent` | 最新 50 件 |
| `GET` | `/api/ranking` | リポジトリごとの最新 completed 結果 |
| `GET` | `/api/runner-status` | Runner の heartbeat 状態 |

`/internal/*` は Runner 用です。public client から使用しないでください。

## Security model

- 対象リポジトリは untrusted data として扱います。
- GitHub REST API と raw content API だけを使い、対象コードを実行しません。
- 最大 24 files、合計 120 KB、1 file 12 KB に証拠を制限します。
- Codex thread は read-only sandbox、network disabled、web search disabled で実行します。
- Codex subprocess へは `HOME` と `PATH` だけを明示的に渡し、GitHub token を渡しません。
- callback は submission ごとの random token で認証します。
- callback endpoint 自体も Runner の bearer token で認証し、body size、schema、score の整合性を Durable Object の手前で検証します。
- public result から callback token と IP hash を除外します。
- Runner token と Codex credentials は Cloudflare source や Git history に保存しません。
- submission と結果は public data です。秘密情報を含むリポジトリを投稿しないでください。

これは一日規模のイベント用に作られた最小構成です。multi-tenant SaaS として利用する場合は、認証、rate limiting、moderation、retention policy、監査、Runner 分離を追加してください。

脆弱性の報告方法は [Security Policy](SECURITY.md) を参照してください。

## Operations

- Runner heartbeat が 30 秒途切れると Worker は新規投稿を拒否します。
- Runner が無効なときは新規投稿と Runner の定期処理を Durable Object の手前で拒否します。
- 状態保存は変更された job と metadata だけを書き込み、待機中や拒否された処理では書き込みません。
- 1 イベントで受け付ける submission の総数を設定値で制限し、保存 job が無制限に増えないようにします。
- Runner 起動時に中断された processing job を queue へ戻します。
- callback 未完了の結果は spool directory に `0600` で保存し、再起動後に再送します。
- missing、private、default branch なし、空のリポジトリは 4 観点すべて 0 点です。
- GitHub または Codex の採点失敗は terminal failure とし、自動再採点しません。
- 同じリポジトリは前回の処理完了後に再投稿できます。

## Contributing

[Contributing Guide](CONTRIBUTING.md) を参照してください。

## License

[MIT License](LICENSE) で公開しています。
