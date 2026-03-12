import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
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

// --- OpenAPI spec ---

app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 Web Scraper Service",
      description: "Scrape single pages or crawl websites, returning content as markdown or JSON. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://scraper.camelai.io" }],
  },
}));

// --- Payment middleware ---

app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "GET /scrape": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Scrape a single URL and return its content as markdown or JSON",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              queryParams: {
                url: {
                  type: "string",
                  description: "URL to scrape",
                  required: true,
                },
                format: {
                  type: "string",
                  description: "Output format: markdown or json (default: markdown)",
                  required: false,
                },
              },
            },
          },
        },
      },
      "GET /crawl": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.05",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description:
          "Crawl a website following links up to a specified depth, returning structured content",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              queryParams: {
                url: {
                  type: "string",
                  description: "Starting URL to crawl",
                  required: true,
                },
                format: {
                  type: "string",
                  description: "Output format: markdown or json (default: json)",
                  required: false,
                },
                depth: {
                  type: "number",
                  description: "Max crawl depth 1-3 (default: 1)",
                  required: false,
                },
              },
            },
          },
        },
      },
    })
  )
);

// --- GET /scrape ---

app.get("/scrape", describeRoute({
  description: "Scrape a single URL and return content as markdown or JSON. Requires x402 payment ($0.01).",
  responses: {
    200: { description: "Scraped content", content: { "text/markdown": { schema: { type: "string" } }, "application/json": { schema: { type: "object" } } } },
    400: { description: "Invalid or missing URL" },
    402: { description: "Payment required" },
    500: { description: "Scrape failed" },
  },
}), async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.json({ error: "Missing required query parameter: url" }, 400);
  }

  try {
    new URL(url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const format = (c.req.query("format") || "markdown").toLowerCase();
  if (format !== "markdown" && format !== "json") {
    return c.json({ error: "Format must be markdown or json" }, 400);
  }

  let browser;
  try {
    browser = await puppeteer.launch(c.env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    const { title, html } = await extractPageContent(page);
    const markdown = htmlToMarkdown(html);

    if (format === "json") {
      return c.json({
        url,
        title,
        content: markdown,
        scrapedAt: new Date().toISOString(),
      });
    }

    // Return markdown as plain text
    return new Response(
      `# ${title}\n\nSource: ${url}\n\n---\n\n${markdown}`,
      {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Scrape failed", details: message }, 500);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// --- GET /crawl ---

app.get("/crawl", describeRoute({
  description: "Crawl a website following links up to a specified depth. Requires x402 payment ($0.05).",
  responses: {
    200: { description: "Crawled content from multiple pages", content: { "text/markdown": { schema: { type: "string" } }, "application/json": { schema: { type: "object" } } } },
    400: { description: "Invalid or missing URL" },
    402: { description: "Payment required" },
    500: { description: "Crawl failed" },
  },
}), async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.json({ error: "Missing required query parameter: url" }, 400);
  }

  try {
    new URL(url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const format = (c.req.query("format") || "json").toLowerCase();
  if (format !== "markdown" && format !== "json") {
    return c.json({ error: "Format must be markdown or json" }, 400);
  }

  const depth = Math.min(Math.max(parseInt(c.req.query("depth") || "1", 10) || 1, 1), 3);

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
});

export default app;
