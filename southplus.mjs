import { load } from 'cheerio';
import dayjs from 'dayjs';
import Parser from 'rss-parser';

const RSS_URL = 'https://www.south-plus.net/rss.php';
const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const cacheMaxEntries = 200;
const cacheTtlMs = 24 * 60 * 60 * 1000;

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

const extractImages = (desc) => {
    const regex = /\[img\](.*?)\[\/img\]/gi;
    const images = [];
    let match;
    while ((match = regex.exec(desc)) !== null) {
        images.push(match[1]);
    }
    return images;
};

const cleanContent = (desc) =>
    desc
        .replaceAll(/\[img\].*?\[\/img\]/gi, '')
        .replaceAll(/\[\/?.*?\]/g, '')
        .trim();

const formatReleaseDate = (date) => {
    if (!date) {
        return undefined;
    }

    const parsedDate = parseDate(date);
    if (!parsedDate) {
        return undefined;
    }

    return parsedDate.toISOString().split('T', 1)[0];
};

const fetchCoverFromPage = async (url) => {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': process.env.UA || defaultUserAgent,
            },
        });
        if (!response.ok) {
            return '';
        }
        const $ = load(await response.text());
        return $('img').first().attr('src') ?? '';
    } catch {
        return '';
    }
};

const processItems = async (ctx, category, title) => {
    const url = category ? `${RSS_URL}?fid=${category}` : RSS_URL;
    const response = await fetch(url, {
        headers: {
            'User-Agent': process.env.UA || defaultUserAgent,
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch South Plus RSS: ${response.status} ${response.statusText}`);
    }

    const parser = new Parser();
    const parsed = await parser.parseString(await response.text());
    let items = parsed.items || [];

    if (!Array.isArray(items)) {
        items = [items];
    }

    const limit = ctx.req.query('limit') ? Number(ctx.req.query('limit')) : 20;
    items = items.slice(0, limit);

    const result = await Promise.all(
        items.map((item) => {
            const articleUrl = new URL(item.link ?? '', RSS_URL);
            articleUrl.hostname = 'www.south-plus.net';
            const link = articleUrl.href;
            const raw = item.content ?? item.contentSnippet ?? item.description ?? '';
            const images = extractImages(raw);
            const cover = images[0] || '';

            const normalizedItem = {
                title: item.title ?? '',
                link,
                pubDate: item.pubDate ?? item.isoDate,
                author: item.creator ?? item.author ?? '',
                category: item.categories ?? item.category,
                _raw: raw,
                _cover: cover,
            };

            return cacheTryGet(normalizedItem.link, async () => {
                let coverImg = normalizedItem._cover;

                // No image in the description, try the post page for a cover.
                if (!coverImg && normalizedItem.link) {
                    coverImg = await fetchCoverFromPage(normalizedItem.link);
                }

                const tags = normalizedItem.category === undefined ? [] : Array.isArray(normalizedItem.category) ? normalizedItem.category : [normalizedItem.category];
                const releaseDate = formatReleaseDate(normalizedItem.pubDate);
                const contentText = cleanContent(normalizedItem._raw || '');

                normalizedItem.image = coverImg || undefined;
                normalizedItem.category = tags;
                normalizedItem.description =
                    `<div><strong>封面:</strong><br>${coverImg ? `<img src="${coverImg}" style="max-width:300px;">` : '无'}</div>` +
                    `<div><strong>发帖日期:</strong> ${releaseDate ?? '未知'}</div>` +
                    `<div><strong>版块:</strong> ${tags.join(', ')}</div>` +
                    '<hr>' +
                    `<pre>${contentText || '无内容'}</pre>`;

                delete normalizedItem._raw;
                delete normalizedItem._cover;

                return normalizedItem;
            });
        })
    );

    return {
        title: title || `South Plus - ${category || '全部'}`,
        link: url,
        item: result,
    };
};

export const namespace = {
    name: 'South Plus',
    url: 'www.south-plus.net',
    lang: 'zh',
    description: `::: tip
South Plus 原 RSS 进行结构化处理：

- 自动提取封面
- BBCode 转 HTML
- 分类过滤
- 协议补全

:::

::: tip
支持分类过滤，如：
\`/southplus/201\`
\`/southplus/128\`
:::`,
};

export const routes = [
    {
        path: '/:category?',
        categories: ['multimedia'],
        example: '/southplus/128',
        parameters: {
            category: '分类名（从各板块URL获取）',
        },
        features: {
            requireConfig: false,
            requirePuppeteer: false,
            antiCrawler: true,
            supportBT: false,
            supportPodcast: false,
            supportScihub: false,
            nsfw: true,
        },
        name: 'South Plus路由',
        maintainers: ['cj'],
        url: 'www.south-plus.net',
        description: '将 South Plus 官方 RSS 重构为结构化 RSS',
        handler: async (ctx) => {
            const category = ctx.req.param('category') ?? '';
            const title = `South Plus - ${category || '全部'}`;
            return await processItems(ctx, category, title);
        },
    },
];
