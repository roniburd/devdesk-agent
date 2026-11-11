// Element building for the page. Data only ever goes in as text nodes (`textContent`), never as markup, so session titles,
// transcript text and pane captures can't become HTML.

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

/** `<tag>` with classes, text, attributes, listeners and children (strings become text nodes). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  for (const [type, fn] of Object.entries(props.on ?? {})) el.addEventListener(type, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** `LOOKS` labels are capitals ("QUESTION FOR YOU"); the page writes them in sentence case ("Question for you"). */
export function sentenceCase(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The hash route of a session's screen. */
export const sessionHref = (id: string): string => `#/s/${encodeURIComponent(id)}`;
