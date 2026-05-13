import { runLlmChat, runLlmChatStream, MODEL_FAST, type TokenMetrics } from "./llm-runner.ts";
import type { Message } from "ollama";
import * as readline from "readline";
import chalk from "chalk";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";


const SANDBOX_PORT = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] || "3000");
const SANDBOX_URL = `http://localhost:${SANDBOX_PORT}/execute`;
const SANDBOX_SERVER = new URL("./sandbox-server.ts", import.meta.url).pathname;
const MAX_STEPS = 12;
const PLANNING_INTERVAL = 5;
const MAX_OBSERVATION_CHARS = 8000;
const COMPACTION_THRESHOLD = 40000;
const COMPACTION_KEEP_RECENT = 6;
const SESSIONS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "sessions");

// --- Token tracking ---

interface StepTrace {
  step: number;
  thought: string;
  code: string | null;
  observation: string;
  metrics: TokenMetrics;
}

interface TaskTrace {
  task: string;
  timestamp: string;
  steps: StepTrace[];
  totalMetrics: TokenMetrics;
  finalAnswer: string | null;
}

let currentTrace: TaskTrace | null = null;
let cumulativeMetrics: TokenMetrics = { promptTokens: 0, completionTokens: 0, totalDurationMs: 0 };

function addMetrics(target: TokenMetrics, source: TokenMetrics) {
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.totalDurationMs += source.totalDurationMs;
}

function printMetrics(label: string, metrics: TokenMetrics) {
  const total = metrics.promptTokens + metrics.completionTokens;
  console.log(chalk.gray(`  ${label}: ${metrics.promptTokens} prompt + ${metrics.completionTokens} completion = ${total} tokens (${(metrics.totalDurationMs / 1000).toFixed(1)}s)`));
}

function saveTrace(trace: TaskTrace) {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const filename = `trace-${trace.timestamp.replace(/[:.]/g, "-")}.json`;
  const filepath = path.join(SESSIONS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(trace, null, 2));
  console.log(chalk.gray(`  Trace saved: ${filepath}`));
}

// --- Planning prompts ---

const INITIAL_PLAN_PROMPT = (task: string) => `You are a PLANNER, not a coder. Your job is to analyze and plan ONLY.

You have been given this task:
\`\`\`
${task}
\`\`\`

Build a survey of facts and a plan. Respond ONLY with markdown headings and bullet points. NEVER write code blocks, function calls, or executable statements.

## 1. Facts survey
### 1.1. Facts given in the task
### 1.2. Facts to look up
### 1.3. Facts to derive

## 2. Plan
Write a step-by-step high-level plan using numbered steps.`;

const UPDATE_PLAN_PROMPT = (task: string, remainingSteps: number) => `You are a PLANNER, not a coder. Your job is to review progress and revise the plan ONLY.

The original task:
\`\`\`
${task}
\`\`\`

Based on the conversation history above, write an updated assessment. Respond ONLY with markdown headings and bullet points. NEVER write code blocks, function calls, or executable statements.

## 1. Updated facts
### 1.1. Facts given in the task
### 1.2. Facts learned so far
### 1.3. Facts still to look up
### 1.4. Facts still to derive

## 2. Updated plan
You have ${remainingSteps} steps remaining. Write a revised step-by-step plan using numbered steps.`;

// --- Sandbox server lifecycle ---

let sandboxProc: ChildProcess | null = null;

function startSandbox(): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    sandboxProc = spawn("node", ["--experimental-strip-types", SANDBOX_SERVER, `--port=${SANDBOX_PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
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

// --- Sandbox tool definitions ---

const SANDBOX_TOOLS = [
  { signature: "log(msg: string): void", description: "prints a message (captured in Observation)" },
  { signature: "finalAnswer(value: any): void", description: "returns the final result and stops execution" },
  { signature: "webSearch(query: string): string", description: "searches the web via Google, returns summarized results" },
  { signature: "httpGet(url: string): string", description: "fetches a URL via HTTP GET and returns the response body as text" },
  { signature: "readFile(path: string): string", description: "reads a file from the local filesystem and returns its contents" },
  { signature: "writeFile(path: string, content: string): string", description: "writes content to a file, returns 'ok' on success" },
];

// --- System prompt (smolagents-style) ---

const SYSTEM_PROMPT = () => `You are an expert assistant who solves tasks by writing TypeScript code.
Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

You proceed in a cycle of Thought, Code, and Observation steps.

At each step:
1. In 'Thought:', explain your reasoning and what you plan to do.
2. In 'Code:', write TypeScript code inside \`\`\`ts ... \`\`\` blocks.
3. The code is type-checked, then runs in a sandboxed V8 isolate. Use log() instead of console.log() to print output.
4. If there are type errors, they will appear in the Observation for you to fix.
5. Print outputs appear in the 'Observation:' field for your next step.
6. When done, call finalAnswer(value) to return your result.

Available sandbox APIs:
${SANDBOX_TOOLS.map(t => `- ${t.signature} — ${t.description}`).join("\n")}

Rules:
- Always write Thought: then \`\`\`ts ... \`\`\` code blocks.
- Use type annotations where they add clarity.
- Use log() for intermediate results you need in later steps.
- State does NOT persist between steps — each code block runs in a fresh environment.
- Use log() to capture values you need in later steps; they will appear in the Observation.
- After calling webSearch(), log the result and STOP. Do NOT process or interpret search results in the same code block. Wait for the Observation, then use the results in the next step.
- NEVER hardcode or assume data. Always use the actual results returned by webSearch().
- NEVER simulate or imagine Observation outputs. Only the system provides Observations. Write one Thought and one code block, then stop.
- Do NOT use require(), import, fetch, or Node.js APIs — only pure TS + the sandbox APIs above. Use httpGet() for direct URL fetching.
- When asked to read or analyze files, use readFile() to get the content, then explain it in finalAnswer(). Do NOT execute file contents as code.
- NEVER fabricate, recall, or reconstruct data from your training knowledge. If a task requires information, you MUST use webSearch() or readFile() to obtain it. If you cannot obtain the data through available tools, call finalAnswer() explaining what you cannot do and why.
- If a tool call fails (e.g., file not found, HTTP error), report the failure in finalAnswer(). Do NOT invent sample data, create hypothetical content, or guess what the result might have been.
- If a task is impossible with the available tools (e.g., executing shell commands, accessing databases), do NOT invent a workaround or fake the output. Instead, call finalAnswer() explaining the limitation.
- Don't give up on tasks that ARE possible. Solve the task, don't just describe how.

Here are examples using the available tools:

---
Task: "What are the first 8 fibonacci numbers?"

Thought: I'll compute fibonacci numbers iteratively and return them.
\`\`\`ts
const fib: number[] = [0, 1];
for (let i = 2; i < 8; i++) fib.push(fib[i-1] + fib[i-2]);
log('Fibonacci: ' + JSON.stringify(fib));
finalAnswer(fib);
\`\`\`
---
Task: "What is the population of Xanadu City?"

Thought: I don't know this — I need to search for it. I'll search and log the result.
\`\`\`ts
const result: string = webSearch("Xanadu City population");
log(result);
\`\`\`
Observation: Xanadu City has a population of approximately 2.37 million people.

Thought: I have the answer from the search results.
\`\`\`ts
finalAnswer("Xanadu City has a population of approximately 2.37 million people.");
\`\`\`
---
Task: "Which is taller, Structure Alpha or Structure Beta, and by how much?"

Thought: I need to search for the heights. I'll search and log the results.
\`\`\`ts
const results: string = webSearch("Structure Alpha vs Structure Beta height meters");
log(results);
\`\`\`
Observation: Structure Alpha is 187 meters tall. Structure Beta is 264 meters tall.

Thought: Now I can calculate the difference using the actual data from the search.
\`\`\`ts
const alpha: number = 187;
const beta: number = 264;
const diff: number = beta - alpha;
finalAnswer(\`Structure Beta (\${beta}m) is taller than Structure Alpha (\${alpha}m) by \${diff} meters.\`);
\`\`\`
---
Task: "Find the current price of CoinX and CoinY, and calculate the X/Y ratio."

Thought: I'll search for current prices first.
\`\`\`ts
const prices: string = webSearch("CoinX CoinY price today USD");
log(prices);
\`\`\`
Observation: CoinX is trading at $542 and CoinY at $38.

Thought: Now I'll calculate the ratio from the search results.
\`\`\`ts
const coinX: number = 542;
const coinY: number = 38;
const ratio: number = Math.round((coinX / coinY) * 100) / 100;
finalAnswer(\`CoinX: $\${coinX}, CoinY: $\${coinY}. The X/Y ratio is \${ratio}.\`);
\`\`\`
---

Now solve the task given to you.${customInstructions ? "\n\nAdditional instructions:\n" + customInstructions : ""}`;

let customInstructions: string | null = null;

// --- Observation truncation ---

function truncateObservation(text: string, max = MAX_OBSERVATION_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const trimmed = text.length - max;
  return text.slice(0, half) + `\n\n... [${trimmed} characters truncated] ...\n\n` + text.slice(-half);
}

// --- Parse LLM output ---

function parseResponse(text: string): { thought: string; code: string | null } {
  const codeBlocks = [...text.matchAll(/```(?:ts|typescript|js|javascript)\s*\n([\s\S]*?)```/g)];
  const lastBlock = codeBlocks.length > 0 ? codeBlocks[codeBlocks.length - 1] : null;
  const thought = text.replace(/```(?:ts|typescript|js|javascript)\s*\n[\s\S]*?```/g, "").trim();
  return { thought, code: lastBlock ? lastBlock[1].trim() : null };
}

// --- Planning ---

async function runPlanningStep(task: string, step: number, messages: Message[]): Promise<void> {
  const isFirst = step === 0;
  console.log(chalk.blue(`\n── ${isFirst ? "Initial Plan" : "Updated Plan"} ──`));

  const planPrompt = isFirst
    ? INITIAL_PLAN_PROMPT(task)
    : UPDATE_PLAN_PROMPT(task, MAX_STEPS - step);

  // Build planning messages: full history + planning request
  const planMessages: Message[] = [
    ...messages,
    { role: "user", content: planPrompt },
  ];

  const plan = await runLlmChat(planMessages, MODEL_FAST);
  console.log(chalk.blue(plan));

  // Strip any code blocks the LLM may have generated despite instructions
  const cleanPlan = plan.replace(/```[\s\S]*?```/g, "").trim();

  // Inject the plan into the conversation so the agent can follow it
  messages.push({ role: "assistant", content: cleanPlan });
  messages.push({ role: "user", content: "Now proceed and carry out this plan." });
}

// --- Agent memory ---

let messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT() }];

function resetMemory() {
  messages = [{ role: "system", content: SYSTEM_PROMPT() }];
}

// --- Conversation compaction ---

async function compactMessages(): Promise<void> {
  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (totalChars < COMPACTION_THRESHOLD) return;

  const systemMsg = messages[0];
  const toSummarize = messages.slice(1, -COMPACTION_KEEP_RECENT);
  const recent = messages.slice(-COMPACTION_KEEP_RECENT);

  if (toSummarize.length < 4) return;

  console.log(chalk.blue(`\n── Compacting conversation (${Math.round(totalChars / 1000)}k chars → summarizing ${toSummarize.length} older messages) ──`));

  const MAX_SUMMARY_INPUT = 12000;
  let conversationText = toSummarize.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
  if (conversationText.length > MAX_SUMMARY_INPUT) {
    conversationText = conversationText.slice(0, MAX_SUMMARY_INPUT) + `\n\n... [${conversationText.length - MAX_SUMMARY_INPUT} chars truncated]`;
  }

  const summaryPrompt: Message[] = [
    { role: "system", content: "You are a summarizer. Condense the following agent conversation into a brief summary preserving: (1) the original task, (2) key facts discovered, (3) what approaches were tried and their outcomes, (4) current state/progress. Be concise — bullet points preferred. Do NOT include code blocks." },
    { role: "user", content: conversationText },
  ];

  const summary = await runLlmChat(summaryPrompt, MODEL_FAST);
  const cleanSummary = summary.replace(/```[\s\S]*?```/g, "").trim();

  messages = [
    systemMsg,
    { role: "user", content: `[Conversation summary — older messages were compacted to save context]\n\n${cleanSummary}` },
    { role: "assistant", content: "Understood. I have the context from the summary above and will continue from where we left off." },
    ...recent,
  ];

  const newChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  console.log(chalk.blue(`── Compacted: ${Math.round(totalChars / 1000)}k → ${Math.round(newChars / 1000)}k chars ──\n`));
}

// --- Agent loop ---

async function runCodeAgent(task: string, reset = true, plan = false): Promise<void> {
  if (reset) resetMemory();

  await compactMessages();

  currentTrace = {
    task,
    timestamp: new Date().toISOString(),
    steps: [],
    totalMetrics: { promptTokens: 0, completionTokens: 0, totalDurationMs: 0 },
    finalAnswer: null,
  };

  messages.push({ role: "user", content: `Task: "${task}"` });

  // Initial planning step (only when requested with /plan)
  if (plan) {
    await runPlanningStep(task, 0, messages);
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    if (step > 0) await compactMessages();
    // Periodic re-planning when the task is taking many steps
    if (step > 0 && step % PLANNING_INTERVAL === 0) {
      await runPlanningStep(task, step, messages);
    }
    console.log(chalk.yellow(`\n--- Step ${step + 1}/${MAX_STEPS} ---`));

    process.stdout.write(chalk.cyan("Thinking: "));
    let inCodeBlock = false;
    const { text: llmOutput, metrics } = await runLlmChatStream(messages, (token) => {
      if (!inCodeBlock) {
        if (token.includes("```")) {
          inCodeBlock = true;
          process.stdout.write("\n");
        } else {
          process.stdout.write(token);
        }
      }
    });
    if (!inCodeBlock) process.stdout.write("\n");

    addMetrics(currentTrace.totalMetrics, metrics);
    addMetrics(cumulativeMetrics, metrics);
    printMetrics("Step", metrics);
    printMetrics("Cumulative", cumulativeMetrics);

    const { thought, code } = parseResponse(llmOutput);

    if (!code) {
      console.log(chalk.gray("Agent (no code):"), thought);
      currentTrace.steps.push({ step: step + 1, thought, code: null, observation: "(no code)", metrics });
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
      currentTrace.steps.push({ step: step + 1, thought, code, observation, metrics });
      messages.push({ role: "user", content: `Observation: ${observation}` });
      continue;
    }
    const logs = result.output?.join("\n") || "";
    const rawObservation = result.success
      ? `${logs}${result.result != null ? "\nResult: " + result.result : ""}`
      : `Error: ${result.error}\n${logs}\nIf this error indicates the task cannot be completed (e.g., file not found, resource unavailable), report the failure via finalAnswer(). Only retry if you can fix the underlying issue.`;

    const observation = truncateObservation(rawObservation);
    console.log(chalk.gray("Observation:"), observation);

    currentTrace.steps.push({ step: step + 1, thought, code, observation, metrics });

    // Check if finalAnswer was called at runtime
    if (result.success && result.finalAnswer) {
      currentTrace.finalAnswer = result.result ?? null;
      console.log(chalk.green("\n✅ Final Answer:"), result.result);
      printMetrics("Task total", currentTrace.totalMetrics);
      saveTrace(currentTrace);
      return;
    }

    const stepsRemaining = MAX_STEPS - step - 1;
    const budgetNote = stepsRemaining <= 3
      ? `\n[⚠️ ${stepsRemaining} step${stepsRemaining === 1 ? "" : "s"} remaining — wrap up or call finalAnswer()]`
      : `\n[${stepsRemaining} steps remaining]`;
    messages.push({ role: "user", content: `Observation: ${observation}${budgetNote}` });
  }

  console.log(chalk.red("\n⚠️  Max steps reached without final answer."));
  printMetrics("Task total", currentTrace.totalMetrics);
  saveTrace(currentTrace);
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
    if (input.startsWith("/instructions ")) {
      customInstructions = input.slice(14).trim() || null;
      resetMemory();
      nextReset = true;
      console.log(chalk.yellow(customInstructions ? `[Instructions set: "${customInstructions}"]` : "[Instructions cleared]"));
      prompt();
      return;
    }
    try {
      const usePlan = input.startsWith("/plan ");
      const task = usePlan ? input.slice(6).trim() : input.trim();
      if (!task) { prompt(); return; }
      await runCodeAgent(task, nextReset, usePlan);
      nextReset = false; // subsequent tasks keep memory
    } catch (e) {
      console.error(chalk.red("Error:"), e);
    }
    prompt();
  });
}


process.on("exit", stopSandbox);
process.on("uncaughtException", (e) => { console.error(chalk.red("Uncaught exception:"), e); stopSandbox(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(chalk.red("Unhandled rejection:"), e); stopSandbox(); process.exit(1); });

console.log(chalk.yellow("--- Code Agent (smolagents-style) ---"));
console.log(chalk.gray("Generates TS code → runs in V8 sandbox. '/plan <task>' for complex tasks, '/reset' to clear memory, '/exit' to quit.\n"));

await startSandbox();
prompt();
