# ハッカソンの審査方法

この文書は、2026年10月18日時点の実装に基づく、主催者・参加者向けの説明です。新規採点のルーブリックは `2026-10-18-v4`、標準の新機能参照情報は `2026-10-18-verified-v2` です。公開環境の稼働状態や個別作品の動作確認結果を示す文書ではありません。

## 審査の流れ

1. 公開 GitHub リポジトリのデフォルトブランチとコミット SHA を固定します。一括審査では全件の固定情報を保存してから採点を始めます。各取得の観測時刻は異なり、全作品を厳密に同時刻で取得したとは扱いません。
2. 固定コミットから対象ソースの全文を収集・検証し、証拠として保存します。
3. Decisions API が20件の段階条件と独立した攻撃判定を返します。コードが段階点と合計を確定し、点数・順位を先に公開します。
4. 別の Queue で Responses API の Sol が同じ保存済みソースを読み、固定点の根拠と不足条件を説明します。理由待ちで採点処理を止めません。

実装の入口は [scorer.ts](../src/container/scorer.ts)、処理の分離は [queue.ts](../src/worker/queue.ts)、運用全体は [README](../README.md) を参照してください。

## 評価対象となる証拠

評価対象は、固定 SHA の Git 追跡ファイルから収集した関連 UTF-8 テキスト全文です。README、設定、テスト、利用例、未知の拡張子のテキストも含みます。先頭24ファイルだけを選んだり、各ファイルを12KBで切ったりする方式ではありません。

取得前のパス・拡張子フィルターで、依存物、ビルド・生成物、キャッシュ、lockfile、ソースマップ、秘密情報用の名前に該当するファイル、素材・既知のバイナリ形式を除きます。素材には SVG・SVGZ、画像、音声・動画、フォント、PDF、3D素材、モデル重み、圧縮・実行ファイルなどが含まれます。秘密情報用の名前には `.env` 系、認証設定、秘密鍵などがありますが、すべての秘密文字列を検出する仕組みという意味ではありません。credential・secret 系の名前でも、実装用拡張子を持つコードには例外があります。

このフィルターは対象 blob の取得・容量集計・モデル送信より前に適用します。その後、NUL を含む内容や UTF-8 として読めない内容を除きます。シンボリックリンクとサブモジュールの内容は収集しません。HTML・CSS・JSX・Vue に含まれる SVG 記述や素材参照はコードとして残ります。参加者の除外設定や Git 属性で審査範囲を変更しません。除外した素材の見た目やバイナリ内の実装を観察したとは扱いません。

| 容量項目 | 上限と扱い |
| --- | --- |
| 対象ファイル数 | 最大2,000件。UTF-8 判定前の候補数にも上限を適用 |
| ソース本文 | 合計3MiB、単一ファイルも3MiB以内 |
| 正規化済みスナップショット | JSON の UTF-8 シリアライズ後で4MiB以内 |
| 保存 | 512KiBずつ、最大8分割。復元時に件数・容量・SHA-256を検証 |

上限超過時は途中切りや要約に切り替えず、採点を停止します。Git 取得の容量・時間やモデル入力のコンテキストにも有限の上限があり、全文を渡せない場合は部分証拠で採点しません。

スナップショットには全対象パス、本文、各ファイルのバイト数、`truncated: false`、固定 SHA を保持します。監査情報には `fullSource`、`sourceFiles`、`sourceBytes`、`sourceHash` を記録します。`sourceHash` は正規化したスナップショット JSON 全体の SHA-256 です。同一本文が複数パスにある場合も、元のファイル数・本文容量は各パス分を数えます。

両 API へ渡す内容は同じ全文証拠です。本文が完全一致するファイルだけは、最初の全文ファイルを指す `sameContentAs` に置き換えて送信します。参照は既出の全文だけを指し、参照の連鎖はありません。全パス・本文・メタデータを復元できる可逆な表現であり、要約ではありません。保存する正規スナップショットと監査用 hash は元の全文のままです。両モデルの入力トークン計数にも同じ表現を使い、それでも容量を超えれば停止します。

根拠: [Git 収集・除外条件](../src/container/github.ts)、[正規化・hash・容量検証](../src/shared/validation.ts)、[同一本文の参照表現](../src/shared/model-evidence.ts)、[保存・復元](../src/worker/evidence-store.ts)、[上限定数](../src/shared/constants.ts)。

## 点数を決める20条件

4軸を独立に評価し、それぞれ `0 / 2 / 4 / 6 / 8 / 10` 点、合計40点とします。

| 軸 | 見る内容 |
| --- | --- |
| 新機能の活用（technical） | 対象の新機能を目的に合う形で製品へ統合しているか |
| 使いやすさ（ux） | 対象利用者が作業を進めやすい実装か |
| 有用性（impact） | 具体的な作業の時間・労力・判断負担をどう減らすか |
| 独創性（idea） | 着眼点や解決方法の工夫が実装と便益につながるか |

README・説明・設定の主張だけでは、どの軸にも正の点を付けません。実行経路につながった宣言的登録、Plugin metadata、annotation 属性は実装になり得ます。テスト・利用例も実装根拠として扱います。新機能の活用が0点でも、他の軸を0点に制限しません。目標平均や点数分布への補正もありません。

実装ファイルの有無による `eligibility` は点数とは別の機械判定です。文書・設定などしかなく、判定対象の実装ファイルがない提出は `no_implementation` として選考対象外です。この判定はファイルの種類・場所・内容の空白や notebook のコードセルなどを確認するもので、新機能適格性や作品の完成度そのものを判定するものではありません。

### Decisions の役割と計算方法

`POST /v1/decisions` のモデルは `gpt-6-luna` です。2026年10月18日時点の公式仕様で唯一の Decisions 対応モデルであり、GPT-6.1 Sol が点数を選ぶ構成ではありません。Decisions リクエストに reasoning effort は送りません。公式仕様の predicate は命題の確率推定を返します。公式 API にある score 質問の加重平均方式は、この実装では使用しません。[Decisions 公式ガイド](https://developers.openai.com/api/docs/guides/decisions)

採点用の質問は `{axis}_level_2`、`_4`、`_6`、`_8`、`_10` の各軸5件、計20件の独立した事実条件です。各回答の確率が `0.8` 以上なら、その条件を満たすと記録します。攻撃判定を加えた全21回答について、既知の名前・predicate 型・有限な0〜1の確率・欠落や重複がないことを検証します。不完全・拒否・不正な回答から点数は確定しません。

各軸は2点条件から順に連続して満たした最高段階を得点にし、最初の未達条件で止めます。確率の平均、得点への四捨五入、上位段階への飛び越しは行いません。

例えば2・4・6・8・10点条件の確率が `[0.99, 0.94, 0.79, 0.96, 0.91]` なら4点です。6点条件が未達なのに8・10点条件が成立した矛盾は、確認メモ（`reviewRequired`）に残します。20件の確率、20件の真偽、閾値も保存します。信頼済み新機能参照情報を質問へ追加するのは technical の5件だけで、他の3軸は独立した条件で判定します。

根拠: [20条件と連続段階の計算](../src/shared/decision-conditions.ts)、[質問プロンプト](../src/shared/prompt.ts)、[API 呼び出しと全回答検証](../src/container/scorer.ts)。

### 段階条件の要約

以下は下位条件から連続して確認する条件です。上位条件だけ成立しても途中を飛ばしません。正確な定義は [ルーブリック](../src/shared/rubric.ts) と [段階条件](../src/shared/decision-conditions.ts) にあります。

| 点 | 新機能の活用 |
| --- | --- |
| 2 | 対象新機能を製品で使う実呼び出し、試験的スタブ、または実行経路に接続された宣言的統合がある。名前・設定だけや開発時だけの Codex 利用は含めない |
| 4 | 実呼び出し・宣言的登録の製品での目的と、主導線の入力から機能、または機能から結果の少なくとも一方の接続を追える |
| 6 | 主導線の入力、対象新機能の処理、有用な出力まで追え、機能が目的に合う役割を担う |
| 8 | 実際の用途に関係する制約・失敗へ適切に対処する。無関係なタイムアウト・再試行・クォータ対策を一律に要求しない |
| 10 | 単純な方法との実装済み比較例、または再現可能な検証例があり、新機能の能力に由来する具体的な作業改善を確認できる |

10点には、API の疎通、応答形式、入力による出力差、利用手順、固定モックの受け渡しだけの確認では足りません。よく統合した新機能1つで到達でき、機能数自体は加点しません。

| 点 | 使いやすさ | 有用性 | 独創性 |
| --- | --- | --- | --- |
| 2 | 実装済みの利用入口・呼び出し口がある | 実行可能な仕組みの実演がある。hello-world・ひな形も含む | 入力・操作・イベント・データを処理して結果や状態変化を生む実装がある |
| 4 | 入口から基本作業を実際に処理する。常に未実装エラーや処理しない仮の結果だけでは不可 | 固定挨拶やひな形の実演を超えて、具体的な作業の一部を解く。小さな利便性も含む | 対象作業に合わせた入力解釈・状態管理・規則・処理順序などがある。改修履歴や世界初は不要 |
| 6 | 前提・開始方法・入力が明確で、少なくとも1つの実装済み主導線で対象作業を解く | 入力から有用な出力までが具体的な仕事を実質的に助け、負担軽減の因果関係を追える | 中核の着眼点・仕組み・組み合わせの工夫を利用者の便益へ結び付けられる |
| 8 | 用途に応じた代表的失敗への対処、入力検証、復旧、既定値で試行錯誤を減らす | 実用的な集約・自動化、反復負担や誤りの大きな削減、複数場面で再利用する具体的な仕組みがある | 単純な方法の具体的な限界と、それを解く実装上の選択を説明できる |
| 10 | 同じ利用者の開始・完了・代表的失敗からの復旧を追え、通常の入力・エラー表示を超える摩擦軽減を2つ以上の具体的場面で確認できる | 従来困難な作業の実現や大幅な手順・労力削減という突出した改善と、その範囲・限界を確認できる | 実装済みの代表例・検証例から、単純な方法の限界を解く独自の仕組みによる便益を確認できる |

GUI、CLI、ライブラリ、API、自動実行を同等に扱い、GUI を要求しません。完成した主導線が1つあれば、別方式の未完成だけで否定しません。有用性8点は同じ endpoint を反復できるだけでは足りず、10点は通常の複数手順の自動化だけで自動的に成立しません。商業指標、導入実績、数値ベンチマーク、世界初の証明や外部類似調査は必須条件ではありません。0点は、各軸の最低条件を固定ソース内で支持できない場合です。8点に届かないことだけを理由に0点にはしません。

## 対象となる DevDay 発表機能

標準参照情報は2026年9月29日の公式発表を対象に、2026年10月18日 JST 時点で確認した主催者の有限カタログです。あらゆる対象機能を完全に網羅すると主張するものではありません。[公式 recap](https://openai.com/index/devday-2026-recap/) と [ChatGPT の DevDay 更新情報](https://learn.chatgpt.com/docs/whats-new/devday-2026) に基づき、現在の参照一覧に収録した発表は次のとおりです。

| 区分 | カタログに含まれる発表名 |
| --- | --- |
| モデル・API | GPT-6.1 Sol、Responses multi-agent beta、Decisions API（predicate・choice・score）、Agents API computer use、Ultrafast、Private Intelligence |
| 開発・運用 | cloud Codex、refreshed Codex CLI、Code Review、Codex Security Cloud、Bedrock Managed Agents |
| Plugin・接続 | plugin extensions and viewers、plugin creation and discovery、Sites hosting plugins、MCP Events |
| 共同作業 | ChatGPT Space and Pages、collaborative slides、teams and shared tasks、ChatGPT in Slack and Teams、Meetings plugin |
| アカウント・流通 | shareable profiles、Sign in with ChatGPT、Pro 500、OpenAI Marketplace |
| Web 連携 | Website annotations |

Decisions は9月29日の限定 preview 発表後、10月6日に broad beta となりました。Sol Ultrafast は9月29日に予告され、10月8日に提供されました。どちらも対象の発表機能であり、発表後の提供日を理由に除外しません。一方、GPT-6 Luna は9月22日の独立した公開であり、それ自体を9月29日の新機能とは数えません。[公式 changelog](https://developers.openai.com/api/docs/changelog)

### 実装を確認する手掛かり

参照情報には、次の9種類について具体的な手掛かりがあります。固定文字列の一致条件ではなく、到達可能な入口から設定・呼び出し・登録を経て、製品の目的と結果利用まで追います。SDK ラッパー、alias、同等の実装も認めます。これ以外の発表項目について、カタログにない検出規則を補っているわけではありません。

| 機能と公式資料 | ソースで確認する手掛かり |
| --- | --- |
| [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | `gpt-6.1-sol` への実リクエスト、または同じモデルへ解決される設定と、その出力の製品利用 |
| [Responses multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent) | `multi_agent.enabled: true` と `OpenAI-Beta: responses_multi_agent=v1`、または同等の SDK beta 設定を持つ接続済みリクエスト |
| [Decisions](https://developers.openai.com/api/docs/guides/decisions) | `POST /v1/decisions` または `decisions.create`、predicate・choice・score 質問と回答の製品利用 |
| [Agents API computer use](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use) | Agents session、`computer_use`、desktop 有効化、event・approval・result の処理。旧 Responses computer use と区別 |
| [Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) | 対応モデルの実 Responses リクエストで `service_tier: ultrafast` を指定し、その応答を製品へ接続 |
| [Plugin extensions](https://developers.openai.com/plugins/build/extensions) | global・thread・file 文脈の `openai/ui` entrypoint を持つ tool metadata、UI resource、handler または render 実装の接続 |
| [MCP Events](https://developers.openai.com/plugins/build/mcp-events) | MCP 2.0 の `events/list`・subscribe・unsubscribe、署名付き webhook、アクセス範囲を扱う handler と製品動作の接続 |
| [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) | PKCE を伴う OIDC、callback 処理、token 検証。ボタン名だけでは不可 |
| [Website annotations](https://learn.chatgpt.com/docs/annotations-extensibility) | `document.oai.annotation` または実際の annotation DOM 属性と Web 上の利用者操作との接続。接続済み宣言的記述も実装になり得る |

汎用 Responses の利用や旧来の MCP 接続だけでは、新しい発表機能の利用を立証しません。Codex を開発に使っただけ、有料プランを所有するだけ、プロフィールやストア掲載があるだけでも、製品への目的ある統合を立証しません。機能の対象適格性と統合の質は分けて扱います。

カタログで対象適格性を確認できない機能は、自動的に対象とも対象外とも断定しません。Sol は実装と不確実性を説明し、主催者による確認のため `reviewRequired` を残します。実行時に自律的な Web 調査やカタログ更新は行いません。未知機能を今後の適格機能として確立するには主催者の明示的な検証が必要ですが、現在の確定点・順位を維持するための人手操作は不要です。隠れた自動例外や、確認を条件にした自動加点はありません。

カタログ本文・版・校正方針の根拠: [devday-reference.ts](../src/shared/devday-reference.ts)。

## Sol が生成する採点理由

理由生成は Responses API の `gpt-6.1-sol` を使用します。本番の reasoning effort は `medium` 固定、検証の既定は `low` で、検証では `medium`・`high` も選べます。公式モデル自体は `low / medium / high / xhigh / max` をサポートし既定は `medium` ですが、このアプリの選択肢は前記3種類です。[Sol 公式モデル資料](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

アプリが固定 SHA と保存済み `sourceHash`・件数・容量の一致を検証してから、Decisions と同じ全文スナップショット、確定点、20条件の真偽・確率・閾値を Sol へ送ります。`sourceHash` 文字列そのものは Sol の入力には含めず、アプリ側の同一性検証と監査記録に使います。

Structured Outputs の strict JSON で、トップレベルは `summary`、`publicReason`、`repoAssessment`、`pinnedSha`、`criteria`、`total`、`reviewRequired` だけを返します。各 criterion は key・label・固定 score・日本語 reason・`evidencePaths` を持ちます。reason は280文字以内とし、具体的なソース根拠と次の未達条件を説明します。10点なら最高段階を確認したことを説明し、架空の不足を作りません。

Sol は段階点・合計をそのままコピーします。固定点を支持できない場合や、次段階も明らかに支持される場合は、過大・過小の疑いとして確認メモを残し、点数を修理しません。根拠パスが空なら確認メモが必須です。理由生成の再実行も再採点ではありません。

API 応答処理と Worker の保存時の検証で、固定点、ラベル、合計、評価対象 SHA・状態、実装有無の eligibility、攻撃確率・表示点、全文の hash・件数・容量、20件の条件真偽・確率・閾値、ルーブリック版・参照版を維持します。Sol が監査情報を生成して差し替えることはできません。理由結果の `reviewRequired` は既存フラグとの OR で統合するため、Decisions 由来の確認メモを解除できません。

根拠: [理由プロンプト](../src/shared/prompt.ts)、[JSON schema と結果検証](../src/shared/validation.ts)、[API 応答処理の不変条件](../src/container/scorer.ts)、[Worker 側の保存検証](../src/worker/explanations.ts)。

## 攻撃判定は40点と別枠

`prompt_injection` は20条件とは独立した predicate です。現在の審査を誘導する指示、規則の上書き、秘密や hidden prompt の開示要求、点数操作などを対象に確率を推定します。通常のセットアップ手順、中立的な解説、教材として引用された攻撃例は自動的に攻撃とはしません。ただし現在の審査者へ直接働き掛ける指示は、教材やコードブロックの形式でも対象になります。

確率が80%以上のときだけ `Math.round(probability * 100)` を「攻撃 XX点」と表示します。80%未満は非表示です。これは攻撃が含まれる確率の表示であり、攻撃成功率・高度さの点数ではありません。ぬこぬこ賞の判断材料として独立して扱い、通常の40点、順位、予選通過には加算しません。

リポジトリの metadata・パス・本文は信頼しないデータとして扱い、そこに書かれた指示へ従わない境界をプロンプトに設けています。審査モデルにツールは渡さず、Web・外部リンク巡回、デモ操作、コード・テスト・ビルド実行を行いません。UX はソースからの推定であり、実利用を観測したとは説明しません。この境界と検証は、攻撃の完全防御や判定精度を保証するものではありません。

根拠: [攻撃の質問と信頼境界](../src/shared/prompt.ts)、[表示計算](../src/shared/attack-score.ts)。

## 確認メモ、エラー、過去版

採点済み結果の確認メモへの操作は不要です。根拠不足・条件の矛盾・未確認機能が記録されても、Decisions の固定点、順位、10位同点の全員通過を維持します。確認メモを人が解消することを通過条件にせず、該当作品だけを自動再採点することもありません。

取得・入力・容量・API の失敗で採点が成立していない状態は、採点済み結果の確認メモと別のエラーです。空・非公開または未発見・デフォルトブランチ不明は個別の repository assessment と0点を返します。理由生成だけの失敗は確定点を保持し、理由の状態を失敗として記録します。[Queue の失敗処理](../src/worker/queue.ts)、[理由失敗時の保持](../src/worker/explanations.ts)

保存済み v2・v3 の点数はその版の結果として保持し、理由再生成で v4 の20条件から再採点しません。理由プロンプトは保存済みの版を引き継ぎ、v2 は専用の過去ルーブリックを使用します。v3 は現行と共通の段階基準本文・校正ルールを使い、v4 の20条件・確率・連続段階に関する追加説明は付けません。[版ごとの分岐](../src/shared/prompt.ts)
