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

- Runner endpoint または callback の authentication bypass
- public response への token や IP hash の露出
- untrusted repository content からの code execution
- Codex または GitHub credential の漏えい
- Durable Object state の unauthorized mutation
- prompt injection による scoring boundary の逸脱

第三者の repository や service に対する無断テスト、denial of service、social engineering は行わないでください。
