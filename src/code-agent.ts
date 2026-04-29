import { runLlmChat } from "./llm-runner.ts";
import type { Message } from "ollama";
import * as readline from "readline";
import chalk from "chalk";
import * as http from "http";
import { spawn, type ChildProcess } from "child_process";

const SANDBOX_URL = "http://localhost:3000/execute";
const SANDBOX_SERVER = new URL("./sandbox-server.ts", import.meta.url).pathname;
const MAX_STEPS = 12;
const PLANNING_INTERVAL = 5;

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

// --- Sandbox tool definitions ---

const SANDBOX_TOOLS = [
  { signature: "log(msg: string): void", description: "prints a message (captured in Observation)" },
  { signature: "finalAnswer(value: any): void", description: "returns the final result and stops execution" },
  { signature: "webSearch(query: string): string", description: "searches the web via Google, returns summarized results" },
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
- Do NOT use require(), import, fetch, or Node.js APIs — only pure TS + the sandbox APIs above.
- Don't give up. Solve the task, don't just describe how.

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
Task: "What is the population of Tokyo?"

Thought: I need to search for this information. I'll search and log the result.
\`\`\`ts
const result: string = webSearch("Tokyo population");
log(result);
\`\`\`
Observation: Tokyo has a population of approximately 13.96 million people as of 2024.

Thought: I have the answer from the search results.
\`\`\`ts
finalAnswer("Tokyo has a population of approximately 13.96 million people.");
\`\`\`
---
Task: "Which is taller, the Eiffel Tower or the Empire State Building, and by how much?"

Thought: I need to search for the heights of both structures. I'll search and log the results.
\`\`\`ts
const results: string = webSearch("Eiffel Tower vs Empire State Building height meters");
log(results);
\`\`\`
Observation: The Eiffel Tower is 330 meters tall. The Empire State Building is 443 meters tall.

Thought: Now I can calculate the difference using the actual data from the search.
\`\`\`ts
const eiffel: number = 330;
const empire: number = 443;
const diff: number = empire - eiffel;
log(\`Empire State Building is taller by \${diff} meters\`);
finalAnswer(\`The Empire State Building (443m) is taller than the Eiffel Tower (330m) by \${diff} meters.\`);
\`\`\`
---
Task: "Find the current price of Bitcoin and Ethereum, and calculate the BTC/ETH ratio."

Thought: I'll search for current crypto prices first.
\`\`\`ts
const prices: string = webSearch("Bitcoin Ethereum price today USD");
log(prices);
\`\`\`
Observation: Bitcoin is trading at $94,250 and Ethereum at $3,180.

Thought: Now I'll calculate the ratio from the search results.
\`\`\`ts
const btc: number = 94250;
const eth: number = 3180;
const ratio: number = Math.round((btc / eth) * 100) / 100;
log(\`BTC/ETH ratio: \${ratio}\`);
finalAnswer(\`Bitcoin: $\${btc}, Ethereum: $\${eth}. The BTC/ETH ratio is \${ratio}.\`);
\`\`\`
---

Now solve the task given to you.${customInstructions ? "\n\nAdditional instructions:\n" + customInstructions : ""}`;

let customInstructions: string | null = null;

// --- Parse LLM output ---

function parseResponse(text: string): { thought: string; code: string | null } {
  const codeMatch = text.match(/```(?:ts|typescript|js|javascript)\s*\n([\s\S]*?)```/);
  const thought = text.replace(/```(?:ts|typescript|js|javascript)\s*\n[\s\S]*?```/, "").trim();
  return { thought, code: codeMatch ? codeMatch[1].trim() : null };
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

  const plan = await runLlmChat(planMessages);
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

// --- Agent loop ---

async function runCodeAgent(task: string, reset = true, plan = false): Promise<void> {
  if (reset) resetMemory();

  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (totalChars > 50000) {
    console.log(chalk.red(`⚠️  Memory is large (~${Math.round(totalChars / 1000)}k chars). Consider typing /reset to avoid exceeding context window.`));
  }

  messages.push({ role: "user", content: `Task: "${task}"` });

  // Initial planning step (only when requested with /plan)
  if (plan) {
    await runPlanningStep(task, 0, messages);
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    // Periodic re-planning when the task is taking many steps
    if (step > 0 && step % PLANNING_INTERVAL === 0) {
      await runPlanningStep(task, step, messages);
    }
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
      : `Error: ${result.error}\n${logs}\nThis failed. Avoid repeating the same mistake — if this has failed before, try a fundamentally different approach.`;

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

console.log(chalk.yellow("--- Code Agent (smolagents-style) ---"));
console.log(chalk.gray("Generates TS code → runs in V8 sandbox. '/plan <task>' for complex tasks, '/reset' to clear memory, '/exit' to quit.\n"));

await startSandbox();
prompt();
