import {handleVerification} from './verify_keys.js';
import {handleStatisticsRequest} from './statistics.js';
import {getLocalDate} from './date_utils.js';

const DEFAULT_RATE_LIMITS = {
    "gemini-2.5-pro": 60,
    "gemini-2.5-flash": 10
};

const DEFAULT_DAILY_CALL_LIMITS = {
    "gemini-2.5-pro": 40,
    "gemini-2.5-flash": 240
};


export async function handleRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const search = url.search;

    const proxyConfig = env.GEMINI_PROXY_CONFIG ? JSON.parse(env.GEMINI_PROXY_CONFIG) : {
        rateLimits: DEFAULT_RATE_LIMITS,
        dailyCallLimits: DEFAULT_DAILY_CALL_LIMITS
    };
    const rateLimits = proxyConfig.rateLimits;
    const dailyCallLimits = proxyConfig.dailyCallLimits;

    // 先从header中取 header 中提取 API key
    const apiToken = request.headers.get("x-goog-api-key") || url.searchParams.get('key');
    if (!apiToken) {
        return new Response("Missing API key. ", {status: 400});
    }
    // === 配置的 accessKey ===
    let tokenString = env.GEMINI_ACCESS_TOKEN;
    if (!tokenString) {
        return new Response("Missing Access Token Config", {status: 401});
    }
    const allowedTokens = new Set(
        tokenString.split(",").map(t => t.trim()).filter(Boolean)
    );
    //如果 access Key 不对==
    if (!apiToken || !allowedTokens.has(apiToken)) {
        return new Response(`Unauthorized apiToken ${apiToken}`, {status: 401});
    }
    // 健康检查
    if (pathname === '/' || pathname === '/index.html') {
        return new Response('Proxy is Running!', {
            status: 200,
            headers: {'Content-Type': 'text/plain'}
        });
    }

    if (pathname === '/statistics') {
        return handleStatisticsRequest(env, proxyConfig);
    }
    if (pathname === '/verify') {
        return handleVerification(env);
    }
    // 提取模型名
    const modelMatch = pathname.match(/models\/([^:]+)/);
    if (!modelMatch) {
        return new Response("暂不无模型调用的请求。", {status: 400});
    }
    const modelName = modelMatch[1];
    const limitSeconds = rateLimits[modelName] || 30;

    // =====  配置的 GENIMI_KEY  =====
    let genimikeyStr = env.GEMINI_KEYS;

    if (!genimikeyStr) {
        return new Response("Missing GENIMI_KEY Config", {status: 401});
    }

    let apiKeys = genimikeyStr.split(',').map(s => s.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return new Response("Missing x-goog-api-key ", {status: 400});
    }

    const kv = env.GEMINI_RATE_LIMIT;
    if (!kv) {
        return new Response("KV not bound!", {status: 500});
    }


    const now = Date.now();
    let selectedKey = null;
    // Create a shuffled copy of the keys to iterate through randomly
    const shuffledKeys = [...apiKeys].sort(() => Math.random() - 0.5);

    // 查找可用 key
    for (const key of shuffledKeys) {
        // 检查 key 是否被封禁
        const bannedKey = `banned:${modelName}:${key}`;
        const isBanned = await kv.get(bannedKey);
        if (isBanned) {
            continue; // 如果被封禁，则跳过此 key
        }

        // 检查每日调用次数上限
        const today = getLocalDate();
        const statsKey = `stats:${modelName}:${key}:${today}`;
        const currentDailyCount = parseInt(await kv.get(statsKey)) || 0;
        const dailyLimit = dailyCallLimits[modelName] || Infinity;

        if (currentDailyCount >= dailyLimit) {
            continue; // 如果达到每日上限，则跳过此 key
        }

        const rateKey = `${modelName}:${key}`;

        const lastUsed = parseInt(await kv.get(rateKey)) || 0;
        const elapsed = (now - lastUsed) / 1000;

        if (elapsed >= limitSeconds) {
            selectedKey = key;
            break;
        }
    }

    if (!selectedKey) {
        return new Response(
            `All keys for ${modelName} are rate-limited. Try again later.`,
            {status: 429, headers: {"Content-Type": "text/plain"}}
        );
    }

    // 记录本次使用时间
    await kv.put(`${modelName}:${selectedKey}`, String(now), {expiration_ttl: 3600});

    const redactedKey = `${selectedKey.substring(0, 4)}****${selectedKey.substring(selectedKey.length - 4)}`;
    console.log(`${modelName} 使用 Key: ${redactedKey}`);

    // 转发请求到 Gemini API
    const targetUrl = `https://generativelanguage.googleapis.com${pathname}${search}`;
    console.log(targetUrl);
    const headers = new Headers();

    for (const [key, value] of request.headers.entries()) {
        const low = key.trim().toLowerCase();
        if (low === 'x-goog-api-key') {
            headers.set('x-goog-api-key', selectedKey);
        } else if (low === 'content-type') {
            headers.set(key, value);
        }
    }
    console.log(request.body);
    try {
        const response = await fetch(targetUrl, {
            method: request.method,
            headers,
            body: request.body
        });
        // 统计每日调用次数
        const today = getLocalDate(); // 格式 YYYY-MM-DD
        const statsKey = `stats:${modelName}:${selectedKey}:${today}`;
        const currentCount = parseInt(await kv.get(statsKey)) || 0;
        await kv.put(statsKey, String(currentCount + 1), {expirationTtl: 172800}); // 24小时后过期

        if (!response.ok) {
            const clonedResponse = response.clone();
            clonedResponse.json()
                .then(json => {
                    console.error(`${modelName} 使用Key: ${redactedKey} 请求异常: ${clonedResponse.status}, 错误: ${JSON.stringify(json)}`);
                })
                .catch(() => {
                    clonedResponse.text()
                        .then(text => {
                            console.error(`${modelName} 使用Key: ${redactedKey} 请求异常: ${clonedResponse.status}, 错误: ${text}`);
                        });
                });
            if (response.status === 429) {
                const bannedKey = `banned:${modelName}:${selectedKey}`;
                await kv.put(bannedKey, 'true', {expirationTtl: 3600});
            }
            // 统计每日调用次数
            const errorKey = `error:${modelName}:${selectedKey}:${today}`;
            const errorCount = parseInt(await kv.get(errorKey)) || 0;
            await kv.put(errorKey, String(errorCount + 1), {expirationTtl: 172800}); // 48小时后过期
        }
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
            headers: {'Content-Type': 'text/plain'}
        });
    }
}
