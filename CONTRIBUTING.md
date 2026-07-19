# Contributing

Issue や pull request を歓迎します。

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

変更は小さな単位に分け、関連する test を追加してください。source code と configuration file には説明 comment を追加せず、名前と構造で意図を表現してください。

## Pull requests

- 変更の目的と利用者への影響を説明する
- security boundary を変更する場合は trust model への影響を書く
- UI 変更では desktop と mobile の表示を確認する
- `typecheck`、`test`、`build` の結果を書く
- secret、credential、private repository の内容を commit しない

## Scoring changes

採点基準、prompt、evidence selection、score schema の変更は既存ランキングとの比較可能性に影響します。変更理由と移行方針を pull request に明記してください。

## Reporting security issues

security issue は public Issue へ投稿せず、[Security Policy](SECURITY.md) に従ってください。
