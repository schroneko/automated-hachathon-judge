# Security Policy

## Supported version

`main` branch の最新版だけを security update の対象とします。

## Reporting a vulnerability

GitHub repository の Security tab から private vulnerability report を作成してください。public Issue、Discussion、pull request には exploit details、credential、private data を記載しないでください。

報告には次を含めてください。

- 影響を受ける component と commit
- 再現条件
- 想定される impact
- 安全な範囲の proof of concept
- mitigation の案

受領後、再現確認、影響範囲、修正方針、公開時期を private channel で調整します。

## Scope

特に次の領域を重視します。

- 審査開始の期限・件数制限・冪等性の回避
- public response へのAPIキーや内部callback tokenの露出
- untrusted repository content からの code execution
- OpenAI または GitHub credential の漏えい
- D1の審査結果や費用台帳の不正な変更
- prompt injection による scoring boundary の逸脱

第三者の repository や service に対する無断テスト、denial of service、social engineering は行わないでください。
