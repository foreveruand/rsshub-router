import { load } from 'cheerio';
import dayjs from 'dayjs';
import Parser from 'rss-parser';

const SITE_ORIGIN = 'https://www.south-plus.net';
const DEFAULT_HOSTS = ['www.south-plus.net', 'www.north-plus.net', 'www.east-plus.net', 'www.spring-plus.net', 'www.blue-plus.net'];
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;
const DETAIL_CACHE_MAX_ENTRIES = 500;
const DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_CONCURRENCY = 3;
const DEFAULT_LIMIT = 20;
const LOGIN_WALL_MARKERS = ['本版块为正规版块,只有注册会员才能进入!', '对不起,本版块为认证版块,您没有权限查看此版块的内容!'];

const detailCache = new Map();
const detailInflight = new Map();
const rssParser = new Parser({ customFields: { item: [['pubdate', 'pubdate']] } });

const buildHeaders = () => {
    const headers = {
        // PHPWind encrypts its login cookie with the browser User-Agent.
        'User-Agent': process.env.SOUTHPLUS_UA || process.env.UA || DEFAULT_USER_AGENT,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    const cookie = process.env.SOUTHPLUS_COOKIE;
    if (cookie) {
        headers.Cookie = cookie;
    }
    return headers;
};

const getHosts = () => {
    const configured = process.env.SOUTHPLUS_HOSTS;
    const entries = configured ? configured.split(',') : DEFAULT_HOSTS;
    const hosts = [];

    for (const entry of entries) {
        let host = entry.trim();
        if (!host) {
            continue;
        }
        if (!/^https?:\/\//i.test(host)) {
            host = `https://${host}`;
        }
        host = host.replace(/\/+$/, '');
        if (!hosts.includes(host)) {
            hosts.push(host);
        }
    }

    return hosts.length > 0 ? hosts : DEFAULT_HOSTS.map((host) => `https://${host}`);
};

const isCloudflareChallenge = (text) => {
    const head = text.slice(0, 512);
    if (/<META\s+HTTP-EQUIV=['"]?Refresh/i.test(head)) {
        return true;
    }
    // Valid thread pages also embed __CF$cv$params; only treat it as a challenge outside a full HTML document.
    return text.includes('__CF$cv$params') && !text.includes('<html');
};

const isLoginWall = (text) => LOGIN_WALL_MARKERS.some((marker) => text.includes(marker));

const fetchText = async (url) => {
    const response = await fetch(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (isCloudflareChallenge(text)) {
        throw new Error('Cloudflare challenge');
    }
    return text;
};

const parseSiteDate = (input) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(input.trim());
    if (!match) {
        return undefined;
    }
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}:00+08:00`);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

const parseDate = (input) => {
    if (input === undefined || input === null || input === '') {
        return undefined;
    }
    if (input instanceof Date) {
        return Number.isNaN(input.getTime()) ? undefined : input;
    }
    if (typeof input === 'string') {
        const siteDate = parseSiteDate(input);
        if (siteDate) {
            return siteDate;
        }
    }
    const date = dayjs(input);
    return date.isValid() ? date.toDate() : undefined;
};

const normalizeUrl = (value) => {
    if (!value) {
        return '';
    }
    const url = value.trim();
    if (!url || url.startsWith('javascript:') || url.startsWith('data:')) {
        return '';
    }
    if (url.startsWith('#')) {
        return url;
    }
    if (url.startsWith('//')) {
        return `https:${url}`;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
    }
    try {
        return new URL(url, `${SITE_ORIGIN}/`).href;
    } catch {
        return '';
    }
};

const isSmileyImage = (url) => /\/images\/post\/smile\//i.test(url) || /\/smallface\//i.test(url);

const sanitizeContent = ($, element) => {
    const root = $(element).clone();
    root.find('script, style, iframe, object, embed, form, input, button').remove();

    let image;
    root.find('img').each((index, el) => {
        const $img = $(el);
        const raw = $img.attr('data-original-src') ?? $img.attr('src') ?? '';
        $img.removeAttr('data-original-src');
        const normalized = normalizeUrl(raw);
        if (!normalized) {
            $img.remove();
            return;
        }
        $img.attr('src', normalized);
        if (!image && !isSmileyImage(normalized)) {
            image = normalized;
        }
    });

    root.find('*').each((index, el) => {
        for (const name of Object.keys(el.attribs ?? {})) {
            const lower = name.toLowerCase();
            if (lower.startsWith('on') || lower === 'referrerpolicy' || lower === 'loading') {
                delete el.attribs[name];
                continue;
            }
            if (lower === 'href' || (lower === 'src' && el.name !== 'img')) {
                const normalized = normalizeUrl(el.attribs[name]);
                if (normalized) {
                    el.attribs[name] = normalized;
                } else {
                    delete el.attribs[name];
                }
            }
        }
    });

    const html = root.html();
    return {
        description: html ? html.trim() : '',
        image,
    };
};

const bbcodeToHtml = (text) =>
    text
        .replace(/\[img\]([\s\S]*?)\[\/img\]/gi, '<img src="$1">')
        .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '<a href="$1">$2</a>')
        .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '<a href="$1">$1</a>')
        .replace(/\[\/?[a-z*][^\]]*\]/gi, '')
        .replace(/\r?\n/g, '<br>');

const parseContentHtml = (html) => {
    const $ = load(`<div id="southplus-content">${html}</div>`);
    return sanitizeContent($, $('#southplus-content'));
};

const cleanParentheses = (text) => {
    const match = /^\((.*)\)$/s.exec(text.trim());
    return (match ? match[1] : text).trim();
};

const decodeJsString = (input) => {
    try {
        return JSON.parse(`"${input}"`);
    } catch {
        return input.replaceAll('\\"', '"').replaceAll("\\'", "'").replaceAll('\\\\', '\\');
    }
};

const buildLink = (tid) => `${SITE_ORIGIN}/read.php?tid-${tid}.html`;

const buildNewApiUrl = (host, fid, num) =>
    `${host}/new.php?action=article&fidin=${fid}&pre=0&digest=0&postdate=1&author=1&fname=1&hits=0&replies=1&num=${num}&length=0&order=2&simple=0`;

const parseNewApi = (text) => {
    const html = text
        .split(/\r?\n/)
        .map((line) => {
            const match = /^\s*document\.write\("(.*)"\);?\s*$/.exec(line);
            return match ? decodeJsString(match[1]) : '';
        })
        .join('');

    if (!html.trim()) {
        throw new Error('empty new.php response');
    }

    const $ = load(html);
    const items = [];
    const seen = new Set();

    $('li').each((index, el) => {
        const $row = $(el);
        const anchor = $row.find('a[href*="read.php?tid="]').first();
        const href = anchor.attr('href') ?? '';
        const tidMatch = /tid=(\d+)/.exec(href);
        if (!tidMatch) {
            return;
        }

        const tid = tidMatch[1];
        if (seen.has(tid)) {
            return;
        }
        seen.add(tid);

        const rowHtml = $row.html() ?? '';
        const dateMatch = /\((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)/.exec(rowHtml);
        const authorAnchor = $row.find('a[href*="u.php?action=show"]').first();
        const boardAnchor = $row.find('a[href*="thread.php?fid="]').first();
        const fidMatch = /fid=(\d+)/.exec(boardAnchor.attr('href') ?? '');

        items.push({
            tid,
            title: anchor.text(),
            link: buildLink(tid),
            pubDate: dateMatch ? parseDate(dateMatch[1]) : undefined,
            author: cleanParentheses(authorAnchor.text()),
            categoryName: cleanParentheses(boardAnchor.text()),
            fid: fidMatch ? Number(fidMatch[1]) : undefined,
            description: '',
            image: undefined,
        });
    });

    if (items.length === 0) {
        throw new Error('no items in new.php response');
    }

    return items;
};

const parseThreadHtml = (text, fid) => {
    const $ = load(text);
    const pageTitle = $('title').text();
    const boardName = pageTitle.split(' - ')[0].trim() || `版块 ${fid}`;
    const items = [];
    const seen = new Set();

    $('tr.tr3').each((index, el) => {
        const $row = $(el);
        const anchor = $row.find('h3 a[href*="read.php?tid-"]').first();
        const href = anchor.attr('href') ?? '';
        const tidMatch = /tid-(\d+)/.exec(href);
        if (!tidMatch) {
            return;
        }

        const tid = tidMatch[1];
        if (seen.has(tid)) {
            return;
        }
        seen.add(tid);

        const authorCell = $row.find('td').eq(2);
        const postedDate = authorCell.find('div.gray2').first().text();
        const lastReplyDate = $row.find('td').last().text().trim().split(/\s+/)[0];
        const boardHref = $row.find('a[href*="thread.php?fid-"]').first().attr('href') ?? '';
        const boardMatch = /fid[=-](\d+)/.exec(boardHref);

        items.push({
            tid,
            title: anchor.text(),
            link: buildLink(tid),
            pubDate: parseDate(postedDate || lastReplyDate),
            author: authorCell.find('a.bl').first().text().trim(),
            categoryName: boardName,
            fid: boardMatch ? Number(boardMatch[1]) : fid,
            description: '',
            image: undefined,
        });
    });

    if (items.length === 0) {
        throw new Error('no items in thread.php response');
    }

    items.sort((a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0));
    return items;
};

const parseRss = async (text, fallbackFid) => {
    if (!text.trimStart().startsWith('<?xml')) {
        throw new Error('response is not XML');
    }

    const feed = await rssParser.parseString(text);
    const feedItems = Array.isArray(feed.items) ? feed.items : [];
    if (feedItems.length === 0) {
        throw new Error('RSS feed has no items');
    }

    const items = [];
    const seen = new Set();

    for (const item of feedItems) {
        const tidMatch = /tid[=-](\d+)/.exec(item.link ?? '');
        if (!tidMatch) {
            continue;
        }
        const tid = tidMatch[1];
        if (seen.has(tid)) {
            continue;
        }
        seen.add(tid);

        const content = parseContentHtml(bbcodeToHtml(item.content ?? item.contentSnippet ?? item.description ?? ''));
        items.push({
            tid,
            title: item.title ?? '',
            link: buildLink(tid),
            pubDate: parseDate(item.pubdate ?? item.pubDate ?? item.isoDate),
            author: item.creator ?? item.author ?? '',
            categoryName: item.categories?.[0] ?? item.category ?? '',
            fid: fallbackFid,
            description: content.description,
            image: content.image,
        });
    }

    if (items.length === 0) {
        throw new Error('RSS feed has no usable items');
    }

    items.sort((a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0));
    return items;
};

const collectItems = async (fid, limit) => {
    const hosts = getHosts();
    const num = Math.min(limit * 2, 200);
    const errors = [];

    for (const host of hosts) {
        try {
            const items = parseNewApi(await fetchText(buildNewApiUrl(host, fid, num)));
            return { items: items.slice(0, limit), source: 'new.php', host };
        } catch (error) {
            errors.push(`${host} new.php: ${error.message}`);
        }
    }

    if (fid > 0) {
        for (const host of hosts) {
            try {
                const text = await fetchText(`${host}/thread.php?fid-${fid}.html`);
                if (isLoginWall(text)) {
                    throw new Error('login required');
                }
                return { items: parseThreadHtml(text, fid).slice(0, limit), source: 'thread.php', host };
            } catch (error) {
                errors.push(`${host} thread.php: ${error.message}`);
            }
        }
    }

    for (const host of hosts) {
        try {
            const rssPath = fid > 0 ? `/rss.php?fid=${fid}` : '/rss.php';
            const items = await parseRss(await fetchText(`${host}${rssPath}`), fid);
            return { items: items.slice(0, limit), source: 'rss.php', host };
        } catch (error) {
            errors.push(`${host} rss.php: ${error.message}`);
        }
    }

    throw new Error(`Failed to fetch South Plus feed: ${errors.slice(-6).join('; ')}`);
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
    if (detailCache.has(key)) {
        detailCache.delete(key);
    } else if (detailCache.size >= DETAIL_CACHE_MAX_ENTRIES) {
        const oldestKey = detailCache.keys().next().value;
        if (oldestKey !== undefined) {
            detailCache.delete(oldestKey);
        }
    }
    detailCache.set(key, {
        data,
        expires: Date.now() + DETAIL_CACHE_TTL_MS,
    });
};

const fetchDetail = async (tid) => {
    try {
        const text = await fetchText(buildLink(tid));
        if (isLoginWall(text)) {
            return { status: 'login-wall' };
        }

        const $ = load(text);
        const contentElement = $('#read_tpc').first();
        if (contentElement.length === 0) {
            return { status: 'failed', reason: 'content not found' };
        }

        const content = sanitizeContent($, contentElement);
        const fidValue = $('input[name="fid"]').attr('value');
        const fidMatch = /^(\d+)$/.exec(fidValue ?? '');
        const author = $('.tiptop').first().find('a[href*="u.php"]').first().text().trim();

        return {
            status: 'ok',
            title: $('h1#subject_tpc').text().trim(),
            author: author || undefined,
            pubDate: parseDate($('.tiptop').first().find('span.fl.gray').first().text()),
            fid: fidMatch ? Number(fidMatch[1]) : undefined,
            description: content.description,
            image: content.image,
        };
    } catch (error) {
        return { status: 'failed', reason: error.message };
    }
};

const getDetail = async (tid) => {
    const cached = cacheGet(tid);
    if (cached !== undefined) {
        return cached;
    }

    const inflight = detailInflight.get(tid);
    if (inflight) {
        return inflight;
    }

    const promise = fetchDetail(tid)
        .then((detail) => {
            if (detail.status !== 'failed') {
                cacheSet(tid, detail);
            }
            return detail;
        })
        .finally(() => {
            detailInflight.delete(tid);
        });

    detailInflight.set(tid, promise);
    return promise;
};

const runWithConcurrency = async (tasks, concurrency, worker) => {
    const results = new Array(tasks.length);
    let nextIndex = 0;

    const runners = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (nextIndex < tasks.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(tasks[index], index);
        }
    });

    await Promise.all(runners);
    return results;
};

const buildItem = async (baseItem, blockedFids) => {
    const fid = baseItem.fid;
    const canLoadDetail = fid === undefined || !blockedFids.has(fid);
    let detail;

    if (canLoadDetail) {
        detail = await getDetail(baseItem.tid);
        if (detail.status === 'login-wall' && fid !== undefined && fid > 0) {
            blockedFids.add(fid);
        }
    }

    const detailOk = detail?.status === 'ok';
    const description = detailOk && detail.description ? detail.description : baseItem.description;
    const image = (detailOk ? detail.image : undefined) ?? baseItem.image;

    return {
        title: baseItem.title || (detailOk ? detail.title : ''),
        link: baseItem.link,
        pubDate: baseItem.pubDate ?? (detailOk ? detail.pubDate : undefined),
        author: baseItem.author || (detailOk ? detail.author : '') || '',
        category: baseItem.categoryName ? [baseItem.categoryName] : [],
        description: description || '',
        image,
    };
};

const processItems = async (ctx) => {
    const category = ctx.req.param('category') ?? '';
    if (category && !/^\d+$/.test(category)) {
        throw new Error('Invalid category: expected a numeric forum id (for example 128)');
    }

    const fid = category ? Number(category) : 0;
    const requestedLimit = Number.parseInt(ctx.req.query('limit'), 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT;

    const { items: baseItems } = await collectItems(fid, limit);
    const blockedFids = new Set();
    const items = await runWithConcurrency(baseItems, DETAIL_CONCURRENCY, (baseItem) => buildItem(baseItem, blockedFids));
    const boardName = fid > 0 ? baseItems.find((item) => item.categoryName)?.categoryName : undefined;

    return {
        title: `South Plus - ${boardName || (fid > 0 ? `版块 ${fid}` : '全部')}`,
        link: fid > 0 ? `${SITE_ORIGIN}/thread.php?fid-${fid}.html` : `${SITE_ORIGIN}/`,
        item: items,
    };
};

export const namespace = {
    name: 'South Plus',
    url: 'www.south-plus.net',
    lang: 'zh',
    description: `::: tip
官方 RSS 已失效，改用站内 new.php 主来源 + 版块 HTML + 官方 RSS 三级兜底；无 Cookie 时私有版块只有标题与链接；可设置 SOUTHPLUS_COOKIE 获取正文。
:::`,
};

export const routes = [
    {
        path: '/:category?',
        categories: ['multimedia'],
        example: '/southplus/128',
        parameters: {
            category: '版块 ID（从版块 URL 的 fid 获取，如 128）',
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
        name: '最新主题',
        maintainers: ['cj'],
        url: 'www.south-plus.net',
        description: 'South Plus 最新主题（new.php 主来源，HTML + 官方 RSS 兜底）',
        handler: processItems,
    },
];
