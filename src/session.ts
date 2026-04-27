import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────

export type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolName?: string;
  toolUseId?: string;
  tool_calls?: unknown[];
};

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  totalTokens?: number;
};

// ── Session ──────────────────────────────────────────

export class Session {

  private entry: SessionEntry; // has sessionId that maps to session file

  private storePath: string;   // stores current / active session

  private cache: Message[] | null = null; // in-memory cache, populated on first getMessages()

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    // store tracks active session, actual sessions are stored in sessionId.jsonl files
    this.storePath = path.join(dir, "session.json");

    const existing = this.loadStore();
    if (existing && fs.existsSync(this.transcriptPath(existing.sessionId))) {
      this.entry = existing;
    } else {
      this.entry = {
        sessionId: crypto.randomUUID(),
        updatedAt: Date.now(),
      };
      this.writeHeader();
      this.saveStore();
    }
  }

  // gets session path
  private transcriptPath(id: string) : string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  // get current session path
  private get filePath() : string {
    return this.transcriptPath(this.entry.sessionId);
  }

  // basically loads current session from store file
  private loadStore(): SessionEntry | null {
    try { return JSON.parse(fs.readFileSync(this.storePath, "utf-8")); } catch { return null; }
  }
 
  private saveStore(): void {
    const tmp  = this.storePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.entry, null, 2)); 
    fs.renameSync(tmp, this.storePath);    
  }

  private writeHeader(): void {
    fs.writeFileSync(this.filePath, JSON.stringify( {
      type: "session", id: this.entry.sessionId, timestamp: new Date().toISOString()}) + "\n", { mode : 0o600 });
  }

  private append(msg: Message): string {
    const id = `msg-${crypto.randomUUID().slice(0, 8)}`;
    fs.appendFileSync(this.filePath, JSON.stringify({id: id, message: msg}) + "\n");
    if (this.cache) this.cache.push(msg);
    if (msg.usage) this.entry.totalTokens = (this.entry.totalTokens ?? 0) + msg.usage.totalTokens;
    this.entry.updatedAt = Date.now();
    this.saveStore();
    return id;
  }

  /** Load full conversation history for the agent. */
  getMessages(): Message[] {
    if (this.cache) return this.cache;
    const messages: Message[] = [];
    if (fs.existsSync(this.filePath)) {
      for (const line of fs.readFileSync(this.filePath, "utf-8").split("\n").filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message) messages.push(parsed.message);
        } catch { /* skip */ }
      }
    }
    this.cache = messages;
    return this.cache;
  }


  /** Append a user message. */
  addUserMessage(content: string): string {
    return this.append({ role: "user", content, timestamp: Date.now()});
  }

  /** Append an assistant response with optional usage stats. */
  addAssistantMessage(content: string, usage?: Message["usage"]): string {
    return this.append({
      role: "assistant",
      content,
      timestamp: Date.now(),
      usage,
    });
  }

  /** Append the full assistant tool-call message (once per LLM response). */
  addAssistantToolCalls(tool_calls: unknown[]): string {
    return this.append({
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      tool_calls,
    });
  }

  /** Append a single tool result. */
  addToolResult(toolName: string, result: string, toolUseId?: string): string {
    return this.append({
      role: "tool",
      content: result,
      toolName,
      toolUseId,
      timestamp: Date.now(),
    });
  }

  /** Reset session: rotate transcript, start fresh. Returns path to old transcript. */
  reset(): { rotatedFile: string; oldMessages: Message[] } {
    const oldMessages = this.getMessages();
    let n = 1;
    while (fs.existsSync(`${this.filePath}.reset.${n}`)) n++;

    const rotatedFile = `${this.filePath}.reset.${n}`;

    fs.renameSync(this.filePath, rotatedFile);

    this.cache = null;
    this.entry.updatedAt = Date.now();
    this.writeHeader();
    this.saveStore();

    return { rotatedFile: rotatedFile, oldMessages };
  }

  get metadata(): Readonly<SessionEntry> {
    return { ...this.entry };
  }
}
