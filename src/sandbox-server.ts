import * as http from "http";
import ivm from "isolated-vm";
import puppeteer, { type Browser } from "puppeteer-core";
import ollama from "ollama";
import { MODEL } from "./llm-runner.ts";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
    });
  }
  return browser;
}

// --- Web search via Puppeteer ---

async function webSearch(query: string): Promise<string> {
  console.log(`[webSearch] query: "${query}"`);
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
    const rawText = await page.evaluate(() => document.body.innerText);
    console.log(`[webSearch] got ${rawText.length} chars, summarizing...`);

    const truncated = rawText.slice(0, 8000);
    const summary = await ollama.chat({
      model: MODEL,
      messages: [{
        role: "user",
        content: `Below are raw Google search results for the query "${query}". Extract and summarize the key facts, findings, and relevant URLs. Be concise.\n\n${truncated}`,
      }],
      options: { temperature: 0.3, num_predict: 1024 },
    });

    const result = summary.message.content;
    console.log(`[webSearch] summary: ${result.length} chars`);
    return result || "No results found.";
  } catch (e: any) {
    console.log(`[webSearch] error: ${e.message}`);
    return `Search error: ${e.message}`;
  } finally {
    await page.close();
    console.log(`[webSearch] page closed`);
  }
}

// --- Sandbox execution ---

async function executeCode(code: string, { timeout = 60000, memoryLimit = 8 } = {}) {
  const output: string[] = [];
  let finalAnswer: { called: boolean; value?: unknown } = { called: false };
  const isolate = new ivm.Isolate({ memoryLimit });

  try {
    const context = isolate.createContextSync();

    // log() — sync callback
    context.global.setSync("log", new ivm.Callback((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    }));

    // finalAnswer() — sync callback
    context.global.setSync("finalAnswer", new ivm.Callback((value: unknown) => {
      finalAnswer = { called: true, value };
    }));

    // _webSearchRef — a Reference to a host function that returns a Promise.
    // Inside the isolate, we wrap it with applySyncPromise so user code can call
    // webSearch(query) synchronously while the host resolves the HTTP request async.
    context.global.setSync("_webSearchRef", new ivm.Reference(async (query: string) => {
      return new ivm.ExternalCopy(await webSearch(query)).copyInto();
    }));

    // Bootstrap: define webSearch() in the isolate using applySyncPromise
    context.evalSync(`
      function webSearch(query) {
        return _webSearchRef.applySyncPromise(undefined, [query]);
      }
    `);

    // Run user code async so applySyncPromise can block the isolate thread
    // while the host thread resolves the search promise
    const result = await context.eval(code, { timeout });

    return { success: true, result: finalAnswer.called ? finalAnswer.value : result, output, finalAnswer: finalAnswer.called };
  } catch (err: any) {
    return { success: false, error: err.message, output, finalAnswer: false };
  } finally {
    isolate.dispose();
  }
}

// --- HTTP server ---

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/execute") {
    res.writeHead(404);
    return res.end("Not found");
  }

  let body = "";
  req.on("data", (chunk: string) => body += chunk);
  req.on("end", async () => {
    try {
      const { code } = JSON.parse(body);
      const result = await executeCode(code);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid request" }));
    }
  });
}).listen(3000, () => console.log("Sandbox API running on http://localhost:3000"));

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(0); });
