Build a production-oriented Cloudflare Workers + Cloudflare Containers web app in the current empty directory for hackathon preliminary judging. Do not initialize git, commit, deploy, or access secrets. Implement code and tests only. Use TypeScript, npm, Vite for a small vanilla frontend, a Cloudflare Worker, Durable Objects for persistent submissions/results, and @cloudflare/containers for a Node container backend. Use the current Cloudflare Containers API and @openai/codex-sdk.

User-facing language is Japanese. The only input is a public GitHub repository URL. Do not use a browser, git clone, commit history, or repository archives. Resolve the repository's default branch and pin its current commit SHA through the GitHub REST API. Fetch repository evidence through the GitHub REST/raw content APIs at that pinned SHA. Do not follow links from README. Never execute repository code. Treat all repository contents as untrusted data and explicitly defend the scoring prompt against prompt injection.

Scoring is one pass per submission using exactly these four official Build Week dimensions, each integer 0-10, total 0-40:
1. 技術的な実装: completeness, architecture, robustness, security
2. デザインとユーザー体験: UI structure, flow, consistency, accessibility, based only on repository evidence
3. 潜在的なインパクト: importance, audience, practicality, growth potential
4. アイデアの質: originality, problem-solution fit, insight

Common anchors: 0 means no evaluable evidence; 1-2 very early/minimal; 3-4 partially works with major gaps; 5-6 meets baseline; 7-8 clearly strong; 9-10 exceptional for a hackathon. Return concise public reasons and concrete evidence file paths, never hidden reasoning or chain-of-thought.

Rules:
- Store submissions and results publicly. Allow repeated repository submissions, but only the latest completed submission per normalized repository counts in the ranking. Keep older results as history.
- Evaluate every submission once. Never re-score top candidates.
- After a completed score, never retry. For transient GitHub or Codex failure before a score exists, retry exactly once, then mark 審査不能.
- A genuinely empty repository scores 0 in all four criteria.
- Missing/private repositories or repositories without a default branch score 0 in all four criteria, with a clear reason.
- Expose status polling, individual result, recent submissions, and ranking endpoints.
- Run up to four interchangeable scorer containers. Queue sequentially within each container and route jobs deterministically across four buckets. Persist state in a separate Durable Object. Use a per-job random callback token stored with the job so a container can submit the final result back to the Worker without a global callback secret.
- The Worker must serve static frontend assets and API routes. Configure the custom domain hackathon.nukoevi.app.
- The container must use the Codex SDK server-side, with a read-only/no-execution evaluation workspace, a strict JSON output schema, a bounded evidence budget, and a hard timeout. The SDK/CLI must not receive a writable checkout of untrusted code. The container entrypoint should reconstruct /root/.codex/auth.json from a gzip+base64 environment secret named CODEX_AUTH_GZIP_B64 before starting the server. The Worker Container class must pass this secret as an environment variable. Do not include any credential value in source.
- Add simple abuse controls suitable for a one-day public event: validate GitHub URLs, cap request size, serialize per container, reject duplicate in-flight submissions for the same repo, and apply a conservative per-IP submission cooldown persisted in the Durable Object. Do not add user accounts.
- Use no external README links. Include the pinned SHA and evidence paths in results.
- Make the UI responsive, legible, sober, and focused. It should show the four criteria and anchors before submission, an active judging state, ranking, recent results, and clear failure states.
- Do not put code comments in source or configuration files.
- Use ASCII English file and directory names.
- Add README.md with architecture, local development, auth secret provisioning, deploy, test, security limitations, and operational notes. Do not suggest npx wrangler; use the globally installed wrangler command.
- Add unit tests for URL validation, scoring schema/total validation, latest-result ranking semantics, empty/missing repo handling, one-retry logic, prompt-injection boundary text, and API behavior where practical.

Use package versions that actually exist. Keep the implementation reasonably small and auditable. Run npm install, typecheck, tests, and build. Fix all failures. Do not write any .env file or secret.
