/**
 * DDProperty.com Scraper
 *
 * Scrapes property listings from DDProperty Thailand.
 * Uses Playwright (Chromium) to handle JS-rendered content.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';
import { createPlaywrightRouter } from 'crawlee';

const LABEL_LISTING_PAGE = 'LISTING_PAGE';
const LABEL_DETAIL_PAGE = 'DETAIL_PAGE';

await Actor.init();

// ── Input ─────────────────────────────────────────────────────────────────────
const input = await Actor.getInput() ?? {};

const {
    startUrls = [
        {
            url: 'https://www.ddproperty.com/en/property-for-rent?listingType=rent&isCommercial=false&maxPrice=60000&minSize=80&regionCode=TH10&bedrooms=2&bedrooms=3&bedrooms=4&bedrooms=5&distanceToMRT=0.75',
        },
    ],
    maxListings = 100,
    maxConcurrency = 3,
    proxyConfiguration: proxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

log.info('Starting DDProperty scraper', { maxListings, maxConcurrency });

// ── Proxy ─────────────────────────────────────────────────────────────────────
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

// ── Tracking ──────────────────────────────────────────────────────────────────
let listingsScraped = 0;

// ── Router ────────────────────────────────────────────────────────────────────
const router = createPlaywrightRouter();

/**
 * Listing/search results page handler.
 * Enqueues detail pages and handles pagination.
 */
router.addHandler(LABEL_LISTING_PAGE, async ({ page, request, enqueueLinks, crawler }) => {
    log.info(`Scraping listing page: ${request.url}`);

    // Wait for property cards to load
    await page.waitForSelector('[data-testid="listing-card-container"], .listing-item, article[class*="listing"]', {
        timeout: 30_000,
    }).catch(() => log.warning('Listing card selector timed out, continuing anyway'));

    // Collect all property detail links on the page
    const detailLinks = await page.$$eval(
        'a[href*="/en/property-for-"], a[href*="/property/"]',
        (anchors) =>
            anchors
                .map((a) => a.href)
                .filter(
                    (href) =>
                        href.includes('ddproperty.com') &&
                        !href.includes('?') === false &&
                        (href.match(/\/\d+\/?$/) || href.includes('-for-rent-') || href.includes('-for-sale-'))
                )
    );

    // More targeted: get only listing detail URLs (end in numeric ID)
    const listingLinks = await page.$$eval(
        'a[data-testid="listing-card-link"], a[class*="listing__link"], .listing-result a, [class*="PropertyCard"] a',
        (anchors) => [...new Set(anchors.map((a) => a.href).filter(Boolean))]
    );

    const links = [...new Set([...detailLinks, ...listingLinks])].filter(
        (url) => url.includes('ddproperty.com/en/') && url !== request.url
    );

    log.info(`Found ${links.length} potential listing links on page`);

    // Enqueue detail pages (respecting maxListings)
    for (const url of links) {
        if (maxListings > 0 && listingsScraped + (await crawler.requestQueue?.handledCount() ?? 0) >= maxListings) break;
        await crawler.addRequests([{ url, label: LABEL_DETAIL_PAGE }]);
    }

    // ── Pagination ────────────────────────────────────────────────────────────
    const currentUrl = new URL(request.url);
    const currentPage = parseInt(currentUrl.searchParams.get('page') ?? '1', 10);

    // Check if there's a "next" page button that's enabled
    const hasNextPage = await page.$$eval(
        'a[aria-label="Next page"], a[data-testid="pagination-next"], .pagination__next:not(.disabled)',
        (els) => els.length > 0
    );

    if (hasNextPage && (maxListings === 0 || listingsScraped < maxListings)) {
        currentUrl.searchParams.set('page', String(currentPage + 1));
        const nextPageUrl = currentUrl.toString();
        log.info(`Queuing next page: ${nextPageUrl}`);
        await crawler.addRequests([{ url: nextPageUrl, label: LABEL_LISTING_PAGE }]);
    }
});

/**
 * Individual property detail page handler.
 * Extracts all relevant fields from a listing.
 */
router.addHandler(LABEL_DETAIL_PAGE, async ({ page, request }) => {
    if (maxListings > 0 && listingsScraped >= maxListings) {
        log.info('Max listings reached, skipping detail page');
        return;
    }

    log.info(`Scraping detail page: ${request.url}`);

    // Wait for the main content
    await page.waitForSelector('h1, [data-testid="listing-title"], .listing-detail__title', {
        timeout: 30_000,
    }).catch(() => {});

    // ── Extract structured data from the page ─────────────────────────────────
    const data = await page.evaluate(() => {
        const getText = (selector) =>
            document.querySelector(selector)?.textContent?.trim() ?? null;

        const getNumber = (selector) => {
            const val = document.querySelector(selector)?.textContent?.trim();
            return val ? parseFloat(val.replace(/[^0-9.]/g, '')) : null;
        };

        // Try to pull from JSON-LD structured data first (most reliable)
        const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
            .map((s) => {
                try { return JSON.parse(s.textContent); } catch { return null; }
            })
            .filter(Boolean)
            .find((d) => d['@type'] === 'RealEstateListing' || d.name);

        // Price
        const priceRaw =
            getText('[data-testid="price-value"]') ??
            getText('.price__value') ??
            getText('[class*="price"]');

        // Title
        const title =
            getText('h1') ??
            getText('[data-testid="listing-title"]') ??
            getText('.listing-detail__title');

        // Location/address
        const address =
            getText('[data-testid="listing-location"]') ??
            getText('.address__text') ??
            getText('[class*="location"]');

        // Property type
        const propertyType =
            getText('[data-testid="property-type"]') ??
            getText('[class*="propertyType"]');

        // Bedrooms / bathrooms / size
        const bedroomsRaw =
            getText('[data-testid="beds"]') ??
            getText('[aria-label*="bedroom"]') ??
            getText('[class*="bedroom"]');

        const bathroomsRaw =
            getText('[data-testid="baths"]') ??
            getText('[aria-label*="bathroom"]') ??
            getText('[class*="bathroom"]');

        const sizeRaw =
            getText('[data-testid="floor-size"]') ??
            getText('[class*="floorSize"]') ??
            getText('[class*="size"]');

        // Floor level
        const floorRaw = getText('[data-testid="floor-level"]') ?? getText('[class*="floor"]');

        // Description
        const description =
            getText('[data-testid="listing-description"]') ??
            getText('.description__text') ??
            getText('[class*="description"]');

        // Agent/developer
        const agentName =
            getText('[data-testid="agent-name"]') ??
            getText('[class*="agentName"]') ??
            getText('[class*="agent"] .name');

        // Images
        const images = Array.from(
            document.querySelectorAll(
                '[data-testid="gallery-image"] img, .gallery__image img, [class*="Gallery"] img'
            )
        )
            .map((img) => img.src || img.dataset.src)
            .filter(Boolean)
            .slice(0, 10);

        // Facilities / amenities tags
        const facilities = Array.from(
            document.querySelectorAll(
                '[data-testid="facility-item"], [class*="facility"] span, [class*="amenity"]'
            )
        )
            .map((el) => el.textContent?.trim())
            .filter(Boolean);

        // Listing ID from URL or page
        const listingIdMatch =
            document.querySelector('[data-testid="listing-id"]')?.textContent?.trim() ??
            window.location.pathname.match(/\d{5,}$/)?.[0];

        return {
            title,
            priceRaw,
            address,
            propertyType,
            bedroomsRaw,
            bathroomsRaw,
            sizeRaw,
            floorRaw,
            description,
            agentName,
            images,
            facilities,
            listingId: listingIdMatch ?? null,
            jsonLd,
        };
    });

    // ── Parse / normalise ─────────────────────────────────────────────────────
    const parseNumber = (raw) => {
        if (!raw) return null;
        const cleaned = raw.replace(/[^0-9.]/g, '');
        return cleaned ? parseFloat(cleaned) : null;
    };

    const listing = {
        url: request.url,
        listingId: data.listingId,
        title: data.title,
        priceThb: parseNumber(data.priceRaw),
        priceDisplay: data.priceRaw,
        address: data.address,
        propertyType: data.propertyType,
        bedrooms: parseNumber(data.bedroomsRaw),
        bathrooms: parseNumber(data.bathroomsRaw),
        sizeSqm: parseNumber(data.sizeRaw),
        sizeDisplay: data.sizeRaw,
        floor: data.floorRaw,
        description: data.description,
        agentName: data.agentName,
        images: data.images,
        facilities: data.facilities,
        scrapedAt: new Date().toISOString(),
        // JSON-LD enrichment if available
        ...(data.jsonLd
            ? {
                  jsonLdName: data.jsonLd.name,
                  jsonLdPrice: data.jsonLd.offers?.price ?? null,
                  jsonLdPriceCurrency: data.jsonLd.offers?.priceCurrency ?? null,
                  jsonLdAddress: data.jsonLd.address?.streetAddress ?? null,
              }
            : {}),
    };

    // Skip if we got basically nothing (probably hit a CAPTCHA or redirect)
    if (!listing.title && !listing.priceThb && !listing.address) {
        log.warning(`Empty listing at ${request.url} — possible CAPTCHA/redirect, skipping`);
        return;
    }

    await Dataset.pushData(listing);
    listingsScraped++;
    log.info(`Saved listing #${listingsScraped}: ${listing.title ?? request.url}`);
});

// Fallback for any unhandled label
router.addDefaultHandler(async ({ request, enqueueLinks }) => {
    log.info(`Default handler: ${request.url} — treating as listing page`);
    await enqueueLinks({
        selector: 'a[href*="/en/property-for-"]',
        label: LABEL_LISTING_PAGE,
    });
});

// ── Crawler ────────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency,
    maxRequestsPerCrawl: maxListings > 0 ? maxListings * 5 : undefined, // safety cap
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 45,
    retryOnBlocked: true,
    maxSessionRotations: 10,

    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    },

    browserPoolOptions: {
        useFingerprints: true,         // Randomise browser fingerprints
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                operatingSystems: ['windows', 'macos'],
            },
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // Mask automation signals
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            // Set realistic headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            });
        },
    ],
});

// ── Seed the queue ─────────────────────────────────────────────────────────────
const initialRequests = startUrls.map((item) => ({
    url: typeof item === 'string' ? item : item.url,
    label: LABEL_LISTING_PAGE,
}));

await crawler.run(initialRequests);

log.info(`Scraping complete. Total listings saved: ${listingsScraped}`);

await Actor.exit();
