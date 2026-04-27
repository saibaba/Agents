import { runLlmChat } from "./llm-runner.ts";
import type { Message } from "ollama";
import * as readline from "readline";
import chalk from "chalk";
import * as http from "http";
import { spawn, type ChildProcess } from "child_process";

const SANDBOX_URL = "http://localhost:3000/execute";
const SANDBOX_SERVER = new URL("./sandbox-server.ts", import.meta.url).pathname;
const MAX_STEPS = 6;

// --- Sandbox server lifecycle ---

let sandboxProc: ChildProcess | null = null;

function startSandbox(): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    sandboxProc = spawn("node", ["--experimental-strip-types", SANDBOX_SERVER], { stdio: ["ignore", "pipe", "pipe"] });
    sandboxProc.stderr!.on("data", (d: Buffer) => process.stderr.write(chalk.gray("[sandbox] " + d)));
    sandboxProc.on("error", (e) => { if (!resolved) { resolved = true; reject(e); } });
    sandboxProc.on("close", (code) => { sandboxProc = null; });
    const onStdout = (d: Buffer) => {
      const msg = d.toString();
      if (!resolved && msg.includes("running on")) {
        resolved = true;
        sandboxProc!.stdout!.removeListener("data", onStdout);
        console.log(chalk.green("[sandbox] " + msg.trim()));
        resolve();
      }
    };
    sandboxProc.stdout!.on("data", onStdout);
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error("Sandbox server failed to start")); } }, 5000);
  });
}

function stopSandbox() {
  if (sandboxProc) { sandboxProc.kill(); sandboxProc = null; }
}

// --- Sandbox execution ---

function runInSandbox(code: string): Promise<{ success: boolean; result?: string; output?: string[]; error?: string; finalAnswer?: boolean }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code });
    const req = http.request(SANDBOX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ success: false, error: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error("Sandbox request timed out")); });
    req.end(body);
  });
}

// --- System prompt (smolagents-style) ---

const SYSTEM_PROMPT = () => `You are an expert assistant who solves tasks by writing JavaScript code.
Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

You proceed in a cycle of Thought, Code, and Observation steps.

At each step:
1. In 'Thought:', explain your reasoning and what you plan to do.
2. In 'Code:', write JavaScript code inside \`\`\`js ... \`\`\` blocks.
3. The code runs in a sandboxed V8 isolate. Use log() instead of console.log() to print output.
4. Print outputs appear in the 'Observation:' field for your next step.
5. When done, call finalAnswer(value) to return your result.

Available sandbox APIs:
- log(msg): prints a message (captured in Observation)
- finalAnswer(value): returns the final result and stops execution
- webSearch(query): searches the web via Google, returns text snippets

Rules:
- Always write Thought: then \`\`\`js ... \`\`\` code blocks.
- Use log() for intermediate results you need in later steps.
- State does NOT persist between steps — each code block runs in a fresh environment.
- Use log() to capture values you need in later steps; they will appear in the Observation.
- webSearch() is synchronous — just call it and use the result directly.
- Do NOT use require(), import, fetch, or Node.js APIs — only pure JS + the sandbox APIs above.
- Don't give up. Solve the task, don't just describe how.

Example:
---
Task: "What are the first 8 fibonacci numbers?"

Thought: I'll compute fibonacci numbers iteratively and return them.
\`\`\`js
const fib = [0, 1];
for (let i = 2; i < 8; i++) fib.push(fib[i-1] + fib[i-2]);
log('Fibonacci: ' + JSON.stringify(fib));
finalAnswer(fib);
\`\`\`
---

Now solve the task given to you.`;

// --- Parse LLM output ---

function parseResponse(text: string): { thought: string; code: string | null } {
  const codeMatch = text.match(/```(?:js|javascript)\s*\n([\s\S]*?)```/);
  const thought = text.replace(/```(?:js|javascript)\s*\n[\s\S]*?```/, "").trim();
  return { thought, code: codeMatch ? codeMatch[1].trim() : null };
}

// --- Agent memory ---

let messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT() }];

function resetMemory() {
  messages = [{ role: "system", content: SYSTEM_PROMPT() }];
}

// --- Agent loop ---

async function runCodeAgent(task: string, reset = true): Promise<void> {
  if (reset) resetMemory();

  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (totalChars > 50000) {
    console.log(chalk.red(`⚠️  Memory is large (~${Math.round(totalChars / 1000)}k chars). Consider typing /reset to avoid exceeding context window.`));
  }

  messages.push({ role: "user", content: `Task: "${task}"` });

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(chalk.yellow(`\n--- Step ${step + 1}/${MAX_STEPS} ---`));

    const llmOutput = await runLlmChat(messages);
    const { thought, code } = parseResponse(llmOutput);

    if (thought) console.log(chalk.cyan("Thought:"), thought);

    if (!code) {
      console.log(chalk.gray("Agent (no code):"), thought);
      messages.push({ role: "assistant", content: llmOutput });
      messages.push({ role: "user", content: "Observation: No code was generated. Please write code to proceed." });
      continue;
    }

    console.log(chalk.magenta("Code:"), "\n" + code);
    messages.push({ role: "assistant", content: llmOutput });

    // Execute in sandbox
    let result: Awaited<ReturnType<typeof runInSandbox>>;
    try {
      result = await runInSandbox(code);
    } catch (e: any) {
      const observation = `Error: Sandbox unavailable — ${e.message}`;
      console.log(chalk.gray("Observation:"), observation);
      messages.push({ role: "user", content: `Observation: ${observation}` });
      continue;
    }
    const logs = result.output?.join("\n") || "";
    const observation = result.success
      ? `${logs}${result.result != null ? "\nResult: " + result.result : ""}`
      : `Error: ${result.error}\n${logs}`;

    console.log(chalk.gray("Observation:"), observation);

    // Check if finalAnswer was called at runtime
    if (result.success && result.finalAnswer) {
      console.log(chalk.green("\n✅ Final Answer:"), result.result);
      return;
    }

    messages.push({ role: "user", content: `Observation: ${observation}` });
  }

  console.log(chalk.red("\n⚠️  Max steps reached without final answer."));
}

// --- REPL ---

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let nextReset = true;

function prompt() {
  rl.question(chalk.blue("\nTask: "), async (input) => {
    if (input === "/exit") { stopSandbox(); rl.close(); return; }
    if (input === "/reset") {
      resetMemory();
      nextReset = true;
      console.log(chalk.yellow("[Memory reset]"));
      prompt();
      return;
    }
    try {
      await runCodeAgent(input.trim(), nextReset);
      nextReset = false; // subsequent tasks keep memory
    } catch (e) {
      console.error(chalk.red("Error:"), e);
    }
    prompt();
  });
}

console.log(chalk.yellow("--- Code Agent (smolagents-style) ---"));
console.log(chalk.gray("Generates JS code → runs in V8 sandbox. Type '/reset' to clear memory, '/exit' to quit.\n"));

await startSandbox();
prompt();
