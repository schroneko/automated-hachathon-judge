<!--TEXTLINT_SEGMENT_0-->

width=device-width, initial-scale=1

<!--TEXTLINT_SEGMENT_1-->

ぬこぬこさん、Cloudflare 請求書の Rows Written $666 明細から automated-hachathon-judge の JudgeState 全件再保存ポカに気づく

<!--TEXTLINT_SEGMENT_2-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書に記載された Durable Objects Storage Rows Written $666 をきっかけに、automated-hachathon-judge の JudgeState 全件再保存を見つけた技術失敗談。

<!--TEXTLINT_SEGMENT_3-->

#171715

<!--TEXTLINT_SEGMENT_4-->

dark

<!--TEXTLINT_SEGMENT_5-->

article

<!--TEXTLINT_SEGMENT_6-->

ja_JP

<!--TEXTLINT_SEGMENT_7-->

ぬこぬこさん、Cloudflare 請求書の Rows Written $666 明細から automated-hachathon-judge の JudgeState 全件再保存ポカに気づく

<!--TEXTLINT_SEGMENT_8-->

automated-hachathon-judge commit 8b494bd では、審査キューが空の間も続く claim と heartbeat が JudgeState の全 job key 再保存へ増幅されていた。全件保存を差分保存へ変更した commit c2ffc4a を公開する技術失敗談。

<!--TEXTLINT_SEGMENT_9-->

https://cloudflare-do-report.nukoevi.app/

<!--TEXTLINT_SEGMENT_10-->

summary

<!--TEXTLINT_SEGMENT_11-->

ぬこぬこさん、Cloudflare 請求書の Rows Written $666 明細から automated-hachathon-judge の JudgeState 全件再保存ポカに気づく

<!--TEXTLINT_SEGMENT_12-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書に記載された Rows Written $666 をきっかけに、JudgeState の全 job key 再保存を検証した技術失敗談。

<!--TEXTLINT_SEGMENT_13-->

本文へ移動

<!--TEXTLINT_SEGMENT_14-->

automated-hachathon-judge Durable Objects Rows Written 増幅レポート

<!--TEXTLINT_SEGMENT_15-->

公開: 2026 年 8 月 9 日

<!--TEXTLINT_SEGMENT_16-->

Cloudflare Durable Objects / Cloudflare 請求期間: 2026 年 7 月 4 日〜8 月 3 日

<!--TEXTLINT_SEGMENT_17-->

ぬこぬこさん、Cloudflare 請求書の Rows Written

<!--TEXTLINT_SEGMENT_18-->

$666

<!--TEXTLINT_SEGMENT_19-->

明細から automated-hachathon-judge の JudgeState 全件再保存ポカに気づく

<!--TEXTLINT_SEGMENT_20-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書には、Durable Objects Storage Rows Written 665,418,208 行に $666 が請求されていた。automated-hachathon-judge commit 8b494bd を調べると、Runner が JudgeState へ送る claim と heartbeat のたびに、JudgeState が meta key と保存済みの全 job key を再保存していた。本レポートは、Rows Written 増幅を発生させた commit 8b494bd のコード経路、全件保存を差分保存へ変更した commit c2ffc4a、日次書き込み上限を追加した commit e376e44 の実装を説明する。本レポートでは、commit 8b494bd を「全件保存版」、commit c2ffc4a を「差分保存版」と表記する。

<!--TEXTLINT_SEGMENT_21-->

tl;dr

<!--TEXTLINT_SEGMENT_22-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書には、Durable Objects Storage Rows Written 665,418,208 行と $666 が記載された

<!--TEXTLINT_SEGMENT_23-->

全件保存版の Runner が JudgeState へ送る claim と heartbeat は、meta key と保存済みの全 job key の再保存を発生させていた

<!--TEXTLINT_SEGMENT_24-->

差分保存版では、JudgeState の永続状態が変化しないリクエストによる Durable Object Storage への storage.put と storage.delete を 0 件とし、値が変化した job key と meta key だけを保存する

<!--TEXTLINT_SEGMENT_25-->

Cloudflare アカウント全体の従量課金額を $1 と $10 で通知し、JudgeState は成功した key 書き込みを UTC 日ごとに数えて 50,000 行を超える保存を拒否する

<!--TEXTLINT_SEGMENT_26-->

Cloudflare 請求書には Durable Object namespace 別の内訳がないため、$666 全額を hackathon-nukoevi-app の JUDGE_STATE binding が参照する JudgeState namespace の Rows Written へ帰属できない

<!--TEXTLINT_SEGMENT_27-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare Durable Objects 主要指標

<!--TEXTLINT_SEGMENT_28-->

Cloudflare 請求書に記載された課金対象 Rows Written

<!--TEXTLINT_SEGMENT_29-->

665,418,208

<!--TEXTLINT_SEGMENT_30-->

Cloudflare Durable Objects の月間無料枠 5,000 万行を加えた請求期間中の推定 Rows Written

<!--TEXTLINT_SEGMENT_31-->

約 7.15 億行

<!--TEXTLINT_SEGMENT_32-->

全件保存版の Runner 既定値から推計した claim + heartbeat の名目送信頻度

<!--TEXTLINT_SEGMENT_33-->

約 5.2 回 / 秒

<!--TEXTLINT_SEGMENT_34-->

1

<!--TEXTLINT_SEGMENT_35-->

Cloudflare 請求書に現れた 665,418,208 行

<!--TEXTLINT_SEGMENT_36-->

Cloudflare 請求期間は 2026 年 7 月 4 日〜8 月 3 日。Cloudflare 請求書には Durable Objects Storage Rows Written が 665,418,208 行、金額は $666 と記載されていました。

<!--TEXTLINT_SEGMENT_37-->

出典 1

<!--TEXTLINT_SEGMENT_38-->

[1]

<!--TEXTLINT_SEGMENT_39-->

Cloudflare Durable Object Storage の Rows Written は保存容量ではなく、storage.put または storage.delete が書き込みまたは削除を行った key 数で数えられます。1 回の storage.put で複数の key を保存した場合も、Cloudflare は key ごとに Rows Written を計上します。

<!--TEXTLINT_SEGMENT_40-->

出典 2

<!--TEXTLINT_SEGMENT_41-->

[2]

<!--TEXTLINT_SEGMENT_42-->

Cloudflare Durable Objects の月間無料枠 5,000 万行を加えると、2026 年 7 月 4 日〜8 月 3 日の Rows Written は約 7.15 億行と推定できます。ただし Cloudflare 請求書には Durable Object namespace 別の内訳がありません。Cloudflare 請求書だけでは、hackathon-nukoevi-app の JUDGE_STATE binding が参照する JudgeState namespace、influ-quest の QuestAgent namespace、influ-quest の BrowserChatSession namespace、請求対象の Cloudflare アカウントに属し、JudgeState、QuestAgent、BrowserChatSession のいずれにも該当しない Durable Object namespace の Rows Written を分離できません。

<!--TEXTLINT_SEGMENT_43-->

2

<!--TEXTLINT_SEGMENT_44-->

automated-hachathon-judge が Durable Object を採用した理由

<!--TEXTLINT_SEGMENT_45-->

Durable Object は、同一 Durable Object ID へのリクエストを 1 個の Durable Object インスタンスへ集め、リクエスト処理の直列化と状態の永続化を担います。automated-hachathon-judge は、審査キューの排他制御と、審査キュー、処理中ジョブ、審査結果の永続化に JudgeState Durable Object を採用しました。

<!--TEXTLINT_SEGMENT_46-->

automated-hachathon-judge の審査状態を JudgeState で管理する

<!--TEXTLINT_SEGMENT_47-->

JudgeState は、審査キュー、処理中ジョブ、審査結果を 1 個の Durable Object インスタンスに保存していました。Runner（審査を実行する常駐プログラム）内の複数の処理枠が JudgeState へ同時に claim を送っても、単一の審査ジョブを複数の処理枠が重複取得せず、Cloudflare Worker hackathon-nukoevi-app が再起動しても審査を続けるためです。

<!--TEXTLINT_SEGMENT_48-->

出典 3

<!--TEXTLINT_SEGMENT_49-->

[3]

<!--TEXTLINT_SEGMENT_50-->

Durable Object の採用は、審査ジョブの重複取得防止と永続化の要件に合っていました。Rows Written を増幅した原因は、JudgeState の審査キューに取得可能なジョブがない時間にも全件保存版の Runner が claim と heartbeat を送り、JudgeState が meta key と保存済みの全 job key を保存していた実装です。

<!--TEXTLINT_SEGMENT_51-->

automated-hachathon-judge と influ-quest の Durable Object 実装比較

<!--TEXTLINT_SEGMENT_52-->

influ-quest commit 9c518da は、QuestAgent と BrowserChatSession を Durable Object binding として定義しています。BrowserChatSession はチャットセッションごとに Durable Object インスタンスを分け、チャット操作を処理したときにセッション状態を保存します。influ-quest commit 9c518da には、チャット操作がない時間に全 BrowserChatSession インスタンスの storage key を定期的に再保存する処理はありませんでした。Durable Object インスタンスへ送る 1 回のリクエストが触る storage key 数によって Rows Written の増加量は変わります。

<!--TEXTLINT_SEGMENT_53-->

出典 7

<!--TEXTLINT_SEGMENT_54-->

[7]

<!--TEXTLINT_SEGMENT_55-->

出典 8

<!--TEXTLINT_SEGMENT_56-->

[8]

<!--TEXTLINT_SEGMENT_57-->

3

<!--TEXTLINT_SEGMENT_58-->

全件保存版の Runner が JudgeState へ送る claim 1 回が保存済みジョブ全体の書き込みになった

<!--TEXTLINT_SEGMENT_59-->

全件保存版では、Runner が JudgeState へ送る claim と heartbeat のたびに、JudgeState が meta key と保存済みの全 job key を保存していました。Rows Written は、Runner の claim と heartbeat の送信回数と、JudgeState に保存された job key 数の積で増加しました。

<!--TEXTLINT_SEGMENT_60-->

全件保存版の Runner 既定値では、審査キューが空でも JudgeState へ名目約 5.2 回 / 秒で送信する

<!--TEXTLINT_SEGMENT_61-->

全件保存版の Runner は、10 個の処理枠から 2 秒ごとに JudgeState へ claim を送り、5 秒ごとに JudgeState へ heartbeat を送っていました。JudgeState の審査キューに取得可能なジョブがない時間も、Runner 既定値では claim と heartbeat の送信が名目約 5.2 回 / 秒で続きました。

<!--TEXTLINT_SEGMENT_62-->

出典 4

<!--TEXTLINT_SEGMENT_63-->

[4]

<!--TEXTLINT_SEGMENT_64-->

JudgeState は審査ジョブを変更しない claim と heartbeat の後にも全 job key を保存する

<!--TEXTLINT_SEGMENT_65-->

全件保存版の JudgeState は、取得可能な審査ジョブがない claim と Runner の heartbeat を処理した後にも、meta key と保存済みの全 job key を保存していました。審査ジョブの値が変化しない場合も、再保存された job key は Rows Written に計上されました。

<!--TEXTLINT_SEGMENT_66-->

JudgeState は差分ではなく保存済みの全 job key を書き戻す

<!--TEXTLINT_SEGMENT_67-->

全件保存版の JudgeState は、claim、heartbeat、finalize の各処理後に、meta key と保存済みの全 job key を保存していました。Runner の claim または heartbeat 1 回が、保存済み job key 数分の書き込みへ増幅されます。

<!--TEXTLINT_SEGMENT_68-->

出典 5

<!--TEXTLINT_SEGMENT_69-->

[5]

<!--TEXTLINT_SEGMENT_70-->

最近の投稿 50 件の表示上限を job key の保存上限と取り違える

<!--TEXTLINT_SEGMENT_71-->

全件保存版の「最近の投稿」表示は 50 件に制限していましたが、JudgeState が保存する job key 数には上限がありませんでした。「最近の投稿」の先頭 50 件に含まれない 51 件目以降の job key が増えるほど、claim と heartbeat による Rows Written も増える構造です。

<!--TEXTLINT_SEGMENT_72-->

出典 6

<!--TEXTLINT_SEGMENT_73-->

[6]

<!--TEXTLINT_SEGMENT_74-->

全件保存版の概算 Rows Written ≈ Runner から JudgeState への claim と heartbeat の合計送信頻度 ×（固定した保存済み job key 数 + meta key 1 件）× Runner 稼働秒数

<!--TEXTLINT_SEGMENT_75-->

全件保存版の JudgeState に保存済みジョブが 50 件ある場合の感度分析

<!--TEXTLINT_SEGMENT_76-->

5.2 回 / 秒 × 51 行 / 回 × 86,400 秒 / 日 = 22,913,280 行 / 日

<!--TEXTLINT_SEGMENT_77-->

全件保存版の Runner 既定値である並列数 10、claim 間隔 2 秒、heartbeat 間隔 5 秒を固定した仮定上の計算です。22,913,280 行 / 日は書き込み増幅の大きさを示す感度分析であり、2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書に記載された $666 を再現した実測値ではありません。

<!--TEXTLINT_SEGMENT_78-->

4

<!--TEXTLINT_SEGMENT_79-->

差分保存版で JudgeState を全件保存から差分保存へ変更した

<!--TEXTLINT_SEGMENT_80-->

差分保存版は、値が変化した job key、値が変化した meta key、削除対象の job key だけを storage transaction で put または delete します。put または delete の対象がない場合は storage transaction を実行しません。比較表は全件保存版と差分保存版を比較しています。meta key は、投稿受付件数、審査キュー、最近の投稿 ID、リポジトリ単位の処理状況、Runner の最終生存時刻を保持する管理情報です。

<!--TEXTLINT_SEGMENT_81-->

出典 9

<!--TEXTLINT_SEGMENT_82-->

[9]

<!--TEXTLINT_SEGMENT_83-->

全 bucket queue が空の claim

<!--TEXTLINT_SEGMENT_84-->

全件保存版

<!--TEXTLINT_SEGMENT_85-->

meta key と保存済みの全 job key を保存

<!--TEXTLINT_SEGMENT_86-->

差分保存版

<!--TEXTLINT_SEGMENT_87-->

meta key を読み、全 bucket queue が空なら HTTP 204 を返す。JudgeState の Durable Object Storage に対する put と delete は 0 件

<!--TEXTLINT_SEGMENT_88-->

Runner の heartbeat

<!--TEXTLINT_SEGMENT_89-->

全件保存版

<!--TEXTLINT_SEGMENT_90-->

meta key と保存済みの全 job key を保存

<!--TEXTLINT_SEGMENT_91-->

差分保存版

<!--TEXTLINT_SEGMENT_92-->

runnerLastSeenAt を含む meta key 1 件だけを更新

<!--TEXTLINT_SEGMENT_93-->

審査ジョブを取得する claim

<!--TEXTLINT_SEGMENT_94-->

全件保存版

<!--TEXTLINT_SEGMENT_95-->

保存済みの全 job key を読み、meta key と保存済みの全 job key を保存

<!--TEXTLINT_SEGMENT_96-->

差分保存版

<!--TEXTLINT_SEGMENT_97-->

meta key と bucketQueues に列挙された job key を queued 状態の審査ジョブが見つかるまで読み、取得した job key と値が変化した meta key だけを保存

<!--TEXTLINT_SEGMENT_98-->

出典 10

<!--TEXTLINT_SEGMENT_99-->

[10]

<!--TEXTLINT_SEGMENT_100-->

審査結果を確定する finalize

<!--TEXTLINT_SEGMENT_101-->

全件保存版

<!--TEXTLINT_SEGMENT_102-->

保存済みの全 job key を読み、meta key と保存済みの全 job key を保存

<!--TEXTLINT_SEGMENT_103-->

差分保存版

<!--TEXTLINT_SEGMENT_104-->

meta key と submissionId に対応する job key を読み、callback token とジョブ状態の検証に成功した場合だけ、値が変化した job key と meta key を保存

<!--TEXTLINT_SEGMENT_105-->

出典 10

<!--TEXTLINT_SEGMENT_106-->

[10]

<!--TEXTLINT_SEGMENT_107-->

拒否される scoring callback

<!--TEXTLINT_SEGMENT_108-->

全件保存版

<!--TEXTLINT_SEGMENT_109-->

scoring callback の拒否後も JudgeState が meta key と保存済みの全 job key を保存

<!--TEXTLINT_SEGMENT_110-->

差分保存版

<!--TEXTLINT_SEGMENT_111-->

Cloudflare Worker hackathon-nukoevi-app は認証と入力を JudgeState へ転送する前に検証し、JudgeState は callback token とジョブ状態を保存前に検証する。拒否した scoring callback による JudgeState の Durable Object Storage への put と delete は 0 件

<!--TEXTLINT_SEGMENT_112-->

出典 11

<!--TEXTLINT_SEGMENT_113-->

[11]

<!--TEXTLINT_SEGMENT_114-->

HTTP 204 が続く間は Runner の claim 間隔を最大 30 秒へ延ばす

<!--TEXTLINT_SEGMENT_115-->

差分保存版の Runner は、/internal/runner/claim が HTTP 204 を返すたびに、次の claim までの待機時間を 2 秒、4 秒、8 秒、16 秒、最大 30 秒へ延ばします。HTTP 204 が続く時間帯の claim 送信回数は全件保存版より減少します。

<!--TEXTLINT_SEGMENT_116-->

出典 12

<!--TEXTLINT_SEGMENT_117-->

[12]

<!--TEXTLINT_SEGMENT_118-->

5

<!--TEXTLINT_SEGMENT_119-->

請求通知と日次書き込み上限を別々に設けた

<!--TEXTLINT_SEGMENT_120-->

2026 年 8 月 9 日、Cloudflare アカウント全体を監視する Budget Alert を有効にし、hackathon-nukoevi-app の JudgeState だけを止める日次書き込みガードを automated-hachathon-judge の公開リポジトリへ追加しました。

<!--TEXTLINT_SEGMENT_121-->

Cloudflare アカウント全体: 従量課金額 $1 と $10 でメール通知

<!--TEXTLINT_SEGMENT_122-->

Budget Alert は Cloudflare アカウント全体の従量課金額を日次集計し、請求期間ごとにリセットされます。Budget Alert はメールを送るだけで、Cloudflare Worker と Durable Object を停止しません。

<!--TEXTLINT_SEGMENT_123-->

出典 13

<!--TEXTLINT_SEGMENT_124-->

[13]

<!--TEXTLINT_SEGMENT_125-->

JudgeState: 25,000 行 / UTC 日で構造化 warning を記録

<!--TEXTLINT_SEGMENT_126-->

JUDGE_STATE binding が参照する global JudgeState instance は、成功した storage.put と storage.delete の key 数を UTC 日ごとに数えます。25,000 行で構造化 warning を 1 回記録し、審査処理は継続します。

<!--TEXTLINT_SEGMENT_127-->

出典 14

<!--TEXTLINT_SEGMENT_128-->

[14]

<!--TEXTLINT_SEGMENT_129-->

JudgeState: 50,000 行 / UTC 日を超える保存を拒否

<!--TEXTLINT_SEGMENT_130-->

次の保存で 50,000 行を超える場合、JudgeState は審査状態を変更せず、HTTP 507 を返します。1 行以上の余裕があれば、JudgeState は停止状態を meta key 1 件へ記録します。Runner は新しい審査ジョブの取得を止め、未送信結果をローカル spool に残します。UTC 日付が進むと、日次カウンターと停止状態はリセットされます。

<!--TEXTLINT_SEGMENT_131-->

出典 14

<!--TEXTLINT_SEGMENT_132-->

[14]

<!--TEXTLINT_SEGMENT_133-->

Cloudflare の請求値と JudgeState の日次カウンターは同じ数値ではない

<!--TEXTLINT_SEGMENT_134-->

JudgeState の日次カウンターは、influ-quest の QuestAgent namespace と BrowserChatSession namespace、他の Durable Object namespace、Cloudflare 内部処理、Requests、Duration を数えません。Cloudflare Budget Alert は Cloudflare アカウント全体を監視し、JudgeState の日次カウンターは JudgeState の異常な書き込みだけを即時に止めます。

<!--TEXTLINT_SEGMENT_135-->

全件保存版と同じ増幅が再発した場合の停止時間

<!--TEXTLINT_SEGMENT_136-->

50,000 行 ÷（5.2 回 / 秒 × 51 行 / 回）≈ 189 秒

<!--TEXTLINT_SEGMENT_137-->

保存済み job key 50 件と全件保存版の Runner 既定値を固定した感度分析であり、実測値ではありません。

<!--TEXTLINT_SEGMENT_138-->

6

<!--TEXTLINT_SEGMENT_139-->

全件保存版の Rows Written 増幅から持ち帰れる 4 つの原則

<!--TEXTLINT_SEGMENT_140-->

全件保存版で確認した Rows Written 増幅の原因と、差分保存版で実装した差分保存、claim 間隔変更、日次書き込みガードを、Durable Object と定期実行プロセスを組み合わせるアプリケーション向けの設計原則に整理します。

<!--TEXTLINT_SEGMENT_141-->

Durable Object の永続状態を変更しないリクエストは put と delete を 0 件にする

<!--TEXTLINT_SEGMENT_142-->

審査キューが空の claim、重複した scoring callback、認証または入力の検証に失敗した scoring callback は、JudgeState の Durable Object Storage に対する put と delete を実行しません。Cloudflare Worker hackathon-nukoevi-app または JudgeState が拒否した scoring callback も、JudgeState の Durable Object Storage に対する書き込み件数を 0 件にします。

<!--TEXTLINT_SEGMENT_143-->

Rows Written を保存済みレコード総数ではなく値が変化した key 数に比例させる

<!--TEXTLINT_SEGMENT_144-->

Durable Object Storage の全 key 読み取りと全 key 保存を避け、Durable Object ハンドラーが 1 回のリクエストで参照するレコード key と、1 回のリクエストで値が変化する管理情報 key だけを読み書きします。

<!--TEXTLINT_SEGMENT_145-->

Durable Object リクエスト頻度 × 1 回あたりの書き込み行数 × 稼働時間を計算する

<!--TEXTLINT_SEGMENT_146-->

Durable Object へのリクエスト 1 回あたりの Rows Written が小さくても、Durable Object へ定期リクエストを送るプロセスの並列数と稼働秒数を掛けると Rows Written 合計は増えます。取得可能なジョブがない claim と heartbeat も Rows Written の課金見積もりに含めます。

<!--TEXTLINT_SEGMENT_147-->

永続レコード数の上限と Rows Written の監視条件を定義する

<!--TEXTLINT_SEGMENT_148-->

Durable Object を利用するアプリケーションは、ランキング表示件数、投稿受付件数、審査ジョブの保存期限を別々に決めます。claim、heartbeat、scoring callback ごとの読み書き件数を回帰テストにし、アプリケーション内部の日次上限で異常な保存を止めます。Cloudflare アカウント全体の Budget Alert は、アプリケーション内部の日次上限に含まれない Durable Object namespace と他の従量課金を検知するために併用します。

<!--TEXTLINT_SEGMENT_149-->

7

<!--TEXTLINT_SEGMENT_150-->

全件保存版のコードと Cloudflare 請求書が示す証拠の範囲

<!--TEXTLINT_SEGMENT_151-->

全件保存版と Cloudflare 請求書が裏づける範囲

<!--TEXTLINT_SEGMENT_152-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書には、Durable Objects Storage Rows Written 665,418,208 行、$666 と記載されていました。

<!--TEXTLINT_SEGMENT_153-->

出典 1

<!--TEXTLINT_SEGMENT_154-->

[1]

<!--TEXTLINT_SEGMENT_155-->

全件保存版には、Runner の既定値で名目約 5.2 回 / 秒になる claim と heartbeat、および JudgeState に保存された全 job key の無条件な再保存が存在しました。

<!--TEXTLINT_SEGMENT_156-->

全件保存版の Runner 既定値で名目約 5.2 回 / 秒になる claim と heartbeat を JudgeState の全 job key 再保存へ接続すると、Runner 稼働秒数と JudgeState に保存された job key 数に応じて Rows Written が増幅します。書き込み増幅の機構は全件保存版のコードから確認できます。

<!--TEXTLINT_SEGMENT_157-->

差分保存版は、JudgeState の全件保存、Runner の固定間隔による claim、scoring callback の入力検証を修正しています。

<!--TEXTLINT_SEGMENT_158-->

commit e376e44 は、JudgeState の成功した key 書き込みを UTC 日ごとに数え、25,000 行で warning を記録し、50,000 行を超える保存を HTTP 507 で拒否します。

<!--TEXTLINT_SEGMENT_159-->

出典 14

<!--TEXTLINT_SEGMENT_160-->

[14]

<!--TEXTLINT_SEGMENT_161-->

$666 の Rows Written を Durable Object namespace 別に帰属するため不足している証拠

<!--TEXTLINT_SEGMENT_162-->

2026 年 7 月 4 日〜8 月 3 日の Cloudflare 請求書は、請求対象の Cloudflare アカウントに属する全 Durable Object namespace の Rows Written を合算しています。2026 年 7 月 4 日〜8 月 3 日の Durable Object namespace 別メトリクスと Runner の実行記録がないため、$666 全額を hackathon-nukoevi-app の JUDGE_STATE binding が参照する JudgeState Durable Object namespace の Rows Written へ帰属できません。

<!--TEXTLINT_SEGMENT_163-->

名目約 5.2 回 / 秒と 22,913,280 行 / 日の計算例は全件保存版の Runner 既定値による推定であり、2026 年 7 月 4 日〜8 月 3 日の実測値ではありません。

<!--TEXTLINT_SEGMENT_164-->

influ-quest の QuestAgent namespace と BrowserChatSession namespace が Rows Written に寄与した可能性を排除できません。出典 1〜14 には、第三者が automated-hachathon-judge の /internal/scoring-callback へ不正な callback を送信したことを示す実行記録が含まれていません。

<!--TEXTLINT_SEGMENT_165-->

8

<!--TEXTLINT_SEGMENT_166-->

まとめ

<!--TEXTLINT_SEGMENT_167-->

全件保存版の Rows Written 増幅は、Runner が高頻度で送る claim と heartbeat の後に、JudgeState が meta key と保存済みの全 job key を再保存したことから発生しました。差分保存版は、JudgeState の永続状態が変化しないリクエストによる storage.put と storage.delete を 0 件とし、値が変化した job key と meta key だけを保存し、審査キューが空の時間は claim 間隔を最大 30 秒まで延ばします。

<!--TEXTLINT_SEGMENT_168-->

再発防止は差分保存だけで終わらせず、Cloudflare アカウント全体の従量課金額を $1 と $10 で通知し、JudgeState の key 書き込みを 50,000 行 / UTC 日で停止する二層にしました。Cloudflare 請求書の Durable Objects Storage Rows Written 明細に記載された $666 は高い授業料でした。本レポートは、Runner の高頻度な claim と heartbeat、および JudgeState に保存された全 job key の再保存を組み合わせる実装と、同じ失敗を請求前に止める方法を共有するために公開します。

<!--TEXTLINT_SEGMENT_169-->

9

<!--TEXTLINT_SEGMENT_170-->

出典

<!--TEXTLINT_SEGMENT_171-->

Cloudflare 請求書の Durable Objects Storage Rows Written 明細（2026 年 7 月 4 日〜8 月 3 日）

<!--TEXTLINT_SEGMENT_172-->

Cloudflare Durable Objects Pricing

<!--TEXTLINT_SEGMENT_173-->

automated-hachathon-judge の構成と Durable Object の役割

<!--TEXTLINT_SEGMENT_174-->

automated-hachathon-judge commit 8b494bd の Runner 並列数、claim 間隔、heartbeat

<!--TEXTLINT_SEGMENT_175-->

automated-hachathon-judge commit 8b494bd の JudgeState 無条件保存と全 job key 再保存

<!--TEXTLINT_SEGMENT_176-->

automated-hachathon-judge commit 8b494bd の recentIds 50 件上限と上限のない jobs 保持

<!--TEXTLINT_SEGMENT_177-->

influ-quest commit 9c518da の QuestAgent と BrowserChatSession Durable Object binding

<!--TEXTLINT_SEGMENT_178-->

influ-quest commit 9c518da の BrowserChatSession によるセッション単位の状態保存とリクエスト直列化

<!--TEXTLINT_SEGMENT_179-->

automated-hachathon-judge commit c2ffc4a の JudgeState 差分保存、Runner claim backoff、scoring callback 事前検証

<!--TEXTLINT_SEGMENT_180-->

automated-hachathon-judge commit c2ffc4a の state-persistence.ts による差分保存

<!--TEXTLINT_SEGMENT_181-->

automated-hachathon-judge commit c2ffc4a の api.ts による scoring callback 認証と事前検証

<!--TEXTLINT_SEGMENT_182-->

automated-hachathon-judge commit c2ffc4a の Runner claim backoff と HTTP 401、403、410 応答時の Runner 停止

<!--TEXTLINT_SEGMENT_183-->

Cloudflare Budget Alerts

<!--TEXTLINT_SEGMENT_184-->

automated-hachathon-judge commit e376e44 の JudgeState 日次書き込みガードと HTTP 507 による Runner 停止

<!--TEXTLINT_SEGMENT_185-->

automated-hachathon-judge Durable Objects Rows Written 増幅レポート

<!--TEXTLINT_SEGMENT_186-->

Cloudflare 請求期間: 2026 年 7 月 4 日〜8 月 3 日