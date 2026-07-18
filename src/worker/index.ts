import { handleApiRequest } from "./api";
import { JudgeState } from "./judge-state";

export { JudgeState };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) {
      return handleApiRequest(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  }
};
