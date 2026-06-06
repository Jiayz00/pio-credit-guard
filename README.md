# Pioneer Credit Guard

Pioneer Credit Guard 是一个面向服务器部署的内部自动化服务，用来监控并修复 Pioneer Agent 的 credit rules 配置。项目的核心目标是：账号完成一次授权后，程序在后台定时刷新 `https://agent.pioneer.ai/credits`，判断 credit rules 是否被取消、缺失或与预设值不一致，并在满足安全条件时自动按配置恢复。

这个项目适合放在已有的 sub 管理端后面使用。服务端口默认只绑定到 `127.0.0.1`，公网不直接暴露；管理员从 sub 后台按钮跳转进入配置界面，后端会再次校验当前访问者是否为管理员。

## 开发思路

Pioneer 的 credit rules 不是稳定的静态状态，而且页面本身不会主动刷新。项目采用 Playwright 浏览器自动化作为执行基础，并结合 Chrome DevTools Protocol 监听网络响应：

- 每次检查前都会重新打开或刷新 `/credits` 页面，避免使用旧 DOM 或旧接口响应。
- 优先读取本次刷新产生的 Pioneer API 响应，无法确认时再读取页面 DOM。
- 判断结果分为 `ok`、`missing`、`mismatch`、`auth_required`、`unknown`、`page_error`、`stale_or_timeout` 等状态。
- 只有在刷新后的状态明确显示缺失或不匹配，并达到配置的确认次数后，才执行修复。
- 修复后会再次刷新检查，确认最终状态已经回到 `ok`。
- 当页面结构变化、接口不可用或连续出现无法判断的状态时，任务会暂停并记录日志，而不是盲目点击。

## 已实现功能

- Web 配置界面：设置是否启用自动修复、`add` / `restore` 模式、Add credits、Charge when remaining drops below 等参数。
- 授权登录：通过 Playwright 持久化浏览器资料保存 Pioneer 登录状态，授权资料存放在 `data/browser-profile`。
- 内嵌授权画面：服务器无桌面环境时，可以在管理界面中通过截图流完成登录操作。
- 实时检查：每次检查强制刷新 Pioneer credits 页面，并只使用本轮刷新得到的新数据。
- 自动修复：按配置恢复 credit rules，支持修复前多次确认和修复冷却时间。
- 手动操作：支持手动验证授权、立即检查、立即修复、启动任务、停止任务。
- 监控时间段：可全天运行，也可设置自定义运行窗口；窗口外关闭后台浏览器，仅保留授权资料。
- 手动高风险时间段：在指定时间段内使用更快检查间隔。
- 自动高风险学习：可开启 48 小时学习期，记录规则失效或需要修复的时间，生成建议监控时间段，并可选择自动应用。
- SQLite 存储：配置、授权状态、运行状态、日志、学习样本都保存在本地 SQLite。
- 管理端保护：通过反向代理密钥和 sub 管理员身份双重校验，避免直接访问内部服务。

## 项目结构

```text
.
├── public/                 # 前端静态界面
├── scripts/                # 可选辅助脚本
├── src/
│   ├── auth.js             # sub 管理员身份校验
│   ├── config.js           # 环境变量配置
│   ├── db.js               # SQLite 表结构、迁移和读写
│   ├── server.js           # Express API、静态资源、WebSocket 截图流
│   └── worker.js           # Playwright/CDP 检查与修复逻辑
├── Caddyfile.snippet       # Caddy 反向代理示例
├── docker-compose.yml      # Docker Compose 部署示例
├── Dockerfile
├── .env.example
└── package.json
```

## 运行要求

- Node.js 24 或更高版本，项目使用了内置的 `node:sqlite`。
- Playwright Chromium 运行环境。使用 Dockerfile 部署时会基于 Playwright 官方镜像。
- 一个已有的 sub 管理端服务，用于校验管理员身份。
- 一个反向代理，例如 Caddy、Nginx 或 Traefik，用于把公网管理路径转发到本地端口，并注入内部密钥。

## 本地开发

```bash
cp .env.example .env
npm install
npm run check
npm start
```

默认地址：

```text
http://127.0.0.1:18994/admin/pioneer-credit/
```

如果本地没有 sub 管理端，可在 `.env` 中临时设置：

```env
AUTH_REQUIRED=false
```

这个设置只适合本地开发。生产环境应保持 `AUTH_REQUIRED=true`。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `HOST` | 服务监听地址 | `127.0.0.1` |
| `PORT` | 服务监听端口 | `18994` |
| `PUBLIC_BASE_PATH` | 前端和 API 挂载路径 | `/admin/pioneer-credit` |
| `DATA_DIR` | SQLite、浏览器资料、日志和截图目录 | `./data` |
| `SUB_BASE_URL` | sub 管理端内部地址 | `http://127.0.0.1:18080` |
| `SUB_ADMIN_VERIFY_PATH` | 校验当前用户是否为管理员的接口路径 | `/api/v1/auth/me` |
| `INTERNAL_PROXY_SECRET` | 反向代理注入的共享密钥 | 无，生产必须设置 |
| `AUTH_REQUIRED` | 是否启用管理端身份校验 | `true` |
| `TRUST_PROXY` | Express 是否信任反向代理头 | `true` |
| `BROWSER_HEADLESS` | 后台检查浏览器是否无头运行 | `true` |
| `HEADED_AUTH` | 授权浏览器是否使用有界面模式 | `true` |
| `AUTH_TIMEOUT_MS` | 授权窗口超时时间 | `600000` |
| `AUTH_REMOTE_DEBUGGING_PORT` | 授权浏览器远程调试端口，`0` 表示关闭 | `0` |
| `SCREENSHOT_ON_FAILURE` | 失败时是否保存截图 | `true` |
| `MAX_FAILURE_SCREENSHOTS` | 最多保留失败截图数 | `50` |
| `LOG_RETENTION_DAYS` | 日志保留天数 | `30` |
| `SUB2API_NETWORK` | Docker Compose 外部网络名 | `sub2api-network` |

## Docker 部署

1. 准备配置文件：

```bash
cp .env.example .env
```

2. 修改 `.env`：

```env
INTERNAL_PROXY_SECRET=replace-with-a-long-random-secret
SUB_BASE_URL=http://your-sub-admin-service:8080
SUB2API_NETWORK=your-sub-network
```

3. 启动服务：

```bash
docker compose up -d --build
```

`docker-compose.yml` 默认把端口绑定为：

```yaml
ports:
  - "127.0.0.1:18994:18994"
```

这表示服务只允许服务器本机访问，不会直接暴露到公网。公网访问应通过 sub 管理端所在域名下的内部路径进入。

## 反向代理示例

Caddy 可参考 `Caddyfile.snippet`，把片段放进你的管理端站点配置中：

```caddy
@pioneerCreditRoot {
  path /admin/pioneer-credit
}
handle @pioneerCreditRoot {
  redir * /admin/pioneer-credit/ 308
}

handle /admin/pioneer-credit/* {
  reverse_proxy 127.0.0.1:18994 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
    header_up X-Forwarded-Host {host}
    header_up X-Internal-Proxy-Secret {$PIONEER_CREDIT_GUARD_PROXY_SECRET}
    flush_interval -1
  }
}
```

Caddy 环境变量 `PIONEER_CREDIT_GUARD_PROXY_SECRET` 必须与服务 `.env` 中的 `INTERNAL_PROXY_SECRET` 一致。

## 接入 sub 管理端跳转按钮

推荐方式是在 sub 管理端源码里新增一个只对管理员可见的按钮，链接到：

```text
/admin/pioneer-credit/
```

按钮应使用新标签页打开：

```html
target="_blank" rel="noopener"
```

如果暂时只能修改已构建的账号页前端资源，可以使用 `scripts/patch-accounts-button.ps1` 辅助补丁。该脚本不内置任何私有部署锚点，需要你传入当前构建产物里稳定存在的一段按钮代码作为 `AnchorSnippet`：

```powershell
.\scripts\patch-accounts-button.ps1 `
  -AccountsAsset .\AccountsView-xxxx.js `
  -AnchorSnippet '这里填当前构建产物中稳定存在的一段按钮代码' `
  -OutFile .\AccountsView-xxxx.pioneer-credit.js
```

更稳妥的做法仍然是修改 sub 管理端源码并重新构建。

## 使用流程

1. 部署服务和反向代理，确认公网只能通过 `/admin/pioneer-credit/` 访问。
2. 使用 sub 管理员账号登录管理端。
3. 从账号页按钮进入 Pioneer Credit Guard。
4. 点击“授权登录”，在授权浏览器中完成 Pioneer 登录。
5. 点击“验证授权”，确认状态变为“已授权”。
6. 设置 `Mode`、`Add credits`、`Charge when remaining drops below`、检查间隔、监控时间段等参数。
7. 开启“启用自动修复”，点击“启动任务”。
8. 在日志区域观察检查结果和修复记录。

## 安全与脱敏说明

- `data/` 不应提交到 GitHub，其中包含 SQLite 数据库、授权浏览器资料、日志和截图。
- `.env` 不应提交到 GitHub，其中包含反向代理共享密钥和内部服务地址。
- 私有品牌 logo、失败截图、授权截图等图片不应提交到公开仓库。
- `INTERNAL_PROXY_SECRET` 只用于确认请求来自可信反向代理，不应作为唯一登录保护；后端 API 仍会调用 sub 管理端接口确认当前用户是管理员。
- 如果用户未登录或不是管理员，前端会跳转到 sub 登录页，后端 API 会返回 401。

## 注意事项

- Pioneer 页面和接口结构可能变化。项目使用保守选择器和多状态判断，遇到无法确认的页面会暂停并记录错误。
- `restore` 模式保留在配置中，但具体修复能力取决于 Pioneer 当前接口和页面是否支持对应行为。
- 授权状态依赖 `data/browser-profile`，重建容器不会丢失授权，但删除 `data/` 会导致需要重新登录。
- 生产环境不建议开启 `AUTH_REMOTE_DEBUGGING_PORT`，除非临时排查浏览器问题。

## 检查命令

```bash
npm run check
node --check public/app.js
```
