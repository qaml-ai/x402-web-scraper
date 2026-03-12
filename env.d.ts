import type { BrowserWorker } from "@cloudflare/puppeteer";

interface Env {
  BROWSER: BrowserWorker;
  SERVER_ADDRESS: string;
}
