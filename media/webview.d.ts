// What VS Code gives a webview's script (media/*.js), for their type check (tsconfig.webview.json).

/** The webview's link to the extension: called once. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): any;
  setState(state: unknown): void;
};
