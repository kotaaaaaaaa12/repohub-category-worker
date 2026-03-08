const KV_TTL = 60 * 60 * 24 * 30;
const EDGE_TTL = 86400;
const ITUNES_CHUNK = 200;
const FETCH_TIMEOUT = 8000;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return corsResp("", 204);

    const url = new URL(request.url);

    // GET /fetch?url=xxx  repo JSONのプロキシ
    if (url.pathname === "/fetch" && request.method === "GET") {
      const target = url.searchParams.get("url");
      if (!target) return corsResp(JSON.stringify({ error: "url required" }), 400);
      try {
        const controller = new AbortController();
        const timer = setTimeout(function() { controller.abort(); }, 12000);
        const res = await fetch(target, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; RepoHub/2.0)",
            "Accept": "application/json, text/plain, */*"
          }
        });
        clearTimeout(timer);
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "text/plain",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300"
          }
        });
      } catch(e) {
        return corsResp(JSON.stringify({ error: e.message }), 502);
      }
    }

    // GET /category?bundleId=xxx
    if (url.pathname === "/category" && request.method === "GET") {
      const bundleId = url.searchParams.get("bundleId");
      if (!bundleId) return corsResp(JSON.stringify({ error: "bundleId required" }), 400);

      const cacheKey = new Request(request.url, request);
      const edgeCached = await caches.default.match(cacheKey);
      if (edgeCached) return edgeCached;

      const result = await getSingle(bundleId, env);
      const resp = corsResp(JSON.stringify(result), 200, EDGE_TTL);
      ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
      return resp;
    }

    // POST /batch  { bundleIds: [...] }
    if (url.pathname === "/batch" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return corsResp(JSON.stringify({ error: "Invalid JSON" }), 400); }

      const raw = body.bundleIds;
      if (!Array.isArray(raw) || raw.length === 0)
        return corsResp(JSON.stringify({ error: "bundleIds[] required" }), 400);
      if (raw.length > 1000)
        return corsResp(JSON.stringify({ error: "Max 1000 bundleIds" }), 400);

      const result = await getBatch(raw, env, ctx);
      return corsResp(JSON.stringify(result), 200, EDGE_TTL);
    }

    return corsResp(JSON.stringify({ error: "Not found" }), 404);
  }
};

async function getSingle(bundleId, env) {
  const kv = await env.CATEGORY_CACHE.get("cat:" + bundleId);
  if (kv !== null) return { bundleId: bundleId, category: kv, source: "cache" };

  const map = await itunesBulkLookup([bundleId]);
  const cat = map[bundleId] !== undefined ? map[bundleId] : "Unknown";
  await env.CATEGORY_CACHE.put("cat:" + bundleId, cat, { expirationTtl: KV_TTL });
  return { bundleId: bundleId, category: cat, source: "itunes" };
}

async function getBatch(rawIds, env, ctx) {
  const ids = [...new Set(rawIds.filter(Boolean))];

  const kvResults = await Promise.all(
    ids.map(function(id) {
      return env.CATEGORY_CACHE.get("cat:" + id).then(function(v) { return { id: id, v: v }; });
    })
  );

  const hitMap = {};
  const missIds = [];
  for (const item of kvResults) {
    if (item.v !== null) hitMap[item.id] = item.v;
    else missIds.push(item.id);
  }

  const freshMap = {};
  if (missIds.length > 0) {
    const chunks = chunkArray(missIds, ITUNES_CHUNK);
    const results = await Promise.all(chunks.map(itunesBulkLookup));
    for (const m of results) Object.assign(freshMap, m);

    for (const id of missIds) {
      if (!(id in freshMap)) freshMap[id] = "Unknown";
    }

    ctx.waitUntil(
      Promise.all(
        Object.entries(freshMap).map(function(entry) {
          return env.CATEGORY_CACHE.put("cat:" + entry[0], entry[1], { expirationTtl: KV_TTL });
        })
      )
    );
  }

  const result = {};
  for (const id of ids) {
    result[id] = {
      category: hitMap[id] !== undefined ? hitMap[id] : (freshMap[id] !== undefined ? freshMap[id] : "Unknown"),
      source: id in hitMap ? "cache" : "itunes"
    };
  }
  return result;
}

async function itunesBulkLookup(ids) {
  const map = {};
  if (!ids.length) return map;
  try {
    const query = ids.map(encodeURIComponent).join(",");
    const apiUrl = "https://itunes.apple.com/lookup?bundleId=" + query + "&country=us&limit=" + ids.length;
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, FETCH_TIMEOUT);
    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "RepoHub/2.0" }
    });
    clearTimeout(timer);
    if (!res.ok) return map;
    const data = await res.json();
    for (const item of (data.results || [])) {
      if (item.bundleId && item.primaryGenreName) {
        map[item.bundleId] = item.primaryGenreName;
      }
    }
  } catch(e) {}
  return map;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function corsResp(body, status, edgeTtl) {
  if (status === undefined) status = 200;
  if (edgeTtl === undefined) edgeTtl = 0;
  return new Response(body, {
    status: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": edgeTtl > 0 ? "public, max-age=" + edgeTtl + ", s-maxage=" + edgeTtl : "no-store"
    }
  });
}
