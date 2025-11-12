import { getLocalDate } from './date_utils.js';

export async function handleStatisticsRequest(env,proxyConfig) {
    const rateLimits = proxyConfig.rateLimits;
    const dailyCallLimits = proxyConfig.dailyCallLimits;
    const kv = env.GEMINI_RATE_LIMIT;
    if (!kv) {
        return new Response("KV not bound!", { status: 500 });
    }

    let genimikeyStr = env.GEMINI_KEYS;
    if (!genimikeyStr) {
        return new Response("Missing GENIMI_KEY Config", { status: 401 });
    }
    const apiKeys = genimikeyStr.split(',').map(s => s.trim()).filter(Boolean);
    const models = Object.keys(rateLimits);
    const today = getLocalDate();

    const statsPromises = apiKeys.flatMap(key =>
        models.map(async model => {
            const redactedKey = `${key.substring(0, 4)}****${key.substring(key.length - 4)}`;
            const statsKey = `stats:${model}:${key}:${today}`;
            const errorKey = `error:${model}:${key}:${today}`;
            const bannedKey = `banned:${model}:${key}`;
            const lastUsedKey = `${model}:${key}`;

            const [count, errorCount,isBanned, lastUsedTimestamp] = await Promise.all([
                kv.get(statsKey),
                kv.get(errorKey),
                kv.get(bannedKey),
                kv.get(lastUsedKey)
            ]);

            return {
                key: redactedKey,
                model,
                count: parseInt(count) || 0,
                errorCount: parseInt(errorCount) || 0,
                banned: isBanned ? 'Yes' : 'No',
                lastUsed: lastUsedTimestamp ? new Date(parseInt(lastUsedTimestamp)).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles' }) : 'Never',
            };
        })
    );

    const stats = await Promise.all(statsPromises);

    const groupedStats = stats.reduce((acc, stat) => {
        if (!acc[stat.key]) {
            acc[stat.key] = [];
        }
        acc[stat.key].push(stat);
        return acc;
    }, {});


    const modelTotals = stats.reduce((acc, stat) => {
        if (!acc[stat.model]) {
            acc[stat.model] = 0;
        }
        acc[stat.model] += stat.count;
        return acc;
    }, {});

    const totalStatsHtml = Object.entries(modelTotals).map(([model, count]) => {
        const totalLimit = (dailyCallLimits[model] || 0) * apiKeys.length;
        if (!totalLimit || totalLimit === Infinity) {
            return `<div class="progress-cell" style="margin-bottom: 5px;">
                        <strong style="flex-shrink: 0;">${model}:</strong>
                        <span>${count} / Unlimited</span>
                    </div>`;
        }
        const percentageUsed = Math.min(100, (count / totalLimit) * 100);
        let progressBarColor = '#4CAF50', textColor = '#333'; // Default dark text for green
        if (percentageUsed >= 80) {
            progressBarColor = '#f44336';
            textColor = 'white'; // White text on red
        } else if (percentageUsed >= 50) {
            progressBarColor = '#ffc107';
            // textColor remains #333 for yellow
        } else {
            // progressBarColor remains #4CAF50 for green
            // textColor remains #333 for green
        }
        return `
            <div class="progress-cell" style="margin-bottom: 5px;">
                <strong style="flex-shrink: 0;">${model}:</strong>
                <div class="progress-container">
                    <div class="progress-bar" style="width: ${percentageUsed.toFixed(2)}%; background-color: ${progressBarColor}; color: ${textColor};">
                        <span>${percentageUsed.toFixed(2)}%</span>
                    </div>
                </div>
                <span class="limit-text">${count} / ${totalLimit}</span>
            </div>`;
    }).join('');

    let html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Proxy Statistics</title>
    <style>
        body { font-family: sans-serif; margin: 2em; background-color: #f4f4f9; color: #333; }
        h1 { color: #444; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 0.5em;}
        h1 span { font-size: 0.8em; margin-left: 1em; display: flex; align-items: center; flex-wrap: wrap;}
        h1 span .progress-cell { margin-right: 1em; margin-bottom: 5px;}
        table { width: 100%; border-collapse: collapse; margin-top: 1em; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        th, td { padding: 6px 8px; border: 1px solid #ddd; text-align: left; vertical-align: middle;}
        thead { background-color: #4CAF50; color: white; }
        tbody tr:nth-child(even) { background-color: #f9f9f9; }
        tbody tr:hover { background-color: #f1f1f1; }
        .banned-yes { color: red; font-weight: bold; }
        .progress-cell { display: flex; align-items: center; justify-content: space-between; }
        .progress-container { flex-grow: 1; height: 20px; background-color: #e0e0e0; border-radius: 4px; position: relative; margin-right: 10px; min-width: 100px; }
        .progress-bar { height: 100%; border-radius: 4px; text-align: center; color: white; line-height: 20px; box-sizing: border-box; transition: width 0.3s ease-in-out; }
        .limit-text { font-size: 0.9em; white-space: nowrap; }
        .error-low {
            background-color: #d4edda; /* 浅绿色 */
            color: #155724; /* 深绿色文本 */
        }
        .error-medium {
            background-color: #fff3cd; /* 浅橙色 */
            color: #856404; /* 深橙色文本 */
        }
        .error-high {
            background-color: #f8d7da; /* 浅红色 */
            color: #721c24; /* 深红色文本 */
        }
    </style>
</head>
<body>
    <h1>Gemini API Key Statistics (${today})<span>${totalStatsHtml}</span></h1>
    <table>
        <thead>
            <tr>
                <th>API Key</th>
                <th>Model</th>
                <th colspan="2">Daily Usage</th>
                <th>ERROR</th>
                <th>Is Banned</th>
                <th>Last Used</th>
            </tr>
        </thead>
        <tbody>
`;

    for (const key in groupedStats) {
        const keyStats = groupedStats[key];
        const rowSpan = keyStats.length;
        for (let i = 0; i < keyStats.length; i++) {
            const stat = keyStats[i];
            const dailyLimit = dailyCallLimits[stat.model];
            html += `
            <tr>`;
            if (i === 0) {
                html += `<td rowspan="${rowSpan}">${stat.key}</td>`;
            }
            html += `
                <td>${stat.model}</td>
            `;

            if (dailyLimit === Infinity || !dailyLimit) {
                html += '<td>Unlimited</td>';
            } else {
                const usedCalls = stat.count;
                const errorCall = stat.errorCount;
                const percentageUsed = Math.min(100, (usedCalls / dailyLimit) * 100);
                const errorRatio=Math.min(100, (errorCall / usedCalls) * 100)
                let progressBarColor = '#4CAF50'; // green
                let textColor = '#333'; // Default dark text for green
                if (percentageUsed >= 80) {
                    progressBarColor = '#f44336'; // red
                    textColor = 'white'; // White text on red
                } else if (percentageUsed >= 50) {
                    progressBarColor = '#ffc107'; // yellow
                    // textColor remains #333 for yellow
                }

                // textColor remains #333 for green

                html += `
                    <td>
                        <div class="progress-cell">
                            <div class="progress-container">
                                <div class="progress-bar" style="width: ${percentageUsed.toFixed(2)}%; background-color: ${progressBarColor}; color: ${textColor};">
                                    <span>${percentageUsed.toFixed(2)}%</span>
                                </div>
                            </div>
                        </div>
                    </td>
                    <td> <span class="limit-text">${usedCalls} / ${dailyLimit}</span></td>
                   <td class="${errorRatio < 10 ? 'error-low' : errorRatio < 30 ? 'error-medium' : 'error-high'}">
                        ${errorRatio.toFixed(2)}%
                    </td>
                `;
            }

            html += `
                <td class="${stat.banned === 'Yes' ? 'banned-yes' : ''}">${stat.banned}</td>
                 
                <td>${stat.lastUsed}</td>
            </tr>
`;
        }
    }

    html += `
        </tbody>
    </table>
</body>
</html>
`;
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}