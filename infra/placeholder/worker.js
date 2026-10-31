// Placeholder Worker so `terraform apply` succeeds before the real app is built.
// It serves the static placeholder page, answers /api/health, and exports the
// SessionRoom Durable Object class that the wrangler migration declares.
// The real Worker lives in worker/ (see the implementation plan).

export class SessionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response(JSON.stringify({ ok: true, room: "placeholder" }), {
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const checks = { d1: false, kv: false, r2: false };
      try { await env.DB.prepare("SELECT 1").first(); checks.d1 = true; } catch {}
      try { await env.KV.get("health"); checks.kv = true; } catch {}
      try { await env.MEDIA_CACHE.head("health"); checks.r2 = true; } catch {}
      return Response.json({ ok: true, service: "singersvoice", placeholder: true, checks });
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/") || url.pathname.startsWith("/auth/")) {
      return Response.json({ error: "not implemented yet", placeholder: true }, { status: 501 });
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch) {
    for (const message of batch.messages) message.ack();
  },
};
