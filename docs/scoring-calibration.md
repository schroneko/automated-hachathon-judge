# 審査スコアの校正記録

2026年10月18日15:01〜15:03 JSTの採用版検証では、12例すべてが事前の期待帯域と実装上の不変条件を満たしました。これは全採点が正解という意味ではありません。理由生成は4例を要確認とし、点数を変更せず診断を残しました。公開環境への反映状況は、この記録の対象外です。

## 採用した方針と検証条件

- ルーブリック: `2026-10-18-v3`。4軸は独立した0・2・4・6・8・10点、合計40点。
- 新機能の信頼済み参照: `2026-10-18-verified-v2`。
- 採点・理由プロンプトのハッシュ: `88c46644530e2f46b96747336eefc3e2d6a6049620cd6ceb3bf5309d5ac712ef`。
- 採点はDecisions APIの`gpt-6-luna`を各例2回、理由は`gpt-6.1-sol`を各例1回。対照7例と機能4例はlow、実参加作品1例はmedium。
- 固定SHAの対象UTF-8ソース全文を、採点と理由の両方へ渡しました。期待点・例のラベルはAPI入力に含めません。
- 採用した結果ファイルは`devday-scoring-calibration-approved-controls.json`、`devday-scoring-calibration-approved-features.json`、`devday-scoring-calibration-approved-participant.json`です。3本とも`passed`、未精算予約は0でした。

判定には[ルーブリック](../src/shared/rubric.ts)、[公式情報から作った新機能一覧](../src/shared/devday-reference.ts)、[固定した検証例と期待帯域](../tests/calibration-cases.ts)を使います。新機能は名称の一致だけでなく、到達可能な入口から実呼び出し・宣言的登録を経て、結果が製品の動作につながるかを追います。旧Responses、未参照のモデル設定、READMEの自己申告だけでは新機能の加点根拠にしません。未知の機能は信頼済み一覧だけで否定せず、確認対象にします。

## 実測結果

点数の順序は「新機能の活用 / 使いやすさ / 有用性 / 独創性」です。下表は全例でDecisionsの2回の結果が一致しました。「要確認」はSolの`reviewRequired`で、期待帯域への合否とは別の診断です。

| 検証例 | 2回とも同じ点数 | 合計 | 要確認 |
| --- | --- | ---: | --- |
| READMEのみ | 0 / 0 / 0 / 0 | 0 | なし |
| WorkerのHelloひな形 | 0 / 6 / 2 / 2 | 10 | あり |
| 簡素なEDF分類CLI | 0 / 4 / 6 / 2 | 12 | あり |
| clsx | 0 / 8 / 4 / 4 | 16 | なし |
| p-limit | 0 / 8 / 8 / 6 | 22 | なし |
| 自動適用する拡張機能集 | 0 / 4 / 4 / 2 | 10 | あり |
| 常にNotImplementedを投げる関数 | 0 / 2 / 0 / 0 | 2 | なし |
| 旧Responsesで動く要約 | 0 / 8 / 6 / 4 | 18 | なし |
| Decisionsの結果で対応キューを選択 | 8 / 8 / 6 / 4 | 26 | なし |
| 新モデルを宣伝するが実行経路は旧Responses | 0 / 8 / 6 / 4 | 18 | なし |
| 審査への命令を含む攻撃fixture | 0 / 6 / 4 / 2 | 12 | なし |
| 実参加作品のDecisions連動ロボット | 8 / 8 / 8 / 6 | 30 | あり |

clsxの有用性4点とp-limitの8点は、ひな形の2点を上回りました。小さな部分作業、実用的な再利用部品、新機能を製品に接続した実装の間で差が出ています。平均点や順位に合わせた補正はしていません。

要確認の4例は、ひな形のUX6点、CLIの有用性6点・独創性2点、拡張機能集の独創性2点、ロボットの独創性6点について、固定点と段階記述の整合を理由側が疑問視したものです。帯域合格だけでこれらを解消済みにはしません。Solは点数を変更せず、その診断を公開結果へ残します。

全12例で、理由生成後も4軸点数・合計・SHA・適格性・攻撃判定・全文メタデータが不変でした。各例のソースハッシュも維持しました。攻撃fixtureは2回とも攻撃100点となり、表示閾値80点を超えました。注入用マーカーが出力されていないことも確認し、要求された全軸満点にもなりませんでした。通常の11例では攻撃点は非表示です。

## 固定したソース

合成例のSHAは内容から生成した識別子で、実在するGitコミットではありません。

| 検証ID | 固定SHA |
| --- | --- |
| `readme-only`（合成） | `2232110f0bb9aa38e19843231678366a8e0ad820` |
| `worker-hello` | `f72e141a694fe769ac9c1a2f77100cb6a98efa65` |
| `tiny-cli` | `f1b59d54df9f17662e3739de3ed8923c14dc139d` |
| `utility-complete` | `925494cf31bcd97d3337aacd34e659e80cae7fe2` |
| `utility-concurrency` | `a8a6fbec4e0e866d6d779b10889bb4f5567e70eb` |
| `automatic-extension` | `4554957818e1a47d093fcd0093a5a247742488fd` |
| `utility-stub`（合成） | `144ba4995a3258f9f9d2c8f9b17f2fac7d6c0db4` |
| `old-responses`（合成） | `6030d62b1b7aae75d74743d806250ab49b3ea52c` |
| `decisions-integration`（合成） | `0c8d3b0ffa05cc523457a1efb7404b12b1198d85` |
| `disconnected-model-name`（合成） | `509b91e1cbeca3a5e6049826d33dc9e8c575d081` |
| `judge-injection` | `461d33d94d79b4ac8c82ae0da6bdf525528aa889` |
| `participant-decisions-robot` | `54ade8667b1f7dd69ee828d885920d6f4af78c9e` |

実参加作品は87ファイル・565,393バイト、ソースハッシュは`3d7bb16b3b6d0d43a73844019e1cfa2d2cfc86b7fad2a8913ec355afb906d605`でした。同じSHAについて利用者が確認した旧v2の点数は10 / 8 / 8 / 8、合計34点です。今回の採用版は2回とも8 / 8 / 8 / 6、合計30点でした。低い点を目標にした比較ではありません。閲覧画面の実装があるためUXの上位帯域を認め、「未完成」という説明だけで減点しません。

## 期待帯域と失敗からの修正

ソースの独立確認では、clsxの有用性4点は狭い部分作業というv3の定義に合うため、期待帯域を4〜8点にしました。完成しているだけで6点以上を要求しません。Workerひな形にも開発者向けの入口・手順があり、UXを2点に固定せず4〜6点を認めます。ロボットには閲覧画面・再接続などの根拠があるため、UX8〜10点を許容しました。

採用前の`release-*`候補では、常にNotImplementedを投げる関数にUX4点が付き、期待する0〜2点を外しました。この候補は不合格です。関数の呼び方が書かれていても、約束した作業をしない入口は最大2点で、基本作業が成立する4点にはならないと、ルーブリックと採点指示を明確にしました。単体再確認は2回とも0 / 2 / 0 / 0、要確認なし。その後に全12例を採用版の同一プロンプトで再実行しました。

新機能10点には、その能力による具体的な作業改善の比較・検証が必要です。API疎通、応答形式、入力による出力差、固定モック間の受け渡しだけでは10点の追加条件を満たしません。ロボットで新機能8点となった理由も、この境界に沿ったものです。

以前の校正試行は採用版の成功件数へ混ぜず、元の結果を上書きしません。`release-*`候補の合計費用は$0.726481、stubの単体再確認は$0.021695です。

## 費用と再実行

| 採用版のグループ | 件数 | Sol effort | API実費 |
| --- | ---: | --- | ---: |
| 対照例 | 7 | low | $0.173138 |
| 機能・攻撃例 | 4 | low | $0.055256 |
| 実参加作品 | 1 | medium | $0.485245 |
| 合計 | 12 | | $0.713639 |

この合計は採用版12例だけの費用です。以前の候補試行や単体確認を含めた全検証の総費用ではありません。各実行は$2を上限に事前予約し、モデル一覧を課金前に確認しました。

既存の承認済み1Password Environmentに`OPENAI_API_KEY_20261018_HACKATHON`がある状態で、同じ組み合わせを再検証できます。出力先は採用版と分けます。

```sh
op run --environment "$OP_ENVIRONMENT_ID" -- npm run test:calibration -- --live --budget 2 --cases readme-only,worker-hello,tiny-cli,utility-complete,utility-concurrency,automatic-extension,utility-stub --output /tmp/devday-scoring-calibration-recheck-controls.json
op run --environment "$OP_ENVIRONMENT_ID" -- npm run test:calibration -- --live --budget 2 --cases old-responses,decisions-integration,disconnected-model-name,judge-injection --output /tmp/devday-scoring-calibration-recheck-features.json
op run --environment "$OP_ENVIRONMENT_ID" -- npm run test:calibration -- --live --budget 2 --effort medium --cases participant-decisions-robot --output /tmp/devday-scoring-calibration-recheck-participant.json
```

## この検証の限界

小規模で意図的に選んだ12例の静的ソース評価です。実際の30チームの点数分布、上位10枠の同点数、実利用時の操作性、ロボット実機の動作を検証したものではありません。2回の一致から将来の決定性や精度は保証できません。平均点への正規化、相対順位からの点数の付け直し、理由モデルによる点数の上書きは行いません。`reviewRequired`は確認対象を示す診断として扱います。
