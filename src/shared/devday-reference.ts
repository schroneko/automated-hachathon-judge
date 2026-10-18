export const DEVDAY_REFERENCE_VERSION = "2026-10-18-verified-v2";

export const DEVDAY_FEATURE_REFERENCE = `Trusted organizer reference for DevDay 2026, announced September 29, 2026. Verified as of October 18, 2026 JST.

Official announcement scope
The full official recap at https://openai.com/index/devday-2026-recap/ verifies these announcements: GPT-6.1 Sol; Responses multi-agent beta; Decisions API with finite predicate, choice, and score questions; Agents API computer use; Ultrafast; Private Intelligence; cloud Codex; refreshed Codex CLI; Code Review; Codex Security Cloud; Bedrock Managed Agents; plugin extensions and viewers; plugin creation and discovery; Sites hosting plugins; MCP Events; ChatGPT Space and Pages; collaborative slides; teams and shared tasks; ChatGPT in Slack and Teams; Meetings plugin; shareable profiles; Sign in with ChatGPT; Pro 500; OpenAI Marketplace. Website annotations are also included, supported by https://learn.chatgpt.com/docs/whats-new/devday-2026 and https://learn.chatgpt.com/docs/annotations-extensibility.

Announcement and release timing
Decisions was announced September 29 in limited preview and entered broad beta October 6. Sol Ultrafast was announced as coming soon September 29 and released October 8. Release timing is verified by https://developers.openai.com/api/docs/changelog. Both are announced features eligible by event time; a later availability date does not exclude them. GPT-6 Luna launched independently September 22 and is not itself a new September 29 feature. Generic Responses usage or legacy MCP integration alone is insufficient to establish use of a new DevDay feature.

Official implementation evidence cues
These cues guide repository inspection. They are not exact substring gates or a requirement to reproduce documentation examples verbatim. SDK wrappers, aliases, and equivalent implementations qualify when the runtime path establishes the announced feature and connects its output to the product.

GPT-6.1 Sol: https://developers.openai.com/api/docs/models/gpt-6.1-sol. Look for an actual request using model gpt-6.1-sol, or an equivalent resolved model configuration, and trace its output into product behavior.

Responses multi-agent: https://developers.openai.com/api/docs/guides/responses-multi-agent. Look for multi_agent.enabled set to true together with OpenAI-Beta: responses_multi_agent=v1, or equivalent beta SDK betas configuration, on a connected request path.

Decisions: https://developers.openai.com/api/docs/guides/decisions. Look for POST /v1/decisions or decisions.create, predicate, choice, or score questions, and a path that consumes the answers in the product.

Agents API computer use: https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use. Look for Agents sessions, a computer_use tool, desktop enabled, and handling of events, approvals, and results. Distinguish this from older Responses computer use.

Ultrafast: https://developers.openai.com/api/docs/guides/ultrafast-mode. Look for service_tier set to ultrafast in an actual Responses request using a supported model and trace how the response serves the product.

Plugin extensions: https://developers.openai.com/plugins/build/extensions. Look for connected tool metadata with openai/ui entrypoints for global, thread, or file contexts, a UI resource, and a handler or render implementation.

MCP Events: https://developers.openai.com/plugins/build/mcp-events. Look for MCP 2.0 events/list, subscribe, and unsubscribe, signed webhook delivery, and an access-scoped handler connected to product behavior.

Sign in with ChatGPT: https://developers.openai.com/siwc/quickstart. Look for an OIDC flow with PKCE, callback handling, and token validation. A button label alone does not establish integration.

Website annotations: https://learn.chatgpt.com/docs/annotations-extensibility. Look for document.oai.annotation or actual annotation DOM attributes connected to website user interaction. Connected declarative annotation can constitute implementation.

Scoring calibration
Judge the purpose, usefulness, and quality of product integration, not the number of features named. Follow repository evidence from a reachable entrypoint through feature configuration or invocation to a user-facing result or meaningful product operation. README claims, names, dependencies, and dead or unreachable code alone are insufficient. Actual connected declarative plugin metadata or annotations can count as implementation without traditional imperative code; configuration is not automatically worth zero.

Using Codex only to develop the submission, owning a paid plan, or having a profile or store listing alone does not establish purposeful product integration. Conversely, one well-integrated feature can demonstrate stronger use than several shallow integrations. Keep integration quality distinct from feature eligibility, and assess the other three scoring criteria independently.

Do not require production access, secrets, or external execution to recognize implementation evidence. Do not invent API behavior or turn an unverified claim into a positive finding. This catalog is finite and time-stamped, not a complete account of every possible feature. Unknown eligibility requires explicit organizer verification; record the uncertainty rather than forcing either eligibility or a definitive ineligible judgment without verification.`;
