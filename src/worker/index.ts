import { handleApiRequest, validRecoveryMessage } from "./api";
import { JudgeState } from "./judge-state";
import { processExplanationMessage, processRecoveryMessage, processScoringMessage } from "./queue";
import { validExplanationMessage } from "./explanations";
import { processFreezeMessage, validFreezeMessage } from "./batches";
import type { JudgeQueueMessage } from "../shared/types";

export { JudgeState };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) {
      return handleApiRequest(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
  async queue(batch: MessageBatch<JudgeQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (validFreezeMessage(message.body)) await processFreezeMessage(message.body, env);
        else if (validExplanationMessage(message.body)) await processExplanationMessage(message.body, env);
        else if (validRecoveryMessage(message.body)) await processRecoveryMessage(message.body, env);
        else await processScoringMessage(message.body, env);
      } finally {
        message.ack();
      }
    }
  }
};
