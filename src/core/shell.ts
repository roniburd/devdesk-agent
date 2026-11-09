/**
 * `s` as one single-quoted shell word. NUL characters are dropped: no shell word can hold one, and the shell (or tmux)
 * would cut the command line there, leaving an unterminated quote and no Claude.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/\0/g, '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Claude's first prompt as the last shell words of its command line: behind `--`, so a prompt that starts with `-`
 * (`- fix the bug`, `--model opus please`) is the prompt and never read as an option.
 */
export function promptArg(prompt: string): string {
  return `-- ${shellQuote(prompt)}`;
}
