// The experimental terminal's script (term.js): xterm.js and its fit addon, loaded by termView.ts only when a session
// opens in the terminal view, so the transcript view never downloads them.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

declare global {
  interface Window {
    DevdeskXterm?: { Terminal: typeof Terminal; FitAddon: typeof FitAddon };
  }
}

window.DevdeskXterm = { Terminal, FitAddon };
