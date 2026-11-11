import { load } from 'cheerio';
import dayjs from 'dayjs';

const defaultDomain = 'https://www.pornhub.com';
const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const languagePattern = /^[a-z]{2,8}$/;

const headers = {
    accessAgeDisclaimerPH: '1',
    hasVisited: '1',
    'User-Agent': process.env.UA || defaultUserAgent,
    Cookie: 'accessAgeDisclaimerPH=1; hasVisited=1',
};

const escapeAttribute = (value) =>
    String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');

const renderDescription = (data, showImages = false) => {
    const parts = [];

    if (data.previewVideo) {
        parts.push(`<video controls preload="metadata" poster="${escapeAttribute(data.poster)}"><source src="${escapeAttribute(data.previewVideo)}" type="video/webm"></video>`);
    } else {
        parts.push(`<img src="${escapeAttribute(data.poster)}">`);
    }

    if (showImages) {
        parts.push(Array.isArray(data.thumbs) ? data.thumbs.map((thumb) => `<img src="${escapeAttribute(thumb.src)}">`).join('') : `<img src="${escapeAttribute(data.poster)}">`);
    }

    return parts.join('');
};

const parsePublishDate = (thumbnailUrl) => {
    if (typeof thumbnailUrl !== 'string') {
        return undefined;
    }

    const match = thumbnailUrl.match(/(\d{6})\/(\d{2})/);
    if (!match) {
        return undefined;
    }

    const [, yearMonth, day] = match;
    const date = dayjs(`${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}-${day}`);
    return date.isValid() ? date.toDate() : undefined;
};

const getThumbnail = (e) => {
    const image = e.find('img').first();
    const thumbnail = image.data('mediumthumb') || image.data('image');
    return typeof thumbnail === 'string' && thumbnail ? thumbnail : undefined;
};

const parseItems = (e, showImages = false) => {
    const thumbnail = getThumbnail(e);

    return {
        title: e.find('span.title a').text(),
        link: defaultDomain + e.find('span.title a').attr('href'),
        description: renderDescription(
            {
                poster: thumbnail,
                previewVideo: e.find('img').data('mediabook'),
            },
            showImages
        ),
        author: e.find('.usernameWrap a').text(),
        pubDate: parsePublishDate(thumbnail),
    };
};

export const namespace = {
    name: 'PornHub Search (HTML)',
    url: 'pornhub.com',
    lang: 'en',
};

export const routes = [
    {
        path: '/search_url/:keyword/:language?',
        categories: ['multimedia'],
        example: '/pornhub-search/search_url/stepsister/cn',
        parameters: {
            keyword: '搜索关键词',
            language: '语言代码，默认 www，可选 cn, jp 等',
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
        name: 'Keyword Search (HTML)',
        maintainers: ['nczitzk', 'I2IMk'],
        handler: async (ctx) => {
            const { keyword, language = 'www' } = ctx.req.param();

            if (!languagePattern.test(language)) {
                throw new Error('Invalid language');
            }

            const link = `https://${language}.pornhub.com/video/search?search=${encodeURIComponent(keyword)}`;

            const response = await fetch(link, { headers });
            if (!response.ok) {
                throw new Error(`Failed to fetch Pornhub search: ${response.status} ${response.statusText}`);
            }

            const $ = load(await response.text());

            const items = $('#videoSearchResult .videoBox, #videoCategory .videoBox')
                .toArray()
                .map((e) => parseItems($(e)));

            return {
                title: `Pornhub Search - ${keyword}`,
                link,
                language: $('html').attr('lang') || 'en',
                item: items,
            };
        },
    },
];
