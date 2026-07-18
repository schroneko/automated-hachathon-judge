# hackathon-nukoevi-app

GitHub リポジトリ URL だけを受け取り、Cloudflare Workers と Mac 上の Codex SDK Runner で自動ジャッジを行う小さな Web アプリです。採点は 4 観点を 0〜10 点で 1 回だけ実行し、最新の completed 結果だけをランキングに反映します。

## Architecture

- Worker が静的 frontend と `/api/*`、`/internal/*` を配信します。
- `JudgeState` Durable Object が submission 履歴、最新 completed、in-flight 重複防止、IP cooldown、4 バケットの待ち行列を保持します。
- Mac Runner は認証済みの internal endpoint から job を atomic claim し、最大 4 件を並列処理します。
- Runner は GitHub REST API と raw content API だけで pinned SHA の証拠ファイルを bounded snapshot に落として `@openai/codex-sdk` に渡します。
- ジャッジ callback は per-job random token を使います。グローバル callback secret は使いません。
- ChatGPT 認証は Mac の Codex auth だけを使い、Cloudflare には保存しません。

## Scoring flow

1. frontend から GitHub URL を `/api/submissions` に送ります。
2. Worker が URL、body size、IP cooldown、同一 repo の in-flight 重複を検証します。
3. `JudgeState` が submission を保存します。
4. Mac Runner が job を claim します。
5. Runner は raw content API で限られた証拠だけを取得し、read-only snapshot を作ります。
6. Codex SDK が strict JSON schema で 4 観点を採点します。
7. Runner が callback token 付きで Worker に結果を返し、`JudgeState` が履歴とランキングを更新します。

## Local development

前提:

- Node.js 20.19 以上
- Cloudflare 用の `wrangler` コマンド

セットアップ:

```bash
npm install
```

frontend build と TypeScript build:

```bash
npm run build
```

型検査:

```bash
npm run typecheck
```

テスト:

```bash
npm test
```

ローカル開発では frontend を先に build してから Worker を起動してください。`wrangler` はグローバルコマンドを使います。

```bash
npm run build
wrangler dev
```

## Runner

Runner は Mac にログイン済みの Codex auth を利用します。`RUNNER_TOKEN_FILE` の token は Cloudflare Worker の `RUNNER_TOKEN` secret と一致させます。

build 後に foreground で起動できます。

```bash
npm run runner:start
```

既定値は production URL、4 並列、token file `~/Library/Application Support/Hackathon Judge/runner-token` です。完了結果は callback 成功まで `~/Library/Application Support/Hackathon Judge/spool` に保存されるため、callback 障害で再採点しません。

本番 Mac では `~/Library/LaunchAgents/app.nukoevi.hackathon-runner.plist` が Runner を常駐させます。`caffeinate -i` で Runner 稼働中の system sleep を防ぎますが、画面の sleep は妨げません。heartbeat が 30 秒途切れると Worker は新規投稿を `503` で拒否します。

## Deploy

このリポジトリの `wrangler.jsonc` は custom domain `hackathon.nukoevi.app` を前提にしています。デプロイ前に以下を確認します。

- Cloudflare zone 側で `hackathon.nukoevi.app` を custom domain として使えること
- `RUNNER_TOKEN` が Worker secret として設定済みであること
- Mac Runner が起動していること

デプロイ例:

```bash
wrangler deploy
```

## Test coverage

最低限の unit tests として次を含めています。

- GitHub URL validation
- scoring schema と total validation
- latest completed のみが ranking に残ること
- empty repository と missing/private repository の zero score handling
- retryable failure が 1 回だけ再試行されること
- prompt injection boundary text
- API surface の基本挙動

## Security limitations

- ジャッジ対象 repo は untrusted data として扱い、コード実行、clone、archive 展開はしません。
- evidence は pinned SHA の snapshot に限定し、README 内リンクは追いません。
- 取得済みテキストは Codex の実行前にルールベースで検査し、ぬこスコアが 80 点以上の場合だけ結果画面へ表示します。通常の 40 点と順位には影響しません。
- abuse controls は one-day event 向けの最小構成です。body size cap、repo URL validation、same-repo in-flight rejection、per-IP cooldown を実装しています。
- Codex SDK には read-only workspace と strict schema を渡しますが、Codex CLI の内部ツール完全無効化までは保証していません。read-only workspace と prompt hardening で影響を最小化しています。

## Operational notes

- ranking は normalized repo ごとに latest completed だけを使います。
- older results は history として保持されます。
- completed 後の submission は再試行しません。
- GitHub または Codex の失敗は `ジャッジ不能` とし、自動再採点しません。
- missing/private repository、default branch なし、genuinely empty repository は 4 観点すべて 0 点です。
