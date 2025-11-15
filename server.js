// server.js
// Realtor.ca scraper with maximum stealth and alternative approaches

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import puppeteer from "puppeteer-core";
import pLimit from "p-limit";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "1", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "60000", 10);
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

if (!BROWSERLESS_TOKEN) {
  console.warn("⚠️  BROWSERLESS_TOKEN not set!");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Webhook POST failed", e.message);
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

// Helper to simulate human mouse movements
async function simulateHumanBehavior(page) {
  try {
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 500);
    });
    await sleep(500 + Math.random() * 500);
  } catch (e) {
    // ignore
  }
}

// Main endpoint
app.post("/scrape-webhook", async (req, res) => {
  const {
    location = "Toronto",
    bedrooms = 2,
    bathrooms,
    budget = 600000,
    webhookUrl,
    maxResults = 5,
    province = "ON", // AB, BC, ON, QC, etc.
  } = req.body || {};

  if (!webhookUrl) {
    return res.status(400).json({ success: false, error: "webhookUrl required" });
  }

  if (!BROWSERLESS_TOKEN) {
    return res.status(500).json({ 
      success: false, 
      error: "BROWSERLESS_TOKEN not configured" 
    });
  }

  res.json({ 
    success: true, 
    status: "started", 
    message: "Scraping started in background. Using maximum stealth mode.",
    usingBrowserless: true 
  });

  (async () => {
    let browser;
    try {
      // Connect with all stealth options
      const browserWSEndpoint = `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}&stealth&blockAds`;
      
      console.log("🔌 Connecting to Browserless.io with stealth...");
      browser = await puppeteer.connect({
        browserWSEndpoint,
      });

      const page = await browser.newPage();
      
      // Maximum stealth setup
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ 
        width: 1920, 
        height: 1080,
        deviceScaleFactor: 1,
      });
      
      // Set realistic headers
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      });

      // Override navigator properties to avoid detection
      await page.evaluateOnNewDocument(() => {
        // Remove webdriver property
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
        
        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        
        // Mock languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      });

      console.log("🔍 Strategy 1: Trying Google search for realtor.ca listings...");
      
      // STRATEGY 1: Google search
      const googleQuery = `site:realtor.ca ${location} ${bedrooms} bedroom ${budget}`;
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}&num=30`;
      
      let links = [];
      
      try {
        await page.goto(googleUrl, { 
          waitUntil: "networkidle0", 
          timeout: NAV_TIMEOUT 
        });
        
        await sleep(2000 + Math.random() * 1000);
        await simulateHumanBehavior(page);
        
        links = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll("a"));
          return anchors
            .map(a => a.href)
            .filter(u => u && u.includes("realtor.ca/real-estate/") && !u.includes("google.com"))
            .map(u => u.split('?')[0]); // Remove query params
        });
        
        links = uniq(links);
        console.log(`✅ Found ${links.length} links from Google`);
        
      } catch (e) {
        console.error("❌ Google search failed:", e.message);
      }

      // STRATEGY 2: If Google didn't work, try Bing
      if (links.length === 0) {
        console.log("🔍 Strategy 2: Trying Bing search...");
        
        const bingQuery = `site:realtor.ca ${location} ${bedrooms} bedroom`;
        const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(bingQuery)}`;
        
        try {
          await page.goto(bingUrl, { 
            waitUntil: "networkidle0", 
            timeout: NAV_TIMEOUT 
          });
          
          await sleep(2000);
          await simulateHumanBehavior(page);
          
          links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll("a"));
            return anchors
              .map(a => a.href)
              .filter(u => u && u.includes("realtor.ca/real-estate/"))
              .map(u => u.split('?')[0]);
          });
          
          links = uniq(links);
          console.log(`✅ Found ${links.length} links from Bing`);
          
        } catch (e) {
          console.error("❌ Bing search failed:", e.message);
        }
      }

      // STRATEGY 3: Try DuckDuckGo as last resort
      if (links.length === 0) {
        console.log("🔍 Strategy 3: Trying DuckDuckGo search...");
        
        const ddgQuery = `site:realtor.ca ${location} ${bedrooms} bedroom for sale`;
        const ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(ddgQuery)}`;
        
        try {
          await page.goto(ddgUrl, { 
            waitUntil: "networkidle0", 
            timeout: NAV_TIMEOUT 
          });
          
          await sleep(3000);
          
          links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll("a"));
            return anchors
              .map(a => a.href)
              .filter(u => u && u.includes("realtor.ca/real-estate/"))
              .map(u => u.split('?')[0]);
          });
          
          links = uniq(links);
          console.log(`✅ Found ${links.length} links from DuckDuckGo`);
          
        } catch (e) {
          console.error("❌ DuckDuckGo search failed:", e.message);
        }
      }

      links = uniq(links).slice(0, maxResults);
      console.log(`📊 Final candidate links: ${links.length}`);

      await postWebhook(webhookUrl, {
        event: "started",
        location,
        bedrooms,
        budget,
        totalCandidates: links.length,
        searchStrategy: links.length > 0 ? "search_engine" : "none",
        timestamp: new Date().toISOString(),
      });

      if (links.length === 0) {
        await postWebhook(webhookUrl, {
          event: "completed",
          totalScraped: 0,
          message: "No properties found. Try different search criteria or location.",
          timestamp: new Date().toISOString(),
        });
        await browser.disconnect();
        return;
      }

      const limit = pLimit(CONCURRENCY);
      let counter = 0;
      let successCount = 0;

      const tasks = links.map((link) =>
        limit(async () => {
          counter += 1;
          let prop = { url: link };
          let detailPage;
          
          try {
            console.log(`🏠 Scraping ${counter}/${links.length}: ${link}`);
            
            detailPage = await browser.newPage();
            
            // Apply same stealth settings
            await detailPage.setUserAgent(USER_AGENT);
            await detailPage.setViewport({ width: 1920, height: 1080 });
            
            await detailPage.setExtraHTTPHeaders({
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
              'Referer': 'https://www.google.com/',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'cross-site',
            });
            
            await detailPage.evaluateOnNewDocument(() => {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
              });
            });
            
            // Navigate with longer timeout
            await detailPage.goto(link, { 
              waitUntil: "domcontentloaded", 
              timeout: NAV_TIMEOUT 
            });
            
            // Longer delay to appear more human
            await sleep(3000 + Math.floor(Math.random() * 2000));
            
            // Simulate scrolling
            await detailPage.evaluate(() => {
              window.scrollBy(0, 300);
            });
            await sleep(500);

            // Extract data
            const data = await detailPage.evaluate(() => {
              const result = {};
              
              // Try multiple extraction methods
              
              // Method 1: Meta tags (most reliable)
              try {
                result.title = document.querySelector('meta[property="og:title"]')?.content || null;
                result.description = document.querySelector('meta[property="og:description"]')?.content || null;
                result.image = document.querySelector('meta[property="og:image"]')?.content || null;
                
                // Extract price from title or description
                if (result.title) {
                  const priceMatch = result.title.match(/\$[\d,]+/);
                  if (priceMatch) result.price = priceMatch[0];
                }
                
                if (result.description) {
                  const bedMatch = result.description.match(/(\d+)\s*bed/i);
                  const bathMatch = result.description.match(/(\d+)\s*bath/i);
                  if (bedMatch) result.beds = parseInt(bedMatch[1]);
                  if (bathMatch) result.baths = parseInt(bathMatch[1]);
                }
              } catch (e) {
                console.error("Meta tag extraction error:", e);
              }
              
              // Method 2: Look for JSON-LD structured data
              try {
                const jsonLd = document.querySelector('script[type="application/ld+json"]');
                if (jsonLd) {
                  const data = JSON.parse(jsonLd.textContent);
                  if (data.offers?.price) result.price = `$${data.offers.price}`;
                  if (data.address) result.address = typeof data.address === 'string' ? data.address : data.address.streetAddress;
                }
              } catch (e) {
                // ignore
              }
              
              // Method 3: Page title as fallback
              if (!result.title) {
                result.title = document.title;
              }
              
              return result;
            });

            if (data && (data.title || data.price)) {
              prop = { ...prop, ...data };
              successCount++;
              console.log(`✅ Successfully scraped: ${data.title || link}`);
            } else {
              console.log(`⚠️  No data extracted from ${link}`);
            }
            
            await detailPage.close();
            
          } catch (err) {
            console.error(`❌ Error scraping ${link}:`, err.message);
            if (detailPage && !detailPage.isClosed()) {
              await detailPage.close();
            }
          }

          // Post each property
          await postWebhook(webhookUrl, {
            event: "property",
            index: counter,
            total: links.length,
            property: { ...prop, scrapedAt: new Date().toISOString() },
          });

          // Long delay to avoid rate limiting
          await sleep(4000 + Math.floor(Math.random() * 3000));
        })
      );

      await Promise.all(tasks);

      await postWebhook(webhookUrl, {
        event: "completed",
        totalScraped: links.length,
        successfulScrapes: successCount,
        timestamp: new Date().toISOString(),
      });

      await browser.disconnect();
      console.log("✅ Scraping completed");
      
    } catch (err) {
      console.error("💥 Scrape error:", err.message);
      if (browser) await browser.disconnect();
      
      await postWebhook(webhookUrl, {
        event: "error",
        message: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      });
    }
  })();
});

app.get("/", (req, res) => {
  res.json({ 
    status: "running",
    service: "realtor.ca scraper",
    browserless: !!BROWSERLESS_TOKEN,
    message: "POST to /scrape-webhook to start scraping",
    strategies: ["Google Search", "Bing Search", "DuckDuckGo Search"],
    note: "Uses multiple search engines to find realtor.ca listings"
  });
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy",
    browserlessConfigured: !!BROWSERLESS_TOKEN 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Browserless.io: ${BROWSERLESS_TOKEN ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🔒 Maximum stealth mode enabled`);
});
