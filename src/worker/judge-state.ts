import { DurableObject } from "cloudflare:workers";

export class JudgeState extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 410 });
  }
}
