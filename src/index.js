/**

- RepoHub Category Worker v2
- 
- 改善点:
- - iTunes API をバルク取得（最大200件/リクエスト）
- - KV hit/miss を分離してまとめて処理
- - Edge Cache 対応（Cache-Control: public, max-age=86400）
- - bundleId の重複削除
- - AppStore に存在しない IPA → “Unknown” カテゴリ
    */

const KV_TTL       = 60 * 60 * 24 * 30; // 30日
const EDGE_TTL     = 86400;              // Edge Cache 1日
const ITUNES_CHUNK = 200;               // iTunes API の最大 bundleId 数/回
const FETCH_TIMEOUT = 8000;

export default {
async fetch(request, env, ctx) {
if (request.method === ‘OPTIONS’) return corsResp(’’, 204);

```
const url = new URL(request.url);

// GET /category?bundleId=xxx
if (url.pathname === '/category' && request.method === 'GET') {
  const bundleId = url.searchParams.get('bundleId');
  if (!bundleId) return corsResp(JSON.stringify({ error: 'bundleId required' }), 400);

  const cacheKey = new Request(request.url, request);
  const edgeCached = await caches.default.match(cacheKey);
  if (edgeCached) return edgeCached;

  const result = await getSingle(bundleId, env);
  const resp   = corsResp(JSON.stringify(result), 200, EDGE_TTL);
  ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  return resp;
}

// POST /batch  { bundleIds: [...] }
if (url.pathname === '/batch' && request.method === 'POST') {
  let body;
  try { body = await request.json(); }
  catch { return corsResp(JSON.stringify({ error: 'Invalid JSON' }), 400); }

  const raw = body.bundleIds;
  if (!Array.isArray(raw) || raw.length === 0)
    return corsResp(JSON.stringify({ error: 'bundleIds[] required' }), 400);
  if (raw.length > 1000)
    return corsResp(JSON.stringify({ error: 'Max 1000 bundleIds' }), 400);

  const result = await getBatch(raw, env, ctx);
  return corsResp(JSON.stringify(result), 200, EDGE_TTL);
}

return corsResp(JSON.stringify({ error: 'Not found' }), 404);
```

}
};

// ── 単体取得 ─────────────────────────────────────────────────────
async function getSingle(bundleId, env) {
const kv = await env.CATEGORY_CACHE.get(`cat:${bundleId}`);
if (kv !== null) return { bundleId, category: kv, source: ‘cache’ };

const map = await itunesBulkLookup([bundleId]);
const cat = map[bundleId] ?? ‘Unknown’;
await env.CATEGORY_CACHE.put(`cat:${bundleId}`, cat, { expirationTtl: KV_TTL });
return { bundleId, category: cat, source: ‘itunes’ };
}

// ── バッチ取得 ────────────────────────────────────────────────────
async function getBatch(rawIds, env, ctx) {
// 1. 重複削除
const ids = […new Set(rawIds.filter(Boolean))];

// 2. KV を並列チェック
const kvResults = await Promise.all(
ids.map(id => env.CATEGORY_CACHE.get(`cat:${id}`).then(v => ({ id, v })))
);

const hitMap  = {};
const missIds = [];
for (const { id, v } of kvResults) {
if (v !== null) hitMap[id] = v;
else missIds.push(id);
}

// 3. miss だけ iTunes バルク lookup（200件ずつ）
const freshMap = {};
if (missIds.length > 0) {
const chunks = chunkArray(missIds, ITUNES_CHUNK);
const results = await Promise.all(chunks.map(itunesBulkLookup));
for (const m of results) Object.assign(freshMap, m);

```
// iTunes にも存在しなかったものは Unknown
for (const id of missIds) {
  if (!(id in freshMap)) freshMap[id] = 'Unknown';
}

// 4. KV に非同期保存
ctx.waitUntil(
  Promise.all(
    Object.entries(freshMap).map(([id, cat]) =>
      env.CATEGORY_CACHE.put(`cat:${id}`, cat, { expirationTtl: KV_TTL })
    )
  )
);
```

}

// 5. マージして返す
const result = {};
for (const id of ids) {
result[id] = {
category: hitMap[id] ?? freshMap[id] ?? ‘Unknown’,
source:   id in hitMap ? ‘cache’ : ‘itunes’,
};
}
return result;
}

// ── iTunes バルク Lookup ──────────────────────────────────────────
async function itunesBulkLookup(ids) {
const map = {};
if (!ids.length) return map;
try {
const query  = ids.map(encodeURIComponent).join(’,’);
const apiUrl = `https://itunes.apple.com/lookup?bundleId=${query}&country=us&limit=${ids.length}`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
const res = await fetch(apiUrl, {
signal: controller.signal,
headers: { ‘User-Agent’: ‘RepoHub/2.0’ }
});
clearTimeout(timer);
if (!res.ok) return map;
const data = await res.json();
for (const item of (data.results ?? [])) {
if (item.bundleId && item.primaryGenreName) {
map[item.bundleId] = item.primaryGenreName;
}
}
} catch { /* タイムアウト等 → 空mapを返してUnknown扱い */ }
return map;
}

// ── ユーティリティ ────────────────────────────────────────────────
function chunkArray(arr, size) {
const out = [];
for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
return out;
}

function corsResp(body, status = 200, edgeTtl = 0) {
return new Response(body, {
status,
headers: {
‘Content-Type’: ‘application/json’,
‘Access-Control-Allow-Origin’: ‘*’,
‘Access-Control-Allow-Methods’: ‘GET, POST, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type’,
‘Cache-Control’: edgeTtl > 0
? `public, max-age=${edgeTtl}, s-maxage=${edgeTtl}`
: ‘no-store’,
}
});
}
