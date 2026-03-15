import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";
import puppeteer from "@cloudflare/puppeteer";
import type { Page } from "@cloudflare/puppeteer";

const app = new Hono<{ Bindings: Env }>();

// --- HTML to Markdown conversion (simple regex-based) ---

function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script and style blocks
  md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
  md = md.replace(/<style[\s\S]*?<\/style>/gi, "");
  md = md.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Convert headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Convert links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Convert images
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  // Convert bold and italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Convert code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Convert blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");

  // Convert list items
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  md = md.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // Convert paragraphs and line breaks
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Remove remaining HTML tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  md = md.replace(/&amp;/g, "&");
  md = md.replace(/&lt;/g, "<");
  md = md.replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, "\n\n");
  md = md.trim();

  return md;
}

// --- Extract links from page ---

async function extractLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((href) => href.startsWith("http"));
  });

  // Filter to same origin only
  const base = new URL(baseUrl);
  return [...new Set(links.filter((link) => {
    try {
      return new URL(link).origin === base.origin;
    } catch {
      return false;
    }
  }))];
}

// --- Extract page content ---

async function extractPageContent(page: Page): Promise<{ title: string; html: string }> {
  return page.evaluate(() => {
    const title = document.title || "";
    const main =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector('[role="main"]') ||
      document.body;
    return { title, html: main?.innerHTML || "" };
  });
}

const SYSTEM_PROMPT = `You are a parameter extractor for a web scraping and crawling service.
Extract the following from the user's message and return JSON:
- "url": the URL to scrape or crawl (required)
- "action": either "scrape" (single page) or "crawl" (follow links). Default "scrape". (optional)
- "format": output format - "text", "html", or "markdown". Default "text". (optional)
- "depth": crawl depth 1-3 for crawl action. Default 1. (optional)

If the user mentions crawling, spidering, or following links, set action to "crawl".
Otherwise default to "scrape".

Return ONLY valid JSON, no explanation.
Examples:
- {"url": "https://example.com"}
- {"url": "https://example.com", "action": "crawl", "depth": 2}
- {"url": "https://example.com", "format": "markdown"}`;

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.01", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.01", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.01", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Scrape a single page or crawl a website, returning content as text, HTML, or markdown. Send {\"input\": \"your request\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe what you want to scrape or crawl", required: true },
            },
          },
          output: { type: "json" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(stripeApiKeyMiddleware({ serviceName: "web-scraper" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: ROUTES["POST /"].accepts.map((a: any) => ({ ...a, payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}` })) },
  }))(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const url = params.url as string;
  if (!url) {
    return c.json({ error: "Could not determine URL to scrape" }, 400);
  }

  try {
    new URL(url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const action = ((params.action as string) || "scrape").toLowerCase();
  const format = ((params.format as string) || "text").toLowerCase();

  if (action === "crawl") {
    // --- Crawl ---
    if (format !== "text" && format !== "html" && format !== "markdown") {
      return c.json({ error: "Format must be text, html, or markdown" }, 400);
    }

    const depth = Math.min(Math.max(parseInt(String(params.depth || "1"), 10) || 1, 1), 3);

    let browser;
    try {
      browser = await puppeteer.launch(c.env.BROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });

      const visited = new Set<string>();
      const pages: Array<{
        url: string;
        title: string;
        content: string;
        depth: number;
        links: string[];
      }> = [];

      // BFS crawl
      let queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];

      while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current.url) || current.depth > depth) continue;
        visited.add(current.url);

        try {
          await page.goto(current.url, { waitUntil: "networkidle0", timeout: 20000 });
          const { title, html } = await extractPageContent(page);
          const markdown = htmlToMarkdown(html);
          const links = await extractLinks(page, current.url);

          pages.push({
            url: current.url,
            title,
            content: markdown,
            depth: current.depth,
            links,
          });

          // Queue child links if we haven't reached max depth
          if (current.depth < depth) {
            for (const link of links.slice(0, 10)) {
              if (!visited.has(link)) {
                queue.push({ url: link, depth: current.depth + 1 });
              }
            }
          }
        } catch {
          // Skip pages that fail to load
          continue;
        }

        // Cap total pages to avoid runaway crawls
        if (pages.length >= 20) break;
      }

      if (format === "markdown") {
        const md = pages
          .map(
            (p) =>
              `# ${p.title}\n\nURL: ${p.url}\nDepth: ${p.depth}\n\n---\n\n${p.content}`
          )
          .join("\n\n---\n\n");

        return new Response(md, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }

      return c.json({
        startUrl: url,
        depth,
        totalPages: pages.length,
        crawledAt: new Date().toISOString(),
        pages: pages.map((p) => ({
          url: p.url,
          title: p.title,
          content: p.content,
          depth: p.depth,
          linksFound: p.links.length,
        })),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "Crawl failed", details: message }, 500);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  // --- Scrape (default) ---
  if (format !== "text" && format !== "html" && format !== "markdown") {
    return c.json({ error: "Format must be text, html, or markdown" }, 400);
  }

  let browser;
  try {
    browser = await puppeteer.launch(c.env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    const { title, html } = await extractPageContent(page);
    const markdown = htmlToMarkdown(html);

    if (format === "html") {
      return c.json({
        url,
        title,
        content: html,
        scrapedAt: new Date().toISOString(),
      });
    }

    if (format === "markdown") {
      return new Response(
        `# ${title}\n\nSource: ${url}\n\n---\n\n${markdown}`,
        {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }
      );
    }

    // Default: text (json wrapper with markdown content)
    return c.json({
      url,
      title,
      content: markdown,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Scrape failed", details: message }, 500);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 Web Scraper", "scraper.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-web-scraper",
    description: "Scrape single pages or crawl websites. Send POST / with {\"input\": \"scrape https://example.com\"}",
    price: "$0.01 per request (Base mainnet)",
  });
});

export default app;
