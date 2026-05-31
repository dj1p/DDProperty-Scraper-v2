/**
 * DDProperty.com Scraper
 * Builds search URL from structured input fields.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { createPlaywrightRouter } from 'crawlee';

const LABEL_LISTING_PAGE = 'LISTING_PAGE';
const LABEL_DETAIL_PAGE  = 'DETAIL_PAGE';

await Actor.init();

// ── Input ─────────────────────────────────────────────────────────────────────
const input = await Actor.getInput() ?? {};

const {
    listingType      = 'rent',
    regionCode       = 'TH10',
    bedrooms         = [],
    minPrice         = 0,
    maxPrice         = 0,
    minSize          = 0,
    maxSize          = 0,
    propertyType     = '',
    distanceToMRT    = 0,
    freetext         = '',
    isCommercial     = false,
    maxListings      = 100,
    maxConcurrency   = 3,
    proxyConfiguration: proxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

// ── Build search URL from fields ──────────────────────────────────────────────
function buildSearchUrl() {
    const base = `https://www.ddproperty.com/en/property-for-${listingType}`;
    const params = new URLSearchParams();

    params.set('listingType', listingType);
    params.set('isCommercial', String(isCommercial));
    params.set('page', '1');

    if (regionCode)    params.set('regionCode', regionCode);
    if (minPrice > 0)  params.set('minPrice', String(minPrice));
    if (maxPrice > 0)  params.set('maxPrice', String(maxPrice));
    if (minSize > 0)   params.set('minSize', String(minSize));
    if (maxSize > 0)   params.set('maxSize', String(maxSize));
    if (propertyType)  params.set('propertyType', propertyType);
    if (distanceToMRT > 0) params.set('distanceToMRT', String(distanceToMRT));
    if (freetext)      params.set('_freetextDisplay', freetext);

    // Bedrooms: DDProperty uses repeated params (?bedrooms=2&bedrooms=3)
    for (const b of bedrooms) {
        params.append('bedrooms', String(b));
    }

    return `${base}?${params.toString()}`;
}

// ── Decide which URLs to use ──────────────────────────────────────────────────
let initialRequests;

if (startUrls && startUrls.length > 0) {
    // Use provided URLs directly
    initialRequests = startUrls.map((item) => ({
        url: typeof item === 'string' ? item : item.url,
        label: LABEL_LISTING_PAGE,
    }));
    log.info(`Using ${initialRequests.length} provided URL(s)`, { urls: initialRequests.map((r) => r.url) });
} else {
    // Build URL from filter fields
    const builtUrl = buildSearchUrl();
    initialRequests = [{ url: builtUrl, label: LABEL_LISTING_PAGE }];
    log.info('No startUrls provided — built search URL from filters', { url: builtUrl });
}

// ── Proxy ─────────────────────────────────────────────────────────────────────
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

// ── Tracking ──────────────────────────────────────────────────────────────────
let listingsScraped = 0;

// ── Router ────────────────────────────────────────────────────────────────────
const router = createPlaywrightRouter();

router.addHandler(LABEL_LISTING_PAGE, async ({ page, request, crawler }) => {
    log.info(`Scraping listing page: ${request.url}`);

    await page.waitForSelector(
        '[data-testid="listing-card-container"], .listing-item, article[class*="listing"]',
        { timeout: 30_000 }
    ).catch(() => log.warning('Listing card selector timed out'));

    // Collect detail page links
    const links = await page.$$eval(
        'a[data-testid="listing-card-link"], [class*="PropertyCard"] a, .listing-result a',
        (anchors) => [...new Set(anchors.map((a) => a.href).filter(Boolean))]
    );

    log.info(`Found ${links.length} listing links`);

    for (const url of links) {
        if (maxListings > 0 && listingsScraped >= maxListings) break;
        await crawler.addRequests([{ url, label: LABEL_DETAIL_PAGE }]);
    }

    // ── Pagination ────────────────────────────────────────────────────────────
    if (maxListings === 0 || listingsScraped < maxListings) {
        const currentUrl   = new URL(request.url);
        const currentPage  = parseInt(currentUrl.searchParams.get('page') ?? '1', 10);

        const hasNext = await page.$$eval(
            'a[aria-label="Next page"], a[data-testid="pagination-next"], .pagination__next:not(.disabled)',
            (els) => els.length > 0
        );

        if (hasNext) {
            currentUrl.searchParams.set('page', String(currentPage + 1));
            log.info(`Queuing page ${currentPage + 1}`);
            await crawler.addRequests([{ url: currentUrl.toString(), label: LABEL_LISTING_PAGE }]);
        }
    }
});

router.addHandler(LABEL_DETAIL_PAGE, async ({ page, request }) => {
    if (maxListings > 0 && listingsScraped >= maxListings) return;

    log.info(`Scraping detail: ${request.url}`);

    await page.waitForSelector('h1, [data-testid="listing-title"]', { timeout: 30_000 }).catch(() => {});

    const data = await page.evaluate(() => {
        const getText = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;

        const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
            .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
            .filter(Boolean)
            .find((d) => d['@type'] === 'RealEstateListing' || d.name);

        return {
            title:        getText('h1') ?? getText('[data-testid="listing-title"]'),
            priceRaw:     getText('[data-testid="price-value"]') ?? getText('.price__value') ?? getText('[class*="price"]'),
            address:      getText('[data-testid="listing-location"]') ?? getText('.address__text'),
            propertyType: getText('[data-testid="property-type"]') ?? getText('[class*="propertyType"]'),
            bedroomsRaw:  getText('[data-testid="beds"]') ?? getText('[aria-label*="bedroom"]'),
            bathroomsRaw: getText('[data-testid="baths"]') ?? getText('[aria-label*="bathroom"]'),
            sizeRaw:      getText('[data-testid="floor-size"]') ?? getText('[class*="floorSize"]'),
            floorRaw:     getText('[data-testid="floor-level"]'),
            description:  getText('[data-testid="listing-description"]') ?? getText('.description__text'),
            agentName:    getText('[data-testid="agent-name"]') ?? getText('[class*="agentName"]'),
            images:       Array.from(document.querySelectorAll('[data-testid="gallery-image"] img, .gallery__image img'))
                              .map((img) => img.src || img.dataset.src).filter(Boolean).slice(0, 10),
            facilities:   Array.from(document.querySelectorAll('[data-testid="facility-item"], [class*="facility"] span'))
                              .map((el) => el.textContent?.trim()).filter(Boolean),
            listingId:    document.querySelector('[data-testid="listing-id"]')?.textContent?.trim()
                          ?? window.location.pathname.match(/\d{5,}$/)?.[0] ?? null,
            jsonLd,
        };
    });

    const toNum = (raw) => {
        if (!raw) return null;
        const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
        return isNaN(n) ? null : n;
    };

    const listing = {
        url:          request.url,
        listingId:    data.listingId,
        title:        data.title,
        priceThb:     toNum(data.priceRaw),
        priceDisplay: data.priceRaw,
        address:      data.address,
        propertyType: data.propertyType,
        bedrooms:     toNum(data.bedroomsRaw),
        bathrooms:    toNum(data.bathroomsRaw),
        sizeSqm:      toNum(data.sizeRaw),
        sizeDisplay:  data.sizeRaw,
        floor:        data.floorRaw,
        description:  data.description,
        agentName:    data.agentName,
        images:       data.images,
        facilities:   data.facilities,
        scrapedAt:    new Date().toISOString(),
    };

    if (!listing.title && !listing.priceThb) {
        log.warning(`Empty listing at ${request.url} — possible block, skipping`);
        return;
    }

    await Dataset.pushData(listing);
    listingsScraped++;
    log.info(`Saved #${listingsScraped}: ${listing.title ?? request.url}`);
});

router.addDefaultHandler(async ({ request, enqueueLinks }) => {
    log.info(`Default handler for: ${request.url}`);
    await enqueueLinks({ selector: 'a[href*="/en/property-for-"]', label: LABEL_LISTING_PAGE });
});

// ── Crawler ───────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency,
    maxRequestsPerCrawl: maxListings > 0 ? maxListings * 5 : undefined,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 45,
    retryOnBlocked: true,
    maxSessionRotations: 10,

    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
        },
    },

    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                operatingSystems: ['windows', 'macos'],
            },
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            });
        },
    ],
});

await crawler.run(initialRequests);

log.info(`Done. Total listings saved: ${listingsScraped}`);
await Actor.exit();
