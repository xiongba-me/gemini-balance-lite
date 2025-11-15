# CLAUDE.md

该文件用于在 claude.ai/code 上处理此仓库代码时，为 Claude Code 提供指导。

## 常用命令

该项目直接使用 Cloudflare 的 `wrangler` CLI，因为 `package.json` 中没有定义任何 npm 脚本。

-   **本地运行以进行开发**：`wrangler dev`
-   **部署到 Cloudflare**：`wrangler deploy`
-   **查看实时日志**：`wrangler tail`

## 高层架构

该项目是一个 Cloudflare Worker，充当 Google Gemini API 的限速负载均衡器。其主要目的是管理一个 Gemini API 密钥池，在它们之间分发请求并强制执行使用限制。

### 核心组件

-   **入口点 (`src/index.js`)**：这是在 `wrangler.toml` 中指定的主文件。它接收所有传入的 HTTP 请求，并将核心逻辑委托给 `handle_request.js`。

-   **请求处理器 (`src/handle_request.js`)**：这是应用程序的核心。它通过执行以下步骤来处理每个传入的请求：
    1.  使用访问令牌 (`GEMINI_ACCESS_TOKEN`) 对请求进行身份验证。
    2.  从 URL 中提取目标模型名称。
    3.  从经过随机打乱的密钥池 (`GEMINI_KEYS`) 中选择一个可用的 Gemini API 密钥。
    4.  使用 `GEMINI_RATE_LIMIT` KV 命名空间检查所选密钥的速率限制和每日调用限制。
    5.  使用所选密钥将请求转发到官方的 Gemini API 端点。
    6.  在 KV 命名空间中更新使用统计信息（调用次数、错误）。

-   **配置 (`wrangler.toml`)**：此文件定义了 Worker 的配置，包括入口点、KV 命名空间绑定和环境变量。需要配置的关键变量有：
    -   `GEMINI_KEYS`：要在池中使用的 Gemini API 密钥的逗号分隔列表。
    -   `GEMINI_ACCESS_TOKEN`：使用此代理所需的访问令牌的逗号分隔列表。
    -   `GEMINI_PROXY_CONFIG`：一个 JSON 字符串，用于定义每个模型的速率限制和每日调用配额。

-   **数据存储 (Cloudflare KV)**：应用程序使用一个绑定到 `GEMINI_RATE_LIMIT` 的 KV 命名空间来存储所有持久性数据，包括：
    -   每个 API 密钥的最后使用时间戳，用于强制执行速率限制。
    -   每个密钥和模型的每日调用计数。
    -   错误计数和被封禁密钥的状态。

-   **支持模块**：
    -   `statistics.js`：处理 `/statistics` 端点的逻辑，该端点可能从 KV 读取数据以显示使用情况。
    -   `verify_keys.js`：管理 `/verify` 端点，可能用于检查已配置的 Gemini 密钥的有效性。
    -   `date_utils.js`：提供用于日期格式化的辅助函数，用于每日统计跟踪。