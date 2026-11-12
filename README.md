# rsshub-router

[RSSHub](https://github.com/DIYgod/RSSHub) 私有路由仓库，通过 `USER_ROUTES_PATH` 加载，不修改 RSSHub 主仓库。

## 路由

| 文件 | 命名空间 | 路径 | 说明 |
| --- | --- | --- | --- |
| `avbase.mjs` | `avbase` | `/avbase/actors/:name` | AVbase 演员作品，使用 Playwright |
| `southplus.mjs` | `southplus` | `/southplus/:category?` | South Plus 最新主题（new.php 主来源，HTML + 官方 RSS 兜底） |
| `pornhub-search.mjs` | `pornhub-search` | `/pornhub-search/search_url/:keyword/:language?` | PornHub HTML 搜索结果 |

`pornhub-search.mjs` 没有使用 `pornhub.mjs`，因为 `pornhub` 是 RSSHub 内置命名空间，同名文件会导致 RSSHub 启动失败。

## 安装

### 源码运行

克隆到 RSSHub 安装目录内部。这一点很重要：模块里的 `cheerio`、`patchright`、`dayjs` 等依赖需要从 RSSHub 的 `node_modules` 解析。

```bash
cd /path/to/RSSHub
git clone https://github.com/foreveruand/rsshub-router.git routes-user
```

在 RSSHub 根目录的 `.env` 中配置：

```dotenv
USER_ROUTES_PATH=./routes-user
```

然后重启 RSSHub：

```bash
systemctl restart rsshub
```

只改路由不需要构建主程序。构建 RSSHub 时要清空 `USER_ROUTES_PATH`，避免私有路由被打进 `assets/build/routes.js`：

```bash
USER_ROUTES_PATH= pnpm build
```

### Docker

把仓库挂载到容器内的 `/app/routes-user`：

```yaml
services:
    rsshub:
        image: diygod/rsshub:chromium-bundled
        environment:
            USER_ROUTES_PATH: /app/routes-user
            ACCESS_KEY: '${ACCESS_KEY:?Set ACCESS_KEY in the Compose .env file}'
        volumes:
            - ./rsshub-router:/app/routes-user:ro
```

AVbase 需要 Chromium。使用 `chromium-bundled` 镜像，或提供 `CHROMIUM_EXECUTABLE_PATH`。

## 开发

```bash
cd /path/to/RSSHub/routes-user

node --check avbase.mjs
node -e "import('./southplus.mjs').then((m) => console.log(m.namespace.name, m.routes.length))"

# 修改后重启 RSSHub
systemctl restart rsshub
```

更完整的路由开发规范见 [AGENTS.md](./AGENTS.md)。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `AVBASE_COOKIES` | AVBASE 登录后的 Cookie，可选 |
| `SOUTHPLUS_COOKIE` | South Plus 登录 Cookie，可选；只需 `eb9e6_winduser`，配置后可读取私有版块的正文与封面 |
| `SOUTHPLUS_UA` | 与生成 `SOUTHPLUS_COOKIE` 时一致的浏览器 User-Agent，配置 Cookie 时必填 |
| `SOUTHPLUS_HOSTS` | South Plus 镜像列表，逗号分隔，可选 |
| `UA` | 自定义 User-Agent |
| `CHROMIUM_EXECUTABLE_PATH` | Chromium 可执行文件路径 |
| `PLAYWRIGHT_CDP_ENDPOINT` | 远程浏览器 CDP 地址 |
| `PLAYWRIGHT_WS_ENDPOINT` | 远程 Playwright 服务地址 |

## 来源

这些路由从 [`foreveruand/RSSHub`](https://github.com/foreveruand/RSSHub) 的二次开发路由迁移而来。主仓库现在跟随 [`DIYgod/RSSHub`](https://github.com/DIYgod/RSSHub)，路由开发只在本仓库进行。
