# AGENTS.md

本仓库是 [RSSHub](https://github.com/DIYgod/RSSHub) 的私有路由仓库。所有模块通过 `USER_ROUTES_PATH` 加载，不修改 RSSHub 主仓库。

## 参考文档

- 开发总览：https://docs.rsshub.app/joinus/
- 创建路由：https://docs.rsshub.app/joinus/new-rss/start-code
- 脚本规范：https://docs.rsshub.app/joinus/advanced/script-standard
- 使用缓存：https://docs.rsshub.app/joinus/advanced/use-cache
- 日期处理：https://docs.rsshub.app/joinus/advanced/pub-date
- 私有路由部署：https://docs.rsshub.app/deploy/#deployment-docker-deployment-private-routes

官方文档中的示例使用 TypeScript 和 `@/` 别名。本仓库是独立的 `.mjs` 模块，不支持 TypeScript 和 `@/` 别名；下列规则已经按私有路由机制调整。

## 加载机制与目录

- 每个 `.mjs` 文件对应一个命名空间，文件名（去掉扩展名）必须匹配 `^[a-z][a-z\d-]*$`。
- 文件名不能与 RSSHub 内置命名空间冲突，否则 RSSHub 启动时会直接报错。
- 文件必须导出 `namespace` 和非空 `routes` 数组。
- 本仓库应克隆到 RSSHub 安装目录内部，例如 `RSSHub/routes-user`，并在 `.env` 中设置：

    ```dotenv
    USER_ROUTES_PATH=./routes-user
    ```

    这样 `cheerio`、`patchright`、`dayjs` 等 bare import 才能从 `RSSHub/node_modules` 解析。不要把本仓库放在 RSSHub 目录之外，除非你另外提供了可解析的 `node_modules`。
- 修改路由后重启 RSSHub；私有路由在运行时加载，不需要重新构建主程序。
- 构建 RSSHub 主程序时清空 `USER_ROUTES_PATH`，否则私有路由会被打进 `assets/build/routes.js`，下次启动时因命名空间冲突而失败：

    ```bash
    USER_ROUTES_PATH= pnpm build
    ```

- 一个文件只放一个命名空间；同一命名空间有多个路由时，在 `routes` 数组中添加。

## 模块契约

```js
export const namespace = {
    name: 'Example',
    url: 'example.com',
    lang: 'zh',
    description: '可选说明',
};

export const routes = [
    {
        path: '/news/:id?',
        name: 'News',
        maintainers: ['foreveruand'],
        categories: ['new-media'],
        example: '/example/news/1',
        parameters: { id: '新闻 ID' },
        features: {
            requireConfig: false,
            requirePuppeteer: false,
            antiCrawler: false,
            supportBT: false,
            supportPodcast: false,
            supportScihub: false,
            nsfw: false,
        },
        radar: [{ source: ['example.com/news'], target: '/news' }],
        handler: async (ctx) => {
            const { id } = ctx.req.param();
            return {
                title: 'Example News',
                link: 'https://example.com/news',
                item: [],
            };
        },
    },
];
```

- `namespace.name`：人类可读名称；`namespace.url`：不带协议的站点地址；`lang`、`description` 可选。
- `route.path`：以 `/` 开头，使用 Hono 路由语法；路径中不要再写命名空间。
- `route.name`：路由名称，不要与命名空间名称重复。
- `route.maintainers`：真实且同意维护的 GitHub 用户名；不要填写未同意的他人账号。
- `route.categories`：只写一个分类。
- `route.example`：必须是可访问的完整路由路径，以 `/` 开头，例如 `/avbase/actors/美乃すずめ`。
- `route.parameters`：键必须与 `path` 中的参数一致。
- `route.features`：按实际情况填写；`requirePuppeteer` 只在实际使用浏览器自动化时为 `true`，`nsfw` 必须准确。
- `route.radar`：`source` 不带 `https://`；`target` 可为空，存在时必须与 `path` 参数匹配。
- 不要为单个路由创建 `README.md` 或 `radar.ts`；路由说明写在 `route.description`，雷达规则写在 `route.radar`。

## 数据质量

- `description` 只放正文内容，不要重复 `title`、`author`、`pubDate` 或标签。
- 标签/分类放到 `category` 字段。
- `pubDate` 用 `dayjs` 等可靠方式解析；源站没有日期就省略，不要用 `new Date()` 伪造。
- 每个 item 的 `link` 必须唯一且稳定，它会被用作 `guid`。
- feed 的 `link` 使用人类可读的网页地址，不要使用 API 地址。
- 不要手动截断或清洗 `title`；RSSHub 核心会处理标题。
- 字符串前缀判断用 `startsWith()`，不要用 `includes()` 代替。
- 变量和函数用 `lowerCamelCase`，常量用 `CONSTANT_CASE`，文件名用 `kebab-case`。
- 4 空格缩进、单引号、语句末尾分号、文件末尾保留一个空行；注释用英文。
- 不要重复 `load()` 同一段 HTML；复用已有的 `$`。
- 不要返回空数组来绕过 RSSHub 的空结果检查；源站不可用时应让错误暴露出来。

## 抓取与缓存

- 优先使用站点 API；API 通常比 HTML 更稳定。
- 只抓取第一页；使用 RSSHub 通用 `limit` 参数，不实现自定义分页或过滤参数。
- 使用原生 `fetch` 或仓库中已有的依赖；检查 `response.ok`，设置合理的 `User-Agent` 和请求头。
- 批量抓取详情页时必须缓存，建议 TTL 24 小时，并限制并发（建议 1–3）。
- 不要用固定 `setTimeout` 等待页面；等待选择器或明确的条件。
- 遵守站点反爬策略；需要 Cookie/Token 时通过环境变量传入，不写入代码、日志或提交记录。
- 私有路由模块直接读取 `process.env`，不要 import RSSHub 的 `@/config`。

## Playwright

- 只有 API/HTML 无法获取数据时才使用浏览器自动化。
- 使用 `patchright` 或 `playwright`；复用浏览器/页面，不要在 `Promise.all()` 循环中反复启动浏览器。
- 请求拦截使用 allowlist，只允许需要的资源类型：

    ```js
    await page.route('**/*', (route) =>
        ['document', 'script', 'xhr', 'fetch', 'other'].includes(route.request().resourceType()) ? route.continue() : route.abort()
    );
    ```

- 用 `page.waitForSelector()` 等待元素，不用固定延时。
- 关闭页面/浏览器时使用 `await page.close()`、`await context.close()`、`await browser.close()`。
- 设置合理的导航和操作超时；失败时回退到列表数据或抛出明确错误。
- Chromium 路径通过 `CHROMIUM_EXECUTABLE_PATH` 配置；远程浏览器可用 `PLAYWRIGHT_CDP_ENDPOINT` 或 `PLAYWRIGHT_WS_ENDPOINT`。

## 媒体

- `enclosure_url` 必须指向可直接下载的媒体文件，`enclosure_type` 使用合法 MIME 类型。
- 视频缩略图使用 `<video poster="...">`，不要额外添加 `<img>`。
- 不要在路由中设置 `referrerpolicy`，RSSHub 中间件会统一处理。

## 安全

- 校验用户可控的 host/URL，避免 SSRF；只允许目标站点域名。
- 不要记录、提交或输出 Cookie、Token、密码等敏感信息。
- 对插入 HTML 的站点内容做必要的清理/转义。
- 私有实例建议设置 `ACCESS_KEY`，不要将私有路由无鉴权暴露到公网。

## 验证

- 语法检查：

    ```bash
    node --check avbase.mjs
    ```

- 动态 import 检查模块导出：

    ```bash
    node -e "import('./southplus.mjs').then((m) => console.log(m.namespace.name, m.routes.length))"
    ```

- 启动 RSSHub 后实际请求路由，确认不是 404，且 feed 中有 item：

    ```bash
    curl -s "http://127.0.0.1:1200/southplus?limit=2" | head
    ```

- 至少验证一个正常参数和一个错误/空参数；确认 `title`、`link`、`pubDate`、`description` 合理。
- 不要为路由编写单元测试；路由通过实际请求和 RSSHub 的自动路由测试验证。

## 部署

- 源码运行：

    ```bash
    cd /path/to/RSSHub
    git clone https://github.com/foreveruand/rsshub-router.git routes-user
    # .env
    # USER_ROUTES_PATH=./routes-user
    systemctl restart rsshub
    ```

- 更新路由：

    ```bash
    cd /path/to/RSSHub/routes-user
    git pull --ff-only
    systemctl restart rsshub
    ```

- 只有升级 RSSHub 主程序或依赖时才需要：

    ```bash
    cd /path/to/RSSHub
    git fetch --depth 1 --no-tags origin master
    git reset --hard origin/master
    pnpm install --frozen-lockfile   # package.json / lockfile 变化时
    USER_ROUTES_PATH= pnpm build
    systemctl restart rsshub
    ```

- Docker 部署时把本仓库挂载到 `/app/routes-user`，设置 `USER_ROUTES_PATH=/app/routes-user`；AVbase 需要带 Chromium 的镜像或提供 `CHROMIUM_EXECUTABLE_PATH`。

## 提交

- 提交前更新根目录 `README.md` 的路由表。
- 一个提交只做一件事；提交信息用英文，例如 `feat(avbase): ...`、`fix(southplus): ...`。
- 不要提交 `.env`、Cookie、Token、日志、`node_modules` 或构建产物。
