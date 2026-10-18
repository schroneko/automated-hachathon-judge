# Automated Hackathon Judge

2026年10月18日の DevDay Community Hackathon Tokyo 向け予選審査ツールです。公開 GitHub リポジトリのソースを評価し、約30チームから決勝候補10チームを選びます。

公開先: [hackathon.nukoevi.app](https://hackathon.nukoevi.app/)

## Judging

| 観点 | 評価内容 |
| --- | --- |
| 新機能の活用 | DevDay 2026で発表された機能を、目的に合った形で活用しているか？ |
| 使いやすさ | 他の人にとって使いやすいものになっているか？ |
| 有用性 | 他の人にとって今後どれだけ役に立つ可能性があるか？ |
| 独創性 | 着眼点や解決方法にオリジナリティがあるか？ |

各観点は `0 / 2 / 4 / 6 / 8 / 10` の6段階、合計40点です。[ルーブリック](src/shared/rubric.ts) の版は `2026-10-18-v1` です。各観点に具体的な条件を定め、証拠で全条件を満たす最高段階を採用します。8点は6点の全条件、10点は8点の全条件を満たす必要があります。根拠と次の段階に不足する条件を理由に記載し、10点では最高段階を満たした根拠を示します。

Decisions API の補助評価と攻撃判定に `gpt-6-luna`、最終採点と理由の生成に Responses API の `gpt-6.1-sol` を使います。同じルーブリックを画面、Decisions API、最終採点プロンプトで共有します。本番のreasoning effortは `high`、検証の既定値は `low` です。検証結果は `high` で再検証できます。各試行の開始前に指定モデルの利用権限を確認し、別モデルへ切り替えません。

新機能は公式発表を確認した [信頼済み参照情報](src/shared/devday-reference.ts) と実装の証拠に基づいて判定します。Codexで開発したことやREADMEの自己申告だけでは加点しません。操作性はソースから読み取れる範囲の評価です。

攻撃確率が80%以上の場合だけ、5つ目の軸「攻撃 XX点」を表示します。これは攻撃を含む確率の百分率で、攻撃の成功率や高度さではありません。通常の40点や順位へ加算しません。教材の引用やゲーム内の台詞と、現在の審査を操作する指示を区別します。

## Interface

- 本番・検証を分離し、検証結果は順位と本番予算から除外
- チーム名とGitHub URLの入力、最大30行の一括登録、重複防止
- 進捗、上位10チームの境界、10位同点の主催者確認
- 4観点の段階別基準、採点根拠と不足条件、採点に使ったcommitへのファイルリンク
- 検索、CSV・JSON出力、スマートフォン表示
- 主催者トークンが必要な登録と、認証不要の結果閲覧

登録後はクラウドのQueueが採点を実行します。会場のMacBook Airではブラウザだけを使います。Mac Studio、ローカルサーバー、ローカル保存に依存せず、ブラウザを閉じても開始済みの審査と残りのキュー処理は継続します。

## Architecture and limits

Cloudflare Workers が画面・API・採点consumerを提供します。既存の共有D1 `wordplay-arcade-budget` の `devday_judge_` 専用テーブルに審査状態・結果・費用台帳を保存し、Queue `devday-judge-20261018` が審査IDを配信します。新しいD1の作成枠は不要です。

OpenAI APIキーは既存の1Password Environmentから取得した指定変数をWorker secretとして扱い、ブラウザへ渡しません。Cloudflareの管理と公開はWranglerのOAuth認証を使います。

現在のリクエスト経路にDurable Objectsのbindingはありません。旧namespaceのデータを保持するため、過去のmigration履歴と呼び出しを拒否する旧classのexportだけを残します。

| 制限 | 値 |
| --- | --- |
| 本番・検証登録数 | 本番40、検証20 |
| 同時採点 | 最大4件 |
| Queue | batch 1、自動再試行0 |
| 試行・Queue送信 | 1件につき最大3回、イベント全体で最大180回 |
| ソース証拠 | 最大24ファイル、各12KB、合計120KB |
| API費用 | 本番$90、検証$20 |

公開Gitのrefs広告からdefault branchとcommit SHAを固定し、SHAに対応するtreeをRESTで1回取得してからraw contentを読みます。GitHub tokenは使いません。対象コードの実行や、リポジトリ内リンクの巡回は行いません。

API実行前に最大入力・出力から費用を予約し、実測usageで精算します。再試行時も過去の精算と未精算予約を保持します。費用が不明な予約を解放して再開しません。採点の自動再試行はなく、同じ区分の同じリポジトリの再登録は既存の結果を返します。

更新するのは対象行だけです。結果取得、重複登録、処理済みQueueメッセージの重複配信は書き込み0件です。常駐ポーリング、定期heartbeat、Cronはありません。アカウント全体の$200上限とは別に、このイベントのAPI費用を制御します。

## Development

開発時だけNode.js 22.13以上、npm、mise管理のWranglerを使います。会場での操作にCLIは不要です。

```bash
npm ci
npm run typecheck
npm test
npm run build
wrangler d1 migrations apply JUDGE_DB --local
wrangler dev --ip 127.0.0.1 --port 8787 --var RUNNER_TOKEN:local-preview --var SUBMISSIONS_OPEN:false --var JUDGING_ENABLED:false
```

`local-preview` はローカル検証用で、公開環境に使用しません。この例は受付と採点を停止した画面確認用です。

## Event operation

主催者メニューに既存の `RUNNER_TOKEN` を入力し、チーム名と公開GitHub URLを登録します。本番はhigh、検証はlowで採点し、検証結果のhigh再検証も同じ画面から操作します。トークンの主催者への受け渡しは未完了です。

採点キーは `OPENAI_API_KEY_20261018_HACKATHON` です。既存1Password EnvironmentからWorker secretへ安全に注入する手順は検証中です。設定値をリポジトリ、URL、画面へ記載しません。受付と採点の停止は `SUBMISSIONS_OPEN: false` と `JUDGING_ENABLED: false` で反映します。

初回試験は [influ-quest](https://github.com/schroneko/influ-quest)、攻撃試験は [judge-injection-playground](https://github.com/schroneko/judge-injection-playground) を使い、検証区分へ登録します。

イベント後は受付と採点を停止してCSV・JSONを書き出します。データの保存期間はイベント後90日を目安とし、削除する対象と影響は別途確認します。

詳細: [構成](docs/architecture.md)、[公開と運用](docs/deployment.md)、[クラウド実行の上限と停止](docs/cloud-execution.md)、[クラウド実 API 検証記録](docs/validation-cloud-20261018.json)、[Security Policy](SECURITY.md)。

## License

MIT License
