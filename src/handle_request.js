import { handleVerification } from './verify_keys.js';
import openai from './openai.mjs';

export default {
    async fetch(request, env) {
        return handleRequest(request, env);
    }
};

export async function handleRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const search = url.search;

    // ===== 基础路由 =====
    if (pathname === '/' || pathname === '/index.html') {
        return new Response('Proxy is Running!  More Details: https://github.com/tech-shrimp/gemini-balance-lite', {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
        });
    }

    if (pathname === '/verify' && request.method === 'POST') {
        return handleVerification(request);
    }

    // ===== 处理 OpenAI 兼容路径 =====
    if (
        url.pathname.endsWith("/chat/completions") ||
        url.pathname.endsWith("/completions") ||
        url.pathname.endsWith("/embeddings") ||
        url.pathname.endsWith("/models")
    ) {
        return openai.fetch(request);
    }

    // ===== 提取模型名 =====
    const modelMatch = pathname.match(/models\/([^:]+)/);
    const modelName = modelMatch ? modelMatch[1] : null;

    if (!modelName) {
        return new Response("Invalid model path", { status: 400 });
    }

    // ===== 不同模型限流时间（秒） =====
    const limits = {
        "gemini-2.5-pro": 60,
        "gemini-2.5-flash": 10
    };
    const limitSeconds = limits[modelName] || 30;

    // ===== 解析 x-goog-api-key =====
    let apiKeys = [];
    for (const [key, value] of request.headers.entries()) {
        if (key.toLowerCase() === 'x-goog-api-key') {
            apiKeys = value.split(',').map(k => k.trim()).filter(k => k);
        }
    }

    if (apiKeys.length === 0) {
        return new Response("Missing x-goog-api-key header", { status: 400 });
    }

    // ===== 获取上次轮询位置 =====
    const roundRobinKey = `rr:${modelName}`;
    const lastIndexStr = await env.GEMINI_RATE_LIMIT.get(roundRobinKey);
    let startIndex = lastIndexStr ? (parseInt(lastIndexStr) + 1) % apiKeys.length : 0;

    let selectedKey = null;
    const now = Date.now();

    // ===== 遍历 key 池（轮询 + 限流检查 + 锁检测） =====
    for (let i = 0; i < apiKeys.length; i++) {
        const index = (startIndex + i) % apiKeys.length;
        const k = apiKeys[index];
        const rateKey = `${modelName}:${k}`;
        const lockKey = `${rateKey}:lock`;

        const [lastUsed, locked] = await Promise.all([
            env.GEMINI_RATE_LIMIT.get(rateKey),
            env.GEMINI_RATE_LIMIT.get(lockKey)
        ]);

        if (locked) continue; // 被锁住了，跳过此 key

        const elapsed = lastUsed ? (now - Number(lastUsed)) / 1000 : Infinity;
        if (elapsed >= limitSeconds) {
            selectedKey = k;

            // 设置轮询索引（记住下次从下一个 key 开始）
            await env.GEMINI_RATE_LIMIT.put(roundRobinKey, String(index), { expirationTtl: 3600 });

            // 上锁（2 秒锁，防止并发竞争）
            await env.GEMINI_RATE_LIMIT.put(lockKey, "1", { expirationTtl: 2 });

            // 更新使用时间
            await env.GEMINI_RATE_LIMIT.put(rateKey, String(now), { expirationTtl: 3600 });
            break;
        }
    }

    // ===== 所有 key 都被限流或锁定 =====
    if (!selectedKey) {
        return new Response(
            `All keys are rate-limited or locked for ${modelName}. Try again later.`,
            { status: 429, headers: { 'Content-Type': 'text/plain' } }
        );
    }

    // ===== 转发请求 =====
    const targetUrl = `https://generativelanguage.googleapis.com${pathname}${search}`;
    const headers = new Headers();

    for (const [key, value] of request.headers.entries()) {
        if (key.trim().toLowerCase() === 'x-goog-api-key') {
            headers.set('x-goog-api-key', selectedKey);
        } else if (key.trim().toLowerCase() === 'content-type') {
            headers.set(key, value);
        }
    }

    try {
        console.log(`Forwarding ${modelName} using key: ${selectedKey}`);

        const response = await fetch(targetUrl, {
            method: request.method,
            headers,
            body: request.body
        });

        // 清理临时锁（请求结束后）
        await env.GEMINI_RATE_LIMIT.delete(`${modelName}:${selectedKey}:lock`);

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

    } catch (error) {
        console.error('Failed to fetch:', error);
        await env.GEMINI_RATE_LIMIT.delete(`${modelName}:${selectedKey}:lock`);
        return new Response('Internal Server Error\n' + error?.stack, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}
