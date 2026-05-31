# DDProperty Scraper

Scrapes property listings from [DDProperty Thailand](https://www.ddproperty.com) — Thailand's largest real estate portal.

## Features

- Scrapes both rental and sale listings
- Handles pagination automatically
- Extracts: title, price, address, bedrooms, bathrooms, size, floor, description, agent, images, facilities
- Anti-bot evasion via Playwright + Apify Residential proxies + fingerprint randomisation
- Configurable max listings, concurrency, and proxy settings

## Input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startUrls` | Array | DDProperty Bangkok rentals | One or more DDProperty search page URLs |
| `maxListings` | Integer | 100 | Max listings to scrape (0 = unlimited) |
| `maxConcurrency` | Integer | 3 | Concurrent browser sessions |
| `proxyConfiguration` | Object | Apify Residential | Proxy settings |

### Example URL

```
https://www.ddproperty.com/en/property-for-rent?listingType=rent&isCommercial=false&maxPrice=60000&minSize=80&regionCode=TH10&bedrooms=2&bedrooms=3&bedrooms=4&bedrooms=5&distanceToMRT=0.75
```

## Output

Each item in the dataset:

```json
{
  "url": "https://www.ddproperty.com/en/property-for-rent/...",
  "listingId": "12345678",
  "title": "2 Bed Condo for Rent in Ekkamai",
  "priceThb": 45000,
  "priceDisplay": "฿45,000/mo",
  "address": "Ekkamai, Watthana, Bangkok",
  "propertyType": "Condo",
  "bedrooms": 2,
  "bathrooms": 2,
  "sizeSqm": 85,
  "sizeDisplay": "85 sqm",
  "floor": "12",
  "description": "...",
  "agentName": "...",
  "images": ["https://..."],
  "facilities": ["Swimming Pool", "Gym", "Parking"],
  "scrapedAt": "2026-05-31T12:00:00.000Z"
}
```

## Notes

- DDProperty uses dynamic JS rendering — this actor uses a full Chromium browser
- Residential proxies strongly recommended to avoid blocks
- Respect the site's Terms of Service; avoid excessive scraping
