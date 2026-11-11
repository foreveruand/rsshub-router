import { load } from 'cheerio';
import dayjs from 'dayjs';
import pMap from 'p-map';
import { chromium } from 'patchright';

const allowDomain = new Set(['avbase.net', 'www.avbase.net']);
const browserCloseTimeout = 90000;
const browserNavigationTimeout = 45000;
const detailConcurrency = 1;
const allowedResourceTypes = new Set(['document', 'script', 'xhr', 'fetch', 'other']);
const cacheMaxEntries = 200;
const cacheTtlMs = 24 * 60 * 60 * 1000;
const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'];

let browserQueue = Promise.resolve();

const detailCache = new Map();

const parseDate = (input) => {
    if (input === undefined || input === null || input === '') {
        return undefined;
    }

    const date = dayjs(input);
    return date.isValid() ? date.toDate() : undefined;
};

const cacheGet = (key) => {
    const entry = detailCache.get(key);
    if (!entry) {
        return undefined;
    }
    if (entry.expires <= Date.now()) {
        detailCache.delete(key);
        return undefined;
    }
    return entry.data;
};

const cacheSet = (key, data) => {
    if (detailCache.size >= cacheMaxEntries) {
        const oldestKey = detailCache.keys().next().value;
        if (oldestKey !== undefined) {
            detailCache.delete(oldestKey);
        }
    }
    detailCache.set(key, {
        data,
        expires: Date.now() + cacheTtlMs,
    });
};

const cacheTryGet = async (key, loader) => {
    const cached = cacheGet(key);
    if (cached !== undefined) {
        return cached;
    }

    const data = await loader();
    cacheSet(key, data);
    return data;
};

const parseCookies = (raw, hostname) =>
    raw
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .map((item) => {
            const equalIndex = item.indexOf('=');
            if (equalIndex <= 0) {
                return undefined;
            }

            return {
                name: item.slice(0, equalIndex).trim(),
                value: item.slice(equalIndex + 1).trim(),
                domain: hostname,
            };
        })
        .filter((item) => item !== undefined);

const getBrowserlessEndpoint = (endpoint) => {
    const endpointUrl = new URL(endpoint);
    endpointUrl.searchParams.set('launch', JSON.stringify({ headless: true, args: launchArgs }));
    return endpointUrl.href;
};

const launchBrowser = async () => {
    if (process.env.PLAYWRIGHT_CDP_ENDPOINT) {
        return chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_ENDPOINT);
    }

    if (process.env.PLAYWRIGHT_WS_ENDPOINT) {
        return chromium.connect(getBrowserlessEndpoint(process.env.PLAYWRIGHT_WS_ENDPOINT));
    }

    return chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        args: launchArgs,
    });
};

const getPlaywrightPage = async (
    url,
    {
        closeTimeout = browserCloseTimeout,
        gotoConfig,
        noGoto = false,
        onBeforeLoad,
    } = {}
) => {
    const browser = await launchBrowser();
    const closeTimer =
        closeTimeout === 0
            ? undefined
            : setTimeout(() => {
                  void browser.close();
              }, closeTimeout);

    const destroy = async () => {
        clearTimeout(closeTimer);
        await browser.close();
    };

    try {
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            userAgent: process.env.UA || defaultUserAgent,
        });
        const page = await context.newPage();

        if (onBeforeLoad) {
            await onBeforeLoad(page, context);
        }

        if (!noGoto) {
            await page.goto(url, gotoConfig || { waitUntil: 'domcontentloaded' });
        }

        return { browser, context, page, destroy };
    } catch (error) {
        await destroy();
        throw error;
    }
};

const applyCookies = async (context, hostname) => {
    const raw = process.env.AVBASE_COOKIES;
    if (!raw) {
        return;
    }

    const cookies = parseCookies(raw, hostname);
    if (cookies.length > 0) {
        await context.addCookies(cookies);
    }
};

const withBrowserGate = async (task) => {
    const previousTask = browserQueue;
    const { promise: nextTask, resolve: releaseQueue } = Promise.withResolvers();
    browserQueue = nextTask;

    await previousTask;

    try {
        return await task();
    } finally {
        releaseQueue();
    }
};

const setupPage = async (page, hostname) => {
    page.setDefaultNavigationTimeout(browserNavigationTimeout);
    page.setDefaultTimeout(browserNavigationTimeout);
    await page.route('**/*', (route) => {
        allowedResourceTypes.has(route.request().resourceType()) ? route.continue() : route.abort();
    });

    await applyCookies(page.context(), hostname);
};

const isRetryableError = (error) =>
    error instanceof Error &&
    (error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target page, context or browser has been closed') ||
        error.message.includes('frame was detached') ||
        error.message.includes('net::ERR_ABORTED') ||
        error.message.includes('Navigation failed because page was closed'));

const runPageSession = async (url, hostname, runner, noGoto = false) => {
    let session;
    try {
        session = await getPlaywrightPage(url, {
            closeTimeout: browserCloseTimeout,
            gotoConfig: {
                timeout: browserNavigationTimeout,
                waitUntil: 'domcontentloaded',
            },
            noGoto,
            onBeforeLoad: (page) => setupPage(page, hostname),
        });
        console.debug(`Requesting ${url}`);
        return await runner(session.page);
    } finally {
        if (session) {
            await session.destroy();
        }
    }
};

const withPage = (url, hostname, runner, noGoto = false) =>
    withBrowserGate(async () => {
        try {
            return await runPageSession(url, hostname, runner, noGoto);
        } catch (error) {
            if (isRetryableError(error)) {
                console.warn(`Retrying AVBASE page request for ${url}: ${error.message}`);
                return runPageSession(url, hostname, runner, noGoto);
            }
            throw error;
        }
    });

const waitForCloudflare = async (page, url) => {
    try {
        await page.waitForFunction(() => document.title !== 'Just a moment...', undefined, { timeout: 12000 });
    } catch {
        console.debug(`Cloudflare challenge may still be active for ${url}`);
    }
};

const waitForKnownSelector = async (page, selector, url, type) => {
    try {
        await page.waitForSelector(selector, { timeout: 12000 });
    } catch {
        console.debug(`No known AVBASE ${type} selectors found for ${url}`);
    }
};

const reservedWorkPaths = new Set(['date', 'recent', 'ranking', 'new', 'recommend', 'popular']);

const getWorkHref = (href) => {
    if (typeof href !== 'string' || !href.startsWith('/works/')) {
        return undefined;
    }

    const [firstSegment] = href.slice('/works/'.length).split('/');
    if (!firstSegment || reservedWorkPaths.has(firstSegment)) {
        return undefined;
    }

    return href;
};

// Work cards currently live under div.relative, but keep the old generic container
// as a fallback so a minor markup change does not empty the feed.
const extractItems = ($, rootUrl, limit) => {
    const workItems = new Map();

    $('a[href^="/works/"]').each((_, el) => {
        if (workItems.size >= limit) {
            return false;
        }

        const anchor = $(el);
        const href = getWorkHref(anchor.attr('href'));
        const titleText = anchor.text().trim();

        if (!href || !titleText) {
            return;
        }

        const link = new URL(href, rootUrl).href;
        if (workItems.has(link)) {
            return;
        }

        const card = anchor.closest('div.relative');
        const container = card.length > 0 ? card : anchor.closest('li,article,section,div,tr');
        const id = container.find('.font-bold.text-gray-500').first().text().trim() || href.split('/').findLast(Boolean) || '';
        const cover = container.find('.w-28 img').first().attr('src') ?? container.find('img[src*="pics.dmm.co.jp"]').first().attr('src');
        const dateText = container.find('a[href^="/works/date/"]').first().text().trim();
        const actors = container
            .find('a[href^="/talents/"]')
            .toArray()
            .map((actor) => $(actor).text().trim())
            .filter((name) => !!name && !name.startsWith('他 '));

        workItems.set(link, {
            id,
            titleText,
            link,
            cover,
            pubDate: dateText ? parseDate(dateText) : undefined,
            actors,
        });
    });

    return [...workItems.values()];
};

const buildFallbackItem = (item) => ({
    title: `${item.id} - ${item.titleText}`,
    link: item.link,
    pubDate: item.pubDate,
    author: item.actors.join(', '),
    ...(item.cover && {
        enclosure_url: item.cover,
        enclosure_type: 'image/jpeg',
        description: `<div><strong>封面:</strong><br><img src="${item.cover}" style="max-width:300px;"></div>`,
    }),
});

const fetchDetailItem = async (page, item) => {
    await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: browserNavigationTimeout });
    await waitForCloudflare(page, item.link);
    await waitForKnownSelector(page, '#magnets-content, .bg-base-100, .chip, dt, img[src*="pl.jpg"]', item.link, 'detail');

    const detailHtml = await page.content();
    const content = load(detailHtml);

    const magnet = content('button[data-clipboard-text]').first().attr('data-clipboard-text');
    const releaseDate = content('dt')
        .filter((_, el) => content(el).text().trim() === '発売日')
        .next('dd')
        .text()
        .trim();
    const coverImg = content('img[src*="pl.jpg"]').first().attr('src') ?? content('img[class*="max-h-"]').first().attr('src');
    const screenshots = content('img[src*="jp-"]')
        .toArray()
        .map((el) => content(el).attr('src'))
        .filter((src) => src !== undefined && src !== '');
    const actorsList = [
        ...new Map(
            content('a[href^="/talents/"]')
                .toArray()
                .map((el) => {
                    const actor = content(el);
                    return [
                        actor.text().trim(),
                        {
                            name: actor.text().trim(),
                            avatar: actor.find('img').attr('src'),
                        },
                    ];
                })
                .filter(([name]) => name !== '')
        ).values(),
    ];
    const tags = content('a[href^="/tags/"]')
        .toArray()
        .map((el) => content(el).text().trim())
        .filter((tag) => tag !== '');

    const descriptionParts = [];
    if (coverImg) {
        descriptionParts.push(`<div><strong>封面:</strong><br><img src="${coverImg}" style="max-width:300px;"></div>`);
    }
    if (releaseDate) {
        descriptionParts.push(`<div><strong>发售日:</strong> ${releaseDate}</div>`);
    }
    if (screenshots.length > 0) {
        descriptionParts.push(`<div><strong>剧照:</strong><br>${screenshots.map((src) => `<img src="${src}" style="max-width:120px;margin:2px;">`).join('')}</div>`);
    }
    if (tags.length > 0) {
        descriptionParts.push(`<div><strong>标签:</strong> ${tags.join(', ')}</div>`);
    }
    if (actorsList.length > 0) {
        descriptionParts.push(
            `<div><strong>演员:</strong> ${actorsList
                .map((actor) => `<img src="${actor.avatar}" alt="${actor.name}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${actor.name}`)
                .join(', ')}</div>`
        );
    }

    return {
        title: `${item.id} - ${item.titleText}`,
        link: item.link,
        pubDate: item.pubDate,
        author: item.actors.join(', '),
        ...(magnet && {
            enclosure_url: magnet,
            enclosure_type: 'application/x-bittorrent',
        }),
        ...(descriptionParts.length > 0 && {
            description: descriptionParts.join(''),
        }),
    };
};

const fetchDetails = (items, hostname) =>
    withPage(
        'about:blank',
        hostname,
        async (page) =>
            new Map(
                await pMap(
                    items,
                    async (item) => {
                        try {
                            const detail = await cacheTryGet(item.link, () => fetchDetailItem(page, item));
                            return [item.link, detail];
                        } catch (error) {
                            if (error instanceof Error && error.name === 'TimeoutError') {
                                console.warn(`Timeout for ${item.link}, falling back to list data`);
                                return [item.link, null];
                            }
                            throw error;
                        }
                    },
                    { concurrency: detailConcurrency }
                )
            ),
        true
    );

const processItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'avbase.net';
    const url = new URL(currentUrl, `https://${domain}`);

    const allowUnsafeDomain = process.env.ALLOW_USER_SUPPLY_UNSAFE_DOMAIN === 'true' || process.env.ALLOW_USER_SUPPLY_UNSAFE_DOMAIN === '1';
    if (!allowUnsafeDomain && !allowDomain.has(url.hostname)) {
        throw new Error("This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.");
    }

    const rootUrl = `https://${domain}`;

    const { htmlTitle, items } = await withPage(url.href, url.hostname, async (page) => {
        await waitForCloudflare(page, url.href);
        await waitForKnownSelector(page, 'div.relative, a[href^="/works/"]', url.href, 'list');

        const listHtml = await page.content();
        const $ = load(listHtml);
        const htmlTitle = $('title').text();
        const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20;

        return { htmlTitle, items: extractItems($, rootUrl, limit) };
    });

    const detailMap = items.length > 0 ? await fetchDetails(items, url.hostname) : new Map();
    const processedItems = items.map((item) => detailMap.get(item.link) ?? buildFallbackItem(item));

    const subject = htmlTitle.includes('|') ? htmlTitle.split('|', 1)[0].trim() : '';
    return {
        title: subject === '' ? title : `${subject} - ${title}`,
        link: url.href,
        item: processedItems,
    };
};

export const namespace = {
    name: 'AVbase',
    url: 'www.avbase.net',
    description: `::: tip
你可以通过指定 \`limit\` 参数来获取特定数量的条目，即可以通过在路由后方加上 \`?limit=25\`，默认为单次获取 20 个条目，即默认 \`?limit=20\`

因为该站有反爬检测，所以不应将此值调整过高
:::`,
    lang: 'ja',
};

export const routes = [
    {
        path: '/actors/:name',
        categories: ['multimedia'],
        example: '/avbase/actors/美乃すずめ',
        parameters: { name: '演员名（日文）' },
        features: {
            requireConfig: [
                {
                    name: 'AVBASE_COOKIES',
                    description: 'AVBASE登陆后的COOKIE',
                    optional: true,
                },
            ],
            requirePuppeteer: true,
            antiCrawler: true,
            supportBT: false,
            supportPodcast: false,
            supportScihub: false,
            nsfw: true,
        },
        radar: [
            {
                source: ['avbase.net/'],
                target: '',
            },
        ],
        name: '演員',
        maintainers: ['cj'],
        url: 'www.avbase.net/',
        handler: async (ctx) => {
            const name = ctx.req.param('name');
            const currentUrl = `/talents/${encodeURIComponent(name)}`;
            const title = `AVBASE - ${name}`;
            return await processItems(ctx, currentUrl, title);
        },
    },
];
