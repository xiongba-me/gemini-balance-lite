import { handleVerification } from './verify_keys.js';
import openai from './openai.mjs';

export async function handleRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const search = url.search;

    // 基础路由
    if (pathname === '/' || pathname === '/index.html') {
        return new Response('Proxy is Running!  More Details: https://github.com/tech-shrimp/gemini-balance-lite', {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
        });
    }

    if (pathname === '/verify' && request.method === 'POST') {
        return handleVerification(request);
    }

    // 处理OpenAI格式请求
    if (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/completions") || url.pathname.endsWith("/embeddings") || url.pathname.endsWith("/models")) {
        return openai.fetch(request);
    }

    // ====== 识别模型和限流规则 ======
    const modelMatch = pathname.match(/models\/([^:]+):generateContent/);
    const modelName = modelMatch ? modelMatch[1] : null;

    // 如果不是 Gemini 模型请求，直接拒绝
    if (!modelName) {
        return new Response("Invalid model path", { status: 400 });
    }

    // 根据模型设置限流时间（单位：秒）
    const limits = {
        "gemini-2.5-pro": 60,
        "gemini-2.5-flash": 10
    };
    const limitSeconds = limits[modelName] || 30; // 默认30秒

    // ====== 提取 x-goog-api-key ======
    let apiKeys = [];
    for (const [key, value] of request.headers.entries()) {
        if (key.toLowerCase() === 'x-goog-api-key') {
            apiKeys = value.split(',').map(k => k.trim()).filter(k => k);
        }
    }

    if (apiKeys.length === 0) {
        return new Response("Missing x-goog-api-key header", { status: 400 });
    }

    const selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
    const rateLimitKey = `${modelName}:${selectedKey}`;

    // ====== KV 流控检查 ======
    const lastUsed = await env.GEMINI_RATE_LIMIT.get(rateLimitKey);
    const now = Date.now();

    if (lastUsed) {
        const elapsed = (now - Number(lastUsed)) / 1000;
        if (elapsed < limitSeconds) {
            const wait = Math.ceil(limitSeconds - elapsed);
            return new Response(`Rate limit hit: Please wait ${wait}s before next request for ${modelName}`, {
                status: 429,
                headers: { 'Content-Type': 'text/plain' }
            });
        }
    }

    // 记录当前时间戳
    await env.GEMINI_RATE_LIMIT.put(rateLimitKey, String(now), { expirationTtl: 3600 }); // 1小时后过期

    // ====== 转发请求到 Gemini ======
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
        console.log(`Forwarding request to Gemini model ${modelName} with key ${selectedKey}`);

        const response = await fetch(targetUrl, {
            method: request.method,
            headers: headers,
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

    } catch (error) {
        console.error('Failed to fetch:', error);
        return new Response('Internal Server Error\n' + error?.stack, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}
