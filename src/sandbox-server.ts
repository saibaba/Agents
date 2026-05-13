import * as http from "http";
import * as fs from "fs";
import ivm from "isolated-vm";
import puppeteer, { type Browser } from "puppeteer-core";
import ollama from "ollama";
import { MODEL } from "./llm-runner.ts";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] || "3000");

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

// --- HTTP GET ---

const BLOCKED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal", "169.254.169.254"];

async function httpGet(url: string): Promise<string> {
  console.log(`[httpGet] url: "${url}"`);
  try {
    const parsed = new URL(url);
    if (BLOCKED_HOSTS.includes(parsed.hostname) || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(parsed.hostname)) {
      return `Error: access to ${parsed.hostname} is blocked for security reasons.`;
    }
    const response = await fetch(url, {
      headers: { "User-Agent": "CodeAgent/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    console.log(`[httpGet] ${response.status} — ${text.length} chars`);
    return text.slice(0, 50000);
  } catch (e: any) {
    console.log(`[httpGet] error: ${e.message}`);
    return `HTTP error: ${e.message}`;
  }
}

import ts from "typescript";

// --- Type declarations for sandbox globals ---

const SANDBOX_DECLARATIONS = `
declare function log(msg: string): void;
declare function finalAnswer(value: any): void;
declare function webSearch(query: string): string;
declare function httpGet(url: string): string;
declare function readFile(path: string): string;
declare function writeFile(path: string, content: string): string;
`;

function typeCheckAndTranspile(code: string): { js: string | null; errors: string[] } {
  const fullSource = SANDBOX_DECLARATIONS + code;
  const fileName = "sandbox.ts";

  const host = ts.createCompilerHost({ strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext });
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion) => {
    if (name === fileName) return ts.createSourceFile(name, fullSource, languageVersion);
    return originalGetSourceFile.call(host, name, languageVersion);
  };
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => name === fileName ? fullSource : ts.sys.readFile(name);

  const program = ts.createProgram([fileName], { strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === fileName);

  if (diagnostics.length > 0) {
    // Adjust line numbers to account for prepended declarations
    const declLines = SANDBOX_DECLARATIONS.split("\n").length - 1;
    const errors = diagnostics.map(d => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start!);
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      return `Line ${Math.max(1, line + 1 - declLines)}: ${msg}`;
    });
    return { js: null, errors };
  }

  // Transpile (strip types)
  const { outputText } = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } });
  return { js: outputText, errors: [] };
}

// --- Sandbox execution ---

async function executeCode(code: string, { timeout = 60000, memoryLimit = 8 } = {}) {
  // Type-check first
  const { js, errors } = typeCheckAndTranspile(code);
  if (errors.length > 0) {
    return { success: false, error: "Type errors:\n" + errors.join("\n"), output: [], finalAnswer: false };
  }

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

    context.global.setSync("_httpGetRef", new ivm.Reference(async (url: string) => {
      return new ivm.ExternalCopy(await httpGet(url)).copyInto();
    }));

    context.global.setSync("_readFileRef", new ivm.Reference(async (path: string) => {
      const content = fs.readFileSync(path, "utf-8");
      return new ivm.ExternalCopy(content).copyInto();
    }));

    context.global.setSync("_writeFileRef", new ivm.Reference(async (path: string, content: string) => {
      fs.writeFileSync(path, content, "utf-8");
      return new ivm.ExternalCopy("ok").copyInto();
    }));

    // Bootstrap: define webSearch(), httpGet(), readFile(), writeFile() in the isolate using applySyncPromise
    context.evalSync(`
      function webSearch(query) {
        return _webSearchRef.applySyncPromise(undefined, [query]);
      }
      function httpGet(url) {
        return _httpGetRef.applySyncPromise(undefined, [url]);
      }
      function readFile(path) {
        return _readFileRef.applySyncPromise(undefined, [path]);
      }
      function writeFile(path, content) {
        return _writeFileRef.applySyncPromise(undefined, [path, content]);
      }
    `);

    // Run user code async so applySyncPromise can block the isolate thread
    // while the host thread resolves the search promise
    const result = await context.eval(js!, { timeout });

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
}).listen(PORT, () => console.log(`Sandbox API running on http://localhost:${PORT}`));

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(0); });
