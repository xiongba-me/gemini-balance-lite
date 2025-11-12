import { handleVerification } from './verify_keys.js';

// 限流规则
const RATE_LIMITS = {
    "gemini-2.5-pro": 60,   // 每个 key 60 秒只能用一次
    "gemini-2.5-flash": 10  // 每个 key 10 秒只能用一次
};


export async function handleRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const search = url.search;

    // 健康检查
    if (pathname === '/' || pathname === '/index.html') {
        return new Response('Proxy is Running!', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    if (pathname === '/verify' && request.method === 'POST') {
        return handleVerification(request);
    }

    // 提取模型名
    const modelMatch = pathname.match(/models\/([^:]+)/);
    const modelName = modelMatch ? modelMatch[1] : "unknown";
    const limitSeconds = RATE_LIMITS[modelName] || 30;

    // 从 header 中提取多个 API key
    const apiToken = request.headers.get("x-goog-api-key");

    if (!apiToken) {
        return new Response("Missing x-goog-api-key apiToken header", { status: 400 });
    }
    // === 配置的 accessKey ===
    let tokenString=env.GEMINI_ACCESS_TOKEN;

    const allowedTokens = new Set(
        tokenString.split(",").map(t => t.trim()).filter(Boolean)
    );
    //如果 access Key 不对==
    if (!apiToken || !allowedTokens.has(apiToken)) {
        return new Response("Unauthorized", { status: 401 });
    }

    // =====  配置的GENIMI_KEY  =====
    let apiKeys = env.GENIMI_KEY.split(',').map(s => s.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return new Response("Missing x-goog-api-key ", { status: 400 });
    }

    const kv = env.GEMINI_RATE_LIMIT;
    if (!kv) {
        return new Response("KV not bound!", { status: 500 });
    }

    // 从 KV 获取上次使用的索引，实现轮询
    const rrKey = `rr_index:${modelName}`;
    let lastIndex = parseInt(await kv.get(rrKey)) || 0;

    const now = Date.now();
    let selectedKey = null;
    let selectedIndex = -1;

    // 轮询查找可用 key
    for (let i = 0; i < apiKeys.length; i++) {
        const idx = (lastIndex + i + 1) % apiKeys.length;
        const key = apiKeys[idx];
        const rateKey = `${modelName}:${key}`;

        const lastUsed = parseInt(await kv.get(rateKey)) || 0;
        const elapsed = (now - lastUsed) / 1000;

        if (elapsed >= limitSeconds) {
            selectedKey = key;
            selectedIndex = idx;
            break;
        }
    }

    if (!selectedKey) {
        return new Response(
            `All keys for ${modelName} are rate-limited. Try again later.`,
            { status: 429, headers: { "Content-Type": "text/plain" } }
        );
    }

    // 记录本次使用时间
    await kv.put(`${modelName}:${selectedKey}`, String(now), { expiration_ttl: 3600 });
    await kv.put(rrKey, String(selectedIndex), { expiration_ttl: 86400 });

    console.log(`${modelName} 使用 Key: ${selectedKey}`);

    // 转发请求到 Gemini API
    const targetUrl = `https://generativelanguage.googleapis.com${pathname}${search}`;
    const headers = new Headers();

    for (const [key, value] of request.headers.entries()) {
        const low = key.trim().toLowerCase();
        if (low === 'x-goog-api-key') {
            headers.set('x-goog-api-key', selectedKey);
        } else if (low === 'content-type') {
            headers.set(key, value);
        }
    }

    try {
        const response = await fetch(targetUrl, {
            method: request.method,
            headers,
            body: request.body
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('transfer-encoding');
        responseHeaders.delete('connection');
        responseHeaders.delete('keep-alive');
        responseHeaders.delete('content-encoding');
        responseHeaders.set('Referrer-Policy', 'no-referrer');

        return new Response(response.body, {
            status: response.status,
            headers: responseHeaders
        });

    } catch (err) {
        console.error('Gemini Proxy Error:', err);
        return new Response('Internal Server Error\n' + err.stack, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}
