import { parseObject } from './json';
import { parseCliCommands, type SlashCommand } from './slashCommands';

/**
 * Claude Code's headless stream-json protocol (`claude -p --input-format stream-json --output-format stream-json`), as
 * far as the board reads it: the `initialize` control request's answer (commands, models, version) and the
 * `system/commands_changed` events that follow while plugins and MCP servers load.
 */

/** The id the board's `initialize` request carries; its answer is matched by it (answers can come out of order). */
export const INITIALIZE_REQUEST_ID = 'devdesk-initialize';

/** The `initialize` request, as one stdin line's JSON. */
export const INITIALIZE_REQUEST = { type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } };

/** A row of the CLI's model picker (`initialize` → `models`). */
export interface CliModel {
  /** What `--model` takes, exactly as given (`global.anthropic.claude-opus-5-5[1m]`, `sonnet`, a router ARN, `default`). */
  value: string;
  /** `Opus (1M context)`. */
  displayName: string;
  /** `Opus 5.5 · Recommended · Best for everyday, complex tasks`. */
  description: string;
  /** The `--effort` levels it supports; none for models without effort (Bedrock routers). */
  efforts: string[];
}

/** What the CLI told the board. */
export interface CliListing {
  commands: SlashCommand[];
  models: CliModel[];
  /** `claude_code_version`, when given. */
  version?: string;
}

/** The model rows of an `initialize` answer: rows with a string `value`, without duplicates. */
export function parseCliModels(listed: unknown): CliModel[] {
  if (!Array.isArray(listed)) return [];
  const seen = new Set<string>();
  const models: CliModel[] = [];
  for (const row of listed as Record<string, unknown>[]) {
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const levels = row.supportsEffort !== false && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels : [];
    models.push({
      value,
      displayName: typeof row.displayName === 'string' && row.displayName ? row.displayName : value,
      description: typeof row.description === 'string' ? row.description : '',
      efforts: levels.filter((l): l is string => typeof l === 'string' && !!l),
    });
  }
  return models;
}

/** What one stdout line changed: the `initialize` answer arrived, or the command list changed. */
export type StreamEvent = 'initialized' | 'commandsChanged';

/**
 * Reads the CLI's stdout as it arrives (chunks split anywhere) and keeps the latest listing: the `initialize` answer
 * matched by `requestId`, with its commands replaced by each later `commands_changed` event. Other lines are ignored.
 */
export class CliStreamReader {
  private buffer = '';
  private current: CliListing | undefined;
  /** The `initialize` request failed (`subtype: error`): its message. */
  error: string | undefined;

  constructor(private readonly requestId = INITIALIZE_REQUEST_ID) {}

  /** The listing so far: undefined until the `initialize` answer came. */
  get listing(): CliListing | undefined {
    return this.current;
  }

  /** Reads a chunk of stdout; the events its complete lines caused, in order. */
  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const events: StreamEvent[] = [];
    for (const line of lines) {
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** Reads what is left without a newline (the stream ended). */
  end(): StreamEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    const event = rest.trim() ? this.line(rest) : undefined;
    return event ? [event] : [];
  }

  private line(line: string): StreamEvent | undefined {
    if (!line.trim().startsWith('{')) return undefined;
    const m = parseObject(line);
    if (m?.type === 'control_response') {
      const r = m.response as { subtype?: unknown; request_id?: unknown; response?: Record<string, unknown>; error?: unknown } | undefined;
      if (r?.request_id !== this.requestId) return undefined;
      if (r.subtype === 'error') {
        this.error = typeof r.error === 'string' ? r.error : 'initialize failed';
        return undefined;
      }
      const commands = parseCliCommands(r.response?.commands);
      if (!commands) return undefined;
      const version = r.response?.claude_code_version;
      this.current = { commands, models: parseCliModels(r.response?.models), ...(typeof version === 'string' ? { version } : {}) };
      return 'initialized';
    }
    if (m?.type === 'system' && m.subtype === 'commands_changed') {
      const commands = parseCliCommands(m.commands);
      // Before the answer, the answer (computed later) is newer.
      if (!commands || !this.current) return undefined;
      this.current = { ...this.current, commands };
      return 'commandsChanged';
    }
    return undefined;
  }
}
