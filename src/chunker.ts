import { config } from "./config.js";
import { redact } from "./redact.js";

/**
 * Turns one Claude Code transcript JSONL line into zero or more redacted
 * episode chunks. Ground rules:
 *  - user text, assistant text, tool_use headers, tool_result text, and
 *    session summaries are all episodic ground truth → keep.
 *  - thinking blocks are skipped (opaque signatures, private reasoning).
 *  - attachment/meta lines are skipped (hook noise, mode flips).
 *  - everything is redacted BEFORE storage, and before any truncation or
 *    chunk split: a secret cut in two no longer matches its pattern.
 */

export interface EpisodeChunk {
  srcUuid: string;
  chunkNo: number;
  ts: string;
  role: "user" | "assistant" | "summary";
  kind: "text" | "tool_use" | "tool_result" | "summary";
  content: string;
}

export interface TranscriptLineMeta {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
}

const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_TOOL_INPUT_CHARS = 1500;

/** Trivial tool outputs carry no recall value and poison BM25. */
export function isTrivialToolResult(text: string): boolean {
  if (text.length < 40) return true;
  return /^(OK|Done|Success|Launching skill: \S+|Tool ran without output or errors\.?)$/i.test(text.trim());
}

export function splitChunks(text: string): string[] {
  const size = config.chunkChars;
  const overlap = config.chunkOverlap;
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}

function contentToStrings(content: unknown): { kind: EpisodeChunk["kind"]; text: string }[] {
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "text", text: redact(content) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: { kind: EpisodeChunk["kind"]; text: string }[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text": {
        const t = String(b.text ?? "");
        if (t.trim()) out.push({ kind: "text", text: redact(t) });
        break;
      }
      case "tool_use": {
        const name = String(b.name ?? "tool");
        let input = "";
        try {
          input = JSON.stringify(b.input ?? {});
        } catch {
          input = "[unserializable input]";
        }
        input = redact(input); // before truncation, which can cut a secret's closing delimiter
        if (input.length > MAX_TOOL_INPUT_CHARS) input = input.slice(0, MAX_TOOL_INPUT_CHARS) + "…";
        out.push({ kind: "tool_use", text: `[tool:${name}] ${input}` });
        break;
      }
      case "tool_result": {
        let text = "";
        const c = b.content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          text = c
            .map((p) => (p && typeof p === "object" && (p as any).type === "text" ? String((p as any).text ?? "") : ""))
            .join("\n");
        }
        text = redact(text.trim()); // before truncation, which can cut a secret's closing delimiter
        if (text && !isTrivialToolResult(text)) {
          if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS) + "…[tool output truncated]";
          out.push({ kind: "tool_result", text: `[tool result] ${text}` });
        }
        break;
      }
      default:
        break; // thinking, images, etc. — skipped
    }
  }
  return out;
}

export function parseLine(rawLine: string): { chunks: EpisodeChunk[]; meta: TranscriptLineMeta } {
  const meta: TranscriptLineMeta = {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return { chunks: [], meta };
  }
  if (typeof obj.sessionId === "string") meta.sessionId = obj.sessionId;
  if (typeof obj.cwd === "string") meta.cwd = obj.cwd;
  if (typeof obj.gitBranch === "string") meta.gitBranch = obj.gitBranch;

  const type = obj.type;
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const uuid = typeof obj.uuid === "string" ? obj.uuid : "";

  if (type === "summary") {
    const text = String((obj as any).summary ?? "").trim();
    if (!text) return { chunks: [], meta };
    const srcUuid = uuid || `summary:${String((obj as any).leafUuid ?? text.slice(0, 40))}`;
    return {
      chunks: [{ srcUuid, chunkNo: 0, ts, role: "summary", kind: "summary", content: redact(text) }],
      meta,
    };
  }

  if ((type !== "user" && type !== "assistant") || !uuid) return { chunks: [], meta };
  // Sidechains are subagent transcripts embedded in the same file — they are
  // real work product; keep them (their srcUuid keeps them deduped).
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return { chunks: [], meta };

  const role = type as "user" | "assistant";
  const pieces = contentToStrings(message.content);
  const chunks: EpisodeChunk[] = [];
  let chunkNo = 0;
  for (const piece of pieces) {
    // piece.text is already redacted WHOLE (contentToStrings): redacting per
    // chunk instead would miss any secret a chunk boundary splits in two.
    for (const part of splitChunks(piece.text)) {
      chunks.push({ srcUuid: uuid, chunkNo: chunkNo++, ts, role, kind: piece.kind, content: part });
    }
  }
  return { chunks, meta };
}
