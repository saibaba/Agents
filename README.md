# Code Agent

An AI agent that solves tasks by generating and executing TypeScript code in a sandboxed V8 isolate.

## How It Works

The agent operates in a **Thought → Code → Observation** loop:

1. You give it a task in natural language
2. The LLM reasons about the task (Thought) and writes TypeScript code
3. The code is **type-checked** — if there are type errors, they're fed back to the LLM to self-correct
4. Clean code is transpiled to JS and executed in an **isolated V8 sandbox**
5. Execution output (logs, results, errors) is returned as an Observation
6. The LLM uses the observation to decide the next step
7. The loop continues until `finalAnswer()` is called or max steps are reached

## Architecture

```
User task
  → LLM (via llm-runner.ts)
  → Type-check with TypeScript compiler (strict mode)
  → If type errors → feed back as observation → LLM self-corrects
  → If clean → strip types → execute in V8 isolate
  → Observation fed back to LLM
  → Repeat until finalAnswer() or max steps
```

## Files

### `src/code-agent.ts`

The agent itself. Provides a REPL where you type tasks. Manages:

- **System prompt** — instructs the LLM to write TypeScript in a Thought/Code/Observation cycle
- **Code parsing** — extracts TypeScript from markdown code fences in LLM output
- **Agent loop** — sends code to the sandbox, feeds observations back, detects `finalAnswer`
- **Planning** — periodic re-planning steps to keep the agent on track (see below)
- **Memory** — conversation history persists across tasks; type `/reset` to clear
- **Sandbox lifecycle** — auto-starts and stops the sandbox server

### `src/sandbox-server.ts`

An HTTP server that executes code in a V8 isolate via `isolated-vm`. Provides:

- **Type-checking** — validates TypeScript with `strict: true` before execution, returns diagnostics on failure
- **Transpilation** — strips types after validation, executes plain JS in the isolate
- **Sandbox globals**:
  - `log(msg)` — captures print output
  - `finalAnswer(value)` — signals task completion
  - `webSearch(query)` — searches Google via Puppeteer, summarizes results with the LLM
- **Isolation** — code runs in a fresh V8 isolate per request with no filesystem, network, or Node.js API access

### `src/llm-runner.ts`

Shared LLM interface used by both the code agent and the tool-calling agent (`agent.ts`). Exports `runLlmChat()` for plain chat and `runLlm()` for tool-calling workflows.

## Planning

For complex tasks, the agent uses periodic **planning steps** to stay on track.

### How it works

- **By default, no upfront planning** — the agent starts executing immediately. Simple tasks finish in 1-2 steps with zero planning overhead.
- **`/plan <task>`** — prefix a task with `/plan` to trigger an initial planning step where the LLM surveys facts and creates a step-by-step plan before writing any code. Recommended for complex, multi-step research tasks.
- **Every 5 action steps** — if the agent is still running, it automatically pauses to review progress: what facts have been learned, what's still missing, and how many steps remain. It then revises its plan.
- Planning steps do not execute code; they only produce a plan that guides subsequent action steps.

### Future enhancement

An LLM-based task classifier could be added to detect complex tasks upfront and trigger an initial planning step only when needed. A quick LLM call ("Is this task simple or complex?") would add minimal latency while giving complex tasks the benefit of upfront planning.

### When planning matters

Planning helps most on **multi-step research tasks** where early results change the strategy.

**Tasks that benefit from planning:**

- "Search for the top 3 most populated countries in Asia, find their GDP per capita, and calculate which one has the best ratio of GDP to population"
- "Find out when the next 3 SpaceX launches are scheduled, what rockets they're using, and summarize the missions"
- "Compare the current weather in Tokyo, London, and New York, then recommend which city is best to visit this week and explain why"

**Tasks that complete before re-planning triggers:**

- "What is 2+2"
- "Sort these numbers: 5, 3, 1, 4, 2"
- "What is the capital of France"

These are solved in 1-2 steps, so only the initial plan runs.

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Install and start Ollama

```bash
# macOS
brew install ollama
ollama serve
```

### 3. Pull the model

```bash
ollama pull qwen3-coder:30b
```

You can change the model in `src/llm-runner.ts` (the `MODEL` constant).

### 4. Verify Chrome is available

The web search feature uses Puppeteer with your local Chrome. Default path is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Override with:

```bash
export CHROME_PATH=/usr/bin/google-chrome  # Linux example
```

## Running

```bash
bun src/code-agent.ts
```

To use a different port (default is 3000):

```bash
bun src/code-agent.ts --port=3001
```

This will:
1. Start the V8 sandbox server (via Node.js, on port 3000)
2. Launch the REPL — type a task and press Enter

### Commands

- `/plan <task>` — run a task with an initial planning step (recommended for complex, multi-step tasks)
- `/instructions <text>` — set custom instructions appended to the system prompt (e.g., `/instructions Always respond in French`). Resets memory.
- `/reset` — clear conversation memory
- `/exit` — quit (stops the sandbox server)

### Requirements

- [Bun](https://bun.sh) — runs the agent
- [Node.js](https://nodejs.org) v24+ — runs the sandbox server (isolated-vm requires Node)
- [Ollama](https://ollama.com) — local LLM inference
- Google Chrome — used by Puppeteer for web search

### Environment Variables

- `CHROME_PATH` — path to Chrome binary (defaults to macOS location)

## System Prompt Design

### Few-shot examples

The system prompt includes 4 worked examples covering different patterns:
1. **Pure computation** — single step, no search, direct `finalAnswer`
2. **Simple search** — search → log → stop → answer in next step
3. **Search + computation** — search → log → stop → calculate from real data
4. **Multi-value search + math** — search → log → stop → extract multiple values and compute

Examples 2-4 reinforce the critical rule: search and stop, process in the next step.

### Dynamic tool signatures

Sandbox tools are defined in a `SANDBOX_TOOLS` array and rendered into the system prompt automatically. Adding a new tool requires only adding an entry to the array — no prompt editing needed.

### Error recovery guidance

When code execution fails, the observation includes retry guidance: *"This failed. Avoid repeating the same mistake — if this has failed before, try a fundamentally different approach."* This helps the agent break out of error loops.

### Custom instructions

The `/instructions` command appends user-defined instructions to the system prompt, allowing behavior customization without editing code (e.g., language preferences, output format requirements).

## Testing

```bash
./tests/smoke-sandbox.sh
```

Runs 6 tests covering valid TypeScript, type error detection, plain JS fallback, log output, runtime errors, and webSearch availability.

## Implementation Notes

A record of the iterative design process and lessons learned while building this agent.

### v1: Basic JavaScript agent

Started by copying `agent.ts` (the tool-calling agent) and adapting it into a code agent. The LLM generated JavaScript, which was executed in a V8 isolate via `isolated-vm`. The sandbox server (`server.js`) was initially copied from a separate project and referenced by absolute path.

**Changes made:**
- Refactored `server.js` into TypeScript (`sandbox-server.ts`) so the project is self-contained
- The sandbox server is spawned as a child process by `code-agent.ts` using `node --experimental-strip-types` (because `isolated-vm` is a native addon that only works with Node, not Bun)
- Extracted `runLlmChat()` into `llm-runner.ts` so both the tool-calling agent and code agent share the same model config

### v2: finalAnswer detection fix

The initial implementation detected `finalAnswer` by string-matching `finalAnswer(` in the source code. This was fragile — it would false-positive on conditional branches where `finalAnswer` appears but doesn't execute.

**Fix:** Added `finalAnswer` as a real global in the sandbox that sets a flag when called. The sandbox response includes `finalAnswer: true/false` so the agent loop checks the runtime flag, not the source code.

### v3: Resilient loop

Two problems with the naive loop:
1. When the LLM responded without a code block, the loop broke entirely
2. If the sandbox server was down, the agent crashed

**Fixes:**
- No code → nudge the LLM with "Please write code to proceed" and continue
- Sandbox errors caught in try/catch and fed back as observations

### v4: Web search via Puppeteer

Added `webSearch()` as a sandbox global using `isolated-vm`'s `applySyncPromise` pattern. The isolate calls `webSearch(query)` synchronously, while the host side asynchronously launches Puppeteer, navigates to Google, and returns results.

**Evolution:**
- First tried DuckDuckGo with raw HTTP — blocked by CAPTCHA
- Switched to Puppeteer with headless Chrome — blocked by Google's bot detection
- Switched to headed Chrome with `--disable-blink-features=AutomationControlled` — worked
- Initially parsed results with CSS selectors — fragile, Google's DOM changes frequently
- Switched to returning raw `document.body.innerText` — too large, overwhelmed the agent's context
- Added LLM summarization: the sandbox server calls the LLM to summarize raw search results before returning them to the isolate

### v5: TypeScript type-checking

Research showed that TypeScript improves LLM code generation quality — not because of better algorithms, but because type errors provide a self-correction feedback loop. The key insight: just stripping types gives no benefit; you need to actually type-check and feed errors back.

**Implementation:**
- LLM generates TypeScript code
- Sandbox server type-checks with `tsc` (strict mode) against declared sandbox globals
- Type errors returned as observations → LLM self-corrects
- Clean code transpiled to JS → executed in V8 isolate

### v6: Planning steps

Implemented periodic re-planning inspired by the smolagents framework. The agent pauses every 5 steps to review progress and revise its plan.

**Iteration:**
- First implementation ran an initial plan on every task. Testing showed the LLM ignored "Do NOT write code" instructions and generated 14+ fake `webSearch()` calls inside the planning step, wasting tokens
- Strengthened planning prompts: "You are a PLANNER, not a coder. NEVER write code blocks."
- Added code block stripping from planning output as a safety net
- Removed automatic initial planning — simple tasks don't need it. Added `/plan` command so users opt-in for complex tasks
- Periodic re-planning at step 5 still triggers automatically

### v7: Anti-hallucination rules

Testing revealed a critical problem: the LLM would call `webSearch()` and hardcode fake results in the same code block, ignoring the actual search response.

**Root cause:** The LLM wrote the search call and the answer in one step, before seeing the observation.

**Fix:** Two new system prompt rules:
- "After calling webSearch(), log the result and STOP" — forces a 2-step pattern
- "NEVER hardcode or assume data" — eliminates fabricated results

Before/after testing confirmed the fix: the LLM now searches in step 1, processes real results in step 2.

### v8: Anti-simulation rule

Testing showed the LLM sometimes role-played entire Thought → Observation → Thought → Code sequences within a single response — simulating fake observations in its head before writing actual code. While the parser handled this correctly (it extracted the real code block), the fake observations wasted tokens and risked confusing the LLM in later steps if it mistook its own imagined observations for real ones.

**Fix:** Added a rule: "NEVER simulate or imagine Observation outputs. Only the system provides Observations. Write one Thought and one code block, then stop."

### v9: File analysis guard

When asked to read and analyze a file, the LLM would read it successfully with `readFile()` but then try to re-execute the file's contents as code in the sandbox. The type-checker rejected it (missing imports), and the error poisoned the conversation memory — causing the LLM to believe `readFile` was broken and hallucinate file contents in follow-up tasks.

**Fix:** Added a rule: "When asked to read or analyze files, use readFile() to get the content, then explain it in finalAnswer(). Do NOT execute file contents as code."

### Code review findings

A systematic review identified 14 issues. Key fixes applied:
- Race condition in sandbox startup (resolve/reject/timeout could all fire)
- stdout listener not removed after sandbox ready
- System prompt date evaluated once at load time (now a function)
- Prompt falsely claimed state persists between steps
- No timeout on sandbox HTTP requests (added 90s timeout)
- Unbounded message growth (added warning at 50k chars)
- Hardcoded Chrome path (now env var with default)
- Sandbox execution timeout too short for web search (increased to 60s)
- Model name duplicated across files (single-sourced in llm-runner.ts)
