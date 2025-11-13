// server.js
// Free, pragmatic scraper: accepts JSON filters and posts each property to a webhook (Make.com)
// WARNING: Works for low-volume testing only. May be blocked by websites.

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import pLimit from "p-limit";

puppeteer.use(StealthPlugin());

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "2", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "30000", 10);
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36";

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

// Minimal link dedupe
function uniq(arr) {
  return Array.from(new Set(arr));
}

// Main endpoint: call this from Make.com (or curl)
app.post("/scrape-webhook", async (req, res) => {
  const {
    location = "Edmonton",
    bedrooms = 2,
    bathrooms,
    sqftMin,
    sqftMax,
    budget = 500000,
    webhookUrl,
    maxResults = 10,
    useGoogleFallback = true,
  } = req.body || {};

  if (!webhookUrl) {
    return res.status(400).json({ success: false, error: "webhookUrl required" });
  }

  // immediate response so Make isn't waiting
  res.json({ success: true, status: "started", message: "Scraping started in background" });

  (async () => {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ width: 1280, height: 900 });

      // Build a Google query that finds realtor.ca listings in the location
      const qParts = [`site:realtor.ca "${location}"`];
      if (bedrooms) qParts.push(`${bedrooms} bedroom`);
      if (budget) qParts.push(`$${budget}`);
      const googleQuery = qParts.join(" ");

      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}&num=20`;
      console.log("Going to Google ->", googleUrl);

      await page.goto(googleUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
      await sleep(1200);

      // Extract realtor.ca links from Google results
      let links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll("a"));
        const urls = anchors
          .map((a) => a.href)
          .filter((u) => u && u.includes("realtor.ca/real-estate/"));
        return urls.slice(0, 50);
      });

      links = uniq(links).slice(0, maxResults * 3);

      // fallback: try to search realtor.ca list page if Google didn't work
      if ((!links || links.length === 0) && useGoogleFallback) {
        const listUrl = `https://www.realtor.ca/ab/edmonton/real-estate`;
        await page.goto(listUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
        await sleep(1500);
        const found = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll("a[href*='/real-estate/']"));
          return anchors.map((a) => a.href.split("?")[0]).slice(0, 50);
        });
        links = uniq(found);
      }

      links = uniq(links).slice(0, maxResults);
      console.log("Candidate links:", links.length);

      // notify started
      await postWebhook(webhookUrl, {
        event: "started",
        location,
        bedrooms,
        budget,
        totalCandidates: links.length,
        timestamp: new Date().toISOString(),
      });

      const limit = pLimit(CONCURRENCY);
      let counter = 0;

      const tasks = links.map((link) =>
        limit(async () => {
          counter += 1;
          let prop = { url: link };
          let page2;
          try {
            page2 = await browser.newPage();
            await page2.setUserAgent(USER_AGENT);
            await page2.setViewport({ width: 1200, height: 900 });
            await page2.goto(link, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
            await sleep(800 + Math.floor(Math.random() * 800));

            // Try to extract JSON blob or meta tags
            const data = await page2.evaluate(() => {
              // Try to parse preloaded JSON
              try {
                const scripts = Array.from(document.querySelectorAll("script"));
                for (const s of scripts) {
                  const txt = s.textContent || "";
                  if (txt.includes("window.__PRELOADED_STATE__") || txt.includes("__PRELOADED_STATE__")) {
                    const m = txt.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/);
                    if (m && m[1]) {
                      const obj = JSON.parse(m[1]);
                      // site specific, attempt safe extraction
                      const prop = obj?.propertyDetails || obj?.Property || obj;
                      return {
                        mls: prop?.MlsNumber || null,
                        price: prop?.Property?.Price || null,
                        address: prop?.Property?.Address?.AddressText || null,
                        city: prop?.Property?.Address?.City || null,
                        beds: prop?.Building?.Bedrooms || null,
                        baths: prop?.Building?.BathroomTotal || null,
                        photo: prop?.Property?.Photo?.[0]?.HighResPath || null,
                      };
                    }
                  }
                }
              } catch (e) {
                // ignore
              }
              // fallback: meta tags / og
              try {
                const title = document.querySelector('meta[property="og:title"]')?.content || null;
                const desc = document.querySelector('meta[property="og:description"]')?.content || null;
                const img = document.querySelector('meta[property="og:image"]')?.content || null;
                return { title, desc, img };
              } catch (e) {}
              return null;
            });

            if (data) prop = { ...prop, ...data };
            await page2.close();
          } catch (err) {
            if (page2 && !page2.isClosed()) await page2.close();
            console.error("Detail page error", link, err.message);
          }

          // post each property immediately
          await postWebhook(webhookUrl, {
            event: "property",
            index: counter,
            total: links.length,
            property: { ...prop, scrapedAt: new Date().toISOString() },
          });

          // polite random delay
          await sleep(900 + Math.floor(Math.random() * 1100));
        })
      );

      await Promise.all(tasks);

      await postWebhook(webhookUrl, {
        event: "completed",
        totalScraped: links.length,
        timestamp: new Date().toISOString(),
      });

      await browser.close();
    } catch (err) {
      console.error("Scrape error", err.message);
      if (browser) await browser.close();
      await postWebhook(webhookUrl, {
        event: "error",
        message: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  })();
});

app.get("/", (req, res) => res.send("Simple realtor scraper running"));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
