import { auditUrl, validateTarget, HttpError, type AuditResult } from "./audit";
import { suggestMeta } from "./ai";

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  AUDITS: KVNamespace;
  AI_MODEL: string;
  MAX_WATCHLIST: string;
  ADMIN_TOKEN?: string;
}

const WATCHLIST_KEY = "watchlist";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    try {
      // GET /api/audit?url=example.com[&ai=1]
      if (url.pathname === "/api/audit" && req.method === "GET") {
        const target = validateTarget(url.searchParams.get("url"));
        const result = await auditUrl(target);
        const body: AuditResult & { ai?: unknown } = result;

        if (url.searchParams.get("ai") === "1") {
          try {
            body.ai = await suggestMeta(env.AI, env.AI_MODEL, result.signals);
          } catch (e) {
            console.warn("ai_suggest_failed", { url: target.toString(), error: String(e) });
            body.ai = { error: "AI suggestion unavailable" };
          }
        }

        ctx.waitUntil(saveHistory(env, target.hostname + target.pathname, result));
        console.log("audit", { host: target.hostname, score: result.score, ttfb: result.signals.ttfbMs });
        return json(body);
      }

      // GET /api/history?url=example.com
      if (url.pathname === "/api/history" && req.method === "GET") {
        const target = validateTarget(url.searchParams.get("url"));
        const key = `history:${target.hostname}${target.pathname}`;
        return json((await env.AUDITS.get(key, "json")) || []);
      }

      // Watchlist: GET list, POST {url} add, DELETE ?url= remove
      if (url.pathname === "/api/watchlist") {
        const list = ((await env.AUDITS.get(WATCHLIST_KEY, "json")) as string[]) || [];
        if (req.method === "GET") return json(list);

        // Writes require ADMIN_TOKEN when set (wrangler secret put ADMIN_TOKEN)
        if (env.ADMIN_TOKEN && req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
          throw new HttpError(401, "Admin token required to change the watchlist");
        }

        if (req.method === "POST") {
          const { url: raw } = (await req.json().catch(() => ({}))) as { url?: string };
          const target = validateTarget(raw || null).toString();
          if (!list.includes(target)) {
            if (list.length >= Number(env.MAX_WATCHLIST)) throw new HttpError(409, "Watchlist is full");
            list.push(target);
            await env.AUDITS.put(WATCHLIST_KEY, JSON.stringify(list));
          }
          return json(list, 201);
        }

        if (req.method === "DELETE") {
          const target = validateTarget(url.searchParams.get("url")).toString();
          const next = list.filter((u) => u !== target);
          await env.AUDITS.put(WATCHLIST_KEY, JSON.stringify(next));
          return json(next);
        }
      }

      if (url.pathname === "/api/health") return json({ ok: true, colo: (req.cf?.colo as string) || null });

      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("unhandled", { path: url.pathname, error: String(e) });
      return json({ error: "Audit failed. The site may be blocking automated requests." }, 502);
    }
  },

  // Cron trigger: re-audit every watched URL and log score changes
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const list = ((await env.AUDITS.get(WATCHLIST_KEY, "json")) as string[]) || [];
    const results = await Promise.allSettled(
      list.map(async (raw) => {
        const target = new URL(raw);
        const key = target.hostname + target.pathname;
        const prev = (((await env.AUDITS.get(`history:${key}`, "json")) as HistoryEntry[]) || [])[0];
        const result = await auditUrl(target);
        await saveHistory(env, key, result);
        if (prev && prev.score - result.score >= 10) {
          console.warn("score_drop", { url: raw, from: prev.score, to: result.score });
        }
        return result.score;
      }),
    );
    console.log("cron_complete", {
      audited: results.filter((r) => r.status === "fulfilled").length,
      failed: results.filter((r) => r.status === "rejected").length,
    });
  },
} satisfies ExportedHandler<Env>;

interface HistoryEntry {
  score: number;
  auditedAt: string;
  failing: string[];
}

async function saveHistory(env: Env, key: string, r: AuditResult): Promise<void> {
  const k = `history:${key}`;
  const prev = ((await env.AUDITS.get(k, "json")) as HistoryEntry[]) || [];
  const entry: HistoryEntry = {
    score: r.score,
    auditedAt: r.auditedAt,
    failing: r.checks.filter((c) => c.status === "fail").map((c) => c.id),
  };
  await env.AUDITS.put(k, JSON.stringify([entry, ...prev].slice(0, 30)), { expirationTtl: 60 * 60 * 24 * 90 });
}
