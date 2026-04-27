import ollama, { type ChatResponse, type Message } from "ollama";
import chalk from "chalk";
import type { Session } from "./session.ts";

export const MODEL = "qwen3-coder:30b";

type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface LlmRunnerOptions {
  tools: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  executeTool: ToolExecutor;
  session: Session;
  systemPrompt: string;
}

const MAX_TOOL_ROUNDS = 6;

function buildMessages(session: Session, systemPrompt: string): Message[] {
  return [
    { role: "system", content: systemPrompt },
    ...session.getMessages().map(m => {
      const msg: Message = { role: m.role as Message["role"], content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      return msg;
    }),
  ];
}

export async function runLlm(opts: LlmRunnerOptions, round = 0): Promise<string> {
  const messages = buildMessages(opts.session, opts.systemPrompt);

  console.log("Sending "  + messages.length + " to llm");
  const response: ChatResponse = await ollama.chat({
    model: MODEL,
    messages,
    // think: true,
    // Standard generation parameters go here
    options: {
      temperature: 0.6,      // Balanced creativity
      top_p: 0.95,           // Nucleus sampling
      top_k: 20,             // Limit vocabulary pool
      num_predict: 4096,     // Equivalent to "max tokens"
      num_ctx: 32768,        // Context window size
      repeat_penalty: 1.05,  // Prevent repetitive loops
    },
    tools: opts.tools,
  });

  console.log(JSON.stringify(response));
  if (response.message.tool_calls?.length) {
    if (round >= MAX_TOOL_ROUNDS) {
      return response.message.content || "[Max tool call rounds reached]";
    }

    opts.session.addAssistantToolCalls(response.message.tool_calls);

    for (const call of response.message.tool_calls) {
      const name = call.function.name;
      const args = (call.function.arguments || {}) as Record<string, unknown>;
      console.log(chalk.cyan(`\n🔧 ${name}`) + chalk.gray(` (round ${round + 1}/${MAX_TOOL_ROUNDS})`));
      console.log(chalk.gray(JSON.stringify(args, null, 2)));
      const result = await opts.executeTool(name, args);
      opts.session.addToolResult(name, result);
    }

    return runLlm(opts, round + 1);
  }

  return response.message.content;
}

export async function runLlmChat(messages: Message[]): Promise<string> {
  const response: ChatResponse = await ollama.chat({
    model: MODEL,
    messages,
    options: {
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      num_predict: 4096,
      num_ctx: 32768,
      repeat_penalty: 1.05,
    },
  });
  return response.message.content;
}
