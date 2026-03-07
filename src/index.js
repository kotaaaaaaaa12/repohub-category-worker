/**
 * RepoHub Category Worker
 * 
 * GET /category?bundleId=com.example.app
 * 
 * 1. KVキャッシュを確認
 * 2. なければiTunes Search APIを叩く
 * 3. 結果をKVに保存（TTL: 30日）
 * 4. AppStoreにないやつ（改造系IPA等）は "Unknown" を返す
 */

const KV_TTL_SECONDS = 60 * 60 * 24 * 30; // 30日
const ITUNES_TIMEOUT_MS = 6000;

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    if (request.method !== 'GET') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }

    const url = new URL(request.url);

    // ── バッチエンドポイント: POST /batch ────────────────────────
    // 複数のbundleIDを一括処理したいときのために用意
    if (url.pathname === '/batch') {
      return handleBatch(request, env, ctx);
    }

    // ── 単体エンドポイント: GET /category?bundleId=xxx ───────────
    if (url.pathname === '/category') {
      const bundleId = url.searchParams.get('bundleId');
      if (!bundleId) {
        return corsResponse(JSON.stringify({ error: 'bundleId is required' }), 400);
      }
      const result = await getCategory(bundleId, env, ctx);
      return corsResponse(JSON.stringify(result), 200);
    }

    return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
  }
};

// ── バッチ処理 ───────────────────────────────────────────────────
async function handleBatch(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }

  const bundleIds = body.bundleIds;
  if (!Array.isArray(bundleIds) || bundleIds.length === 0) {
    return corsResponse(JSON.stringify({ error: 'bundleIds array required' }), 400);
  }
  if (bundleIds.length > 50) {
    return corsResponse(JSON.stringify({ error: 'Max 50 bundleIds per request' }), 400);
  }

  // 並列で全部取得
  const results = await Promise.all(
    bundleIds.map(id => getCategory(id, env, ctx))
  );

  // { bundleId -> { category, source } } の形で返す
  const map = {};
  results.forEach((r, i) => {
    map[bundleIds[i]] = r;
  });

  return corsResponse(JSON.stringify(map), 200);
}

// ── カテゴリ取得コア ─────────────────────────────────────────────
async function getCategory(bundleId, env, ctx) {
  const kvKey = `cat:${bundleId}`;

  // 1. KVキャッシュチェック
  const cached = await env.CATEGORY_CACHE.get(kvKey);
  if (cached !== null) {
    return { bundleId, category: cached, source: 'cache' };
  }

  // 2. iTunes API呼び出し
  const category = await fetchFromItunes(bundleId);

  // 3. KVに保存（バックグラウンドで、レスポンスを遅らせない）
  ctx.waitUntil(
    env.CATEGORY_CACHE.put(kvKey, category, { expirationTtl: KV_TTL_SECONDS })
  );

  return { bundleId, category, source: 'itunes' };
}

// ── iTunes Search API ────────────────────────────────────────────
async function fetchFromItunes(bundleId) {
  try {
    const apiUrl = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=us&limit=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITUNES_TIMEOUT_MS);

    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RepoHub/1.0' }
    });
    clearTimeout(timer);

    if (!res.ok) return 'Unknown';

    const data = await res.json();
    if (data.resultCount > 0 && data.results[0].primaryGenreName) {
      return data.results[0].primaryGenreName;
    }

    // AppStoreに存在しない = 改造系IPAなど
    return 'Unknown';
  } catch {
    // タイムアウトやネットワークエラー
    return 'Unknown';
  }
}

// ── CORS レスポンスヘルパー ──────────────────────────────────────
function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store', // CDNキャッシュはしない（KVで管理するため）
    }
  });
}
