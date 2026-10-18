import { handleApiRequest } from "./api";
import { JudgeState } from "./judge-state";
import { processScoringMessage } from "./queue";
import type { ScoringQueueMessage } from "../shared/types";

export { JudgeState };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) {
      return handleApiRequest(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
  async queue(batch: MessageBatch<ScoringQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processScoringMessage(message.body, env);
      } finally {
        message.ack();
      }
    }
  }
};
