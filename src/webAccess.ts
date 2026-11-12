import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, type FSWatcher, openSync, watch } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { cfg, openSettings, sessionsStateDir, webAccessConfig, webNeedsTunnelChoice, webTunnelPreview } from './config';
import { writeFileAtomic } from './core/atomicWrite';
import { WEB_ACCESS } from './core/edition';
import { FileLockBusy, withFileLock } from './core/fileLock';
import { processAlive } from './core/sessions';
import { execText } from './core/shellRun';
import { type DaemonConfig, parseDaemonConfig, shortHostName, tunnelNameProblem } from './core/web/config';
import { isDaemonCommand, launchFailure, statusBarText, type WebMenuId, webMenuChoices } from './core/web/launch';
import { daemonScript, type WebPanelRow } from './core/web/panel';
import { qrMatrix, qrSvg } from './core/web/qr';
import { parseWebState, webConfigPath, webDir, webLogPath, webStatePath, type WebState, type WebStatus, webStatus } from './core/web/webState';
import { tunnelHint } from './core/web/tunnelSetup';
import { log } from './log';
import { chooseTunnel } from './tunnelSetup';
import { registerWebAccessView } from './webAccessView';

/**
 * Web access (commands `devdesk.web.start`, `stop`, `menu`): runs the daemon (`dist/web.js`) detached, so the phone page
 * keeps working when this window closes or Remote-SSH drops, and shows its state in the status bar. The daemon itself
 * listens on 127.0.0.1 only (src/web/server.ts); this class never opens a socket.
 */

const START_WAIT_MS = 5000;
const STOP_WAIT_MS = 3000;
const CHECK_MS = 10_000;
/** Long enough for a stop (3 s) and a start (5 s) in another window. */
const LOCK_WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QR_PANEL = 'devdesk.web.qr';
/** Settings the daemon's config is built from: a change restarts a running daemon when its config differs. */
const AFFECTS = [
  'devdesk.web',
  'devdesk.sessions',
  'devdesk.insights',
  'devdesk.worktrees.kind',
  // The Claude accounts new sessions start in, and how they run Claude.
  'devdesk.claude',
  'devdesk.board.pasteSettleMs',
];

/** True when `pid` runs the daemon (not some process that took over a stale pid); false when `ps` can't tell. */
async function isDaemon(pid: number): Promise<boolean> {
  if (!processAlive(pid)) return false;
  const command = await execText('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5000 }).catch(() => '');
  return isDaemonCommand(command.trim());
}

/** The URL fits a QR code (version 10 at most). */
function fitsQr(url: string): boolean {
  try {
    qrMatrix(url);
    return true;
  } catch {
    return false;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class WebAccess implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('devdesk.web.status', vscode.StatusBarAlignment.Left, 49);
  private readonly changed = new vscode.EventEmitter<WebStatus>();
  /** Fires after each refresh, with the state read (the Web Access view redraws on it). */
  readonly onDidRefresh = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: FSWatcher | undefined;
  private watchedDir: string | undefined;
  private current: WebStatus = { kind: 'off' };
  private refreshing: Promise<WebStatus> | undefined;
  private changeTimer: NodeJS.Timeout | undefined;
  private qrPanel: vscode.WebviewPanel | undefined;
  /** The Web Access view, once registered. */
  panel: { rows: () => WebPanelRow[]; view: vscode.TreeView<WebPanelRow>; drawn: () => Promise<void> } | undefined;
  /** Start, Stop and setting-change restarts run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The tunnel links and errors already shown in a notification. */
  private readonly told = new Set<string>();
  /** A tunnel was just chosen: show the QR code when its URL comes. */
  private qrWhenUp = false;

  constructor(readonly script: string) {
    this.item.name = 'DevDesk Web Access';
    this.item.command = 'devdesk.web.menu';
    const timer = setInterval(() => void this.refresh(), CHECK_MS);
    this.disposables.push(
      this.item,
      this.changed,
      { dispose: () => clearInterval(timer) },
      { dispose: () => this.unwatch() },
      { dispose: () => this.changeTimer && clearTimeout(this.changeTimer) },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!AFFECTS.some((s) => e.affectsConfiguration(s))) return;
        if (this.changeTimer) clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => void this.serial(() => this.settingsChanged()), 300);
      }),
    );
    void this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.qrPanel?.dispose();
  }

  /** The status bar item as the e2e tests see it. */
  get statusBar(): { text: string; visible: boolean; tooltip?: string } {
    const t = this.item.tooltip;
    return { text: this.item.text, visible: this.current.kind !== 'off', tooltip: typeof t === 'string' ? t : t?.value };
  }

  /** The daemon's state in `dir` (this window's by default): off when there is none or its pid is gone. */
  async status(dir = webDir(sessionsStateDir())): Promise<WebStatus> {
    const text = await readFile(webStatePath(dir), 'utf8').catch(() => undefined);
    return webStatus(text === undefined ? undefined : parseWebState(text), processAlive);
  }

  /** Reads the state again and redraws the status bar item. */
  refresh(): Promise<WebStatus> {
    this.refreshing ??= this.redraw().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async redraw(): Promise<WebStatus> {
    const dir = webDir(sessionsStateDir());
    this.watchDir(dir);
    const status = await this.status(dir);
    this.current = status;
    this.changed.fire(status);
    const text = statusBarText(status);
    if (!text || status.kind === 'off') {
      this.item.hide();
      return status;
    }
    const s = status.state;
    this.tell(s);
    const lines = [`**DevDesk web access** on http://${s.host}:${s.port}/`];
    if (s.url) lines.push(`Tunnel: ${s.url}`);
    if (s.tunnel === 'starting') lines.push('The tunnel is starting.');
    if (s.tunnel === 'down') lines.push(`The tunnel is down${s.tunnelError ? `: ${s.tunnelError}` : ''}. Restart it from the menu.`);
    const tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    tooltip.isTrusted = false;
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.show();
    return status;
  }

  /**
   * Notifications from the tunnel, once each: a link it asks you to open (Tailscale: turn on HTTPS), and why it went
   * down with what to do. After Choose Tunnel, the QR code when its URL comes.
   */
  private tell(s: WebState): void {
    const once = (key: string) => !this.told.has(key) && !!this.told.add(key);
    if (s.tunnelAction && once(`action ${s.pid} ${s.tunnelAction}`)) {
      void vscode.window
        .showWarningMessage(`The web access tunnel asks you to open a link to finish setting it up: ${s.tunnelAction}`, 'Open Link')
        .then((b) => b && vscode.env.openExternal(vscode.Uri.parse(s.tunnelAction!)));
    }
    if (s.tunnel === 'down' && s.tunnelError && once(`down ${s.pid} ${s.tunnelPid} ${s.tunnelError}`)) {
      const hint = tunnelHint(webAccessConfig().tunnel, s.tunnelError);
      if (hint) {
        void vscode.window.showWarningMessage(`The web access tunnel is down: ${s.tunnelError}. ${hint}`, 'Restart Tunnel', 'Choose Tunnel').then((b) => {
          if (b === 'Restart Tunnel') void this.restartTunnel();
          if (b === 'Choose Tunnel') void vscode.commands.executeCommand('devdesk.web.chooseTunnel');
        });
      }
    }
    if (this.qrWhenUp && s.url) {
      this.qrWhenUp = false;
      if (fitsQr(s.url)) this.showQr(s.url);
    }
  }

  /**
   * Set Web Access Tunnel Name: asks for `devdesk.web.tunnelName`, showing the tunnel name and URL it gives as you
   * type, and saves it for this machine. A running daemon restarts with it (settingsChanged).
   */
  async setTunnelName(): Promise<void> {
    const current = cfg().get<string>('web.tunnelName') ?? '';
    const host = shortHostName(hostname(), webAccessConfig().user);
    const typed = await vscode.window.showInputBox({
      title: 'Web Access Tunnel Name',
      prompt: `This machine's part of the tunnel's name, so each machine gets a tunnel of its own (for example mac or cloud). Empty: the host name (${host}).`,
      value: current,
      placeHolder: host,
      validateInput: (v) => {
        const problem = tunnelNameProblem(v);
        if (problem) return { message: `Can't use this name: ${problem}.`, severity: vscode.InputBoxValidationSeverity.Error };
        const p = webTunnelPreview(v.trim());
        return {
          message: p ? `Tunnel: ${p.name}${p.url ? `  ·  ${p.url}` : ''}` : 'The tunnel this window runs has no {host} in its command: this name shows nowhere until it does.',
          severity: vscode.InputBoxValidationSeverity.Info,
        };
      },
    });
    if (typed === undefined || typed.trim() === current) return;
    await cfg().update('web.tunnelName', typed.trim(), vscode.ConfigurationTarget.Global);
    await this.refresh();
  }

  /** Choose Web Access Tunnel: saves the choice, then starts (or restarts) web access with it. */
  async chooseTunnel(): Promise<void> {
    if (!(await chooseTunnel())) return;
    this.qrWhenUp = true;
    const status = await this.status();
    if (status.kind === 'off') await this.start();
  }

  /** Watches `dir` for `web.json` changes (when it exists; the timer covers the rest). */
  private watchDir(dir: string): void {
    if (this.watchedDir === dir && this.watcher) return;
    this.unwatch();
    if (!existsSync(dir)) return;
    try {
      this.watcher = watch(dir, () => void this.refresh());
      this.watcher.on('error', () => this.unwatch());
      this.watchedDir = dir;
    } catch {
      this.watcher = undefined;
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.watchedDir = undefined;
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Runs `f` holding `<dir>/restart.lock`: every window on this host shares the one daemon in `dir`, so its Start, Stop
   * and setting-change restarts go one window at a time (each re-reads `web.json` once it has the lock).
   */
  private hostWide<T>(dir: string, f: () => Promise<T>): Promise<T> {
    return withFileLock(join(dir, 'restart'), f, { waitMs: LOCK_WAIT_MS, dirMode: 0o700 });
  }

  /** Start Web Access: starts the daemon, or, when it already runs, restarts only its tunnel (to recover one that went down). */
  async start(): Promise<void> {
    // The first Start with no tunnel set up asks which one to use (off only: a running daemon keeps its tunnel).
    if (webNeedsTunnelChoice() && (await this.status()).kind === 'off') {
      if (!(await chooseTunnel({ fromStart: true }))) return;
      this.qrWhenUp = true;
    }
    return this.serial(async () => {
      const config = webAccessConfig();
      await mkdir(config.webDir, { recursive: true, mode: 0o700 });
      await this.hostWide(config.webDir, () => this.startLocked(config));
    });
  }

  /** Start, holding the host-wide lock. */
  private async startLocked(config: DaemonConfig): Promise<void> {
    const status = await this.status(config.webDir);
    if (status.kind !== 'off' && (await isDaemon(status.state.pid))) {
      if (status.state.tunnel === 'none') {
        void vscode.window.showInformationMessage(`Web access is already running on http://${status.state.host}:${status.state.port}/.`);
      } else {
        this.signal(status.state.pid, 'SIGUSR1');
        log.info(`web access: restarting the tunnel of pid ${status.state.pid}`);
        void vscode.window.showInformationMessage('Web access is running: restarting its tunnel.');
      }
      await this.refresh();
      return;
    }
    // A stale web.json (its daemon crashed or the host restarted) is replaced.
    await rm(webStatePath(config.webDir), { force: true });
    await this.launch(config);
  }

  /** Stop Web Access: stops the daemon and its tunnel, and removes `web.json`. */
  stop(): Promise<void> {
    return this.serial(async () => {
      const dir = webDir(sessionsStateDir());
      if (existsSync(dir)) {
        await this.hostWide(dir, async () => {
          const status = await this.status(dir);
          if (status.kind !== 'off') await this.stopDaemon(status.state, dir);
          else await rm(webStatePath(dir), { force: true });
        });
      }
      await this.refresh();
    });
  }

  /**
   * Restart Web Access: stops the daemon and starts it again from this extension's `dist/web.js` and the current settings
   * (so a daemon an older version started serves this version's page). Off: starts it.
   */
  restart(): Promise<void> {
    return this.serial(async () => {
      const config = webAccessConfig();
      await mkdir(config.webDir, { recursive: true, mode: 0o700 });
      await this.hostWide(config.webDir, async () => {
        const status = await this.status(config.webDir);
        if (status.kind !== 'off') {
          log.info(`web access: restarting the daemon (pid ${status.state.pid})`);
          await this.stopDaemon(status.state, config.webDir);
        }
        await rm(webStatePath(config.webDir), { force: true });
        await this.launch(config);
      });
    });
  }

  /** What the Web Access view shows beyond `web.json`: the running daemon's script and settings. */
  async details(status: WebStatus): Promise<{ running?: { script: string; version?: string }; settings?: DaemonConfig }> {
    if (status.kind === 'off') return {};
    const command = await execText('ps', ['-o', 'command=', '-p', String(status.state.pid)], { timeoutMs: 5000 }).catch(() => '');
    const parsed = await readFile(status.state.configPath, 'utf8')
      .then((t) => parseDaemonConfig(JSON.parse(t)))
      .catch(() => undefined);
    return { running: daemonScript(command.trim()), settings: parsed && 'config' in parsed ? parsed.config : undefined };
  }

  /** The daemon's log file in this window's state folder. */
  logPath(): string {
    return webLogPath(webDir(sessionsStateDir()));
  }

  /** Copies the tunnel URL. */
  async copyUrl(): Promise<void> {
    const status = await this.refresh();
    if (status.kind !== 'off' && status.state.url) await copied(status.state.url);
  }

  /** Copies the loopback URL. */
  async copyLocal(): Promise<void> {
    const status = await this.refresh();
    if (status.kind !== 'off') await copied(`http://${status.state.host}:${status.state.port}/`);
  }

  /** Opens the tunnel URL in the browser. */
  async openUrl(): Promise<void> {
    const status = await this.refresh();
    if (status.kind !== 'off' && status.state.url) await vscode.env.openExternal(vscode.Uri.parse(status.state.url));
  }

  /** Shows the tunnel URL's QR code. */
  async qr(): Promise<void> {
    const status = await this.refresh();
    const url = status.kind === 'off' ? undefined : status.state.url;
    if (!url) return;
    if (fitsQr(url)) this.showQr(url);
    else void vscode.window.showWarningMessage('The web access URL is too long for a QR code.');
  }

  /** Restarts the running daemon's tunnel (SIGUSR1). */
  restartTunnel(): Promise<void> {
    return this.serial(async () => {
      const status = await this.status();
      if (status.kind !== 'off' && (await isDaemon(status.state.pid))) this.signal(status.state.pid, 'SIGUSR1');
      await this.refresh();
    });
  }

  /** The status bar item's menu. */
  async menu(): Promise<void> {
    const status = await this.refresh();
    const url = status.kind === 'off' ? undefined : status.state.url;
    const choices = webMenuChoices(status, !!url && fitsQr(url));
    const pick = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.label, description: c.description, id: c.id })),
      { title: 'DevDesk Web Access', placeHolder: status.kind === 'off' ? 'Web access is off' : undefined },
    );
    if (!pick) return;
    const local = status.kind === 'off' ? '' : `http://${status.state.host}:${status.state.port}/`;
    const actions: Record<WebMenuId, () => unknown> = {
      start: () => this.start(),
      copy: () => url && vscode.env.clipboard.writeText(url),
      open: () => url && vscode.env.openExternal(vscode.Uri.parse(url)),
      qr: () => url && this.showQr(url),
      copyLocal: () => vscode.env.clipboard.writeText(local),
      restart: () => this.restartTunnel(),
      restartAll: () => this.restart(),
      stop: () => this.stop(),
      settings: () => openSettings('devdesk.web'),
    };
    await actions[pick.id]();
  }

  /** Writes the config, starts `dist/web.js` detached on VS Code's Node, and waits for its `web.json`. */
  private async launch(config: DaemonConfig): Promise<void> {
    const configPath = webConfigPath(config.webDir);
    const logPath = webLogPath(config.webDir);
    await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, false, 0o600);
    const fd = openSync(logPath, 'w', 0o600);
    let exited = false;
    let code: number | null = null;
    let spawnError: Error | undefined;
    try {
      const child = spawn(process.execPath, [this.script, '--config', configPath], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.on('error', (err) => {
        spawnError = err;
        exited = true;
      });
      child.on('exit', (c, signal) => {
        exited = true;
        code = c ?? (signal ? 1 : null);
      });
      child.unref();
      log.info(`web access: started the daemon (pid ${child.pid}) on port ${config.port}, log ${logPath}`);
      for (let waited = 0; waited < START_WAIT_MS && !exited; waited += 100) {
        await sleep(100);
        const status = await this.status(config.webDir);
        if (status.kind !== 'off' && status.state.pid === child.pid) {
          await this.refresh();
          return;
        }
      }
    } finally {
      closeSync(fd);
    }
    const text = spawnError ? spawnError.message : await readFile(logPath, 'utf8').catch(() => '');
    const failure = launchFailure({ code: exited ? (code ?? 1) : undefined, port: config.port, log: text });
    log.warn(`web access: ${failure.message}`);
    await this.refresh();
    const buttons = failure.settings ? ['Settings', 'Open Log'] : ['Open Log'];
    void vscode.window.showErrorMessage(failure.message, ...buttons).then((b) => {
      if (b === 'Settings') void openSettings('devdesk.web');
      if (b === 'Open Log') void vscode.window.showTextDocument(vscode.Uri.file(logPath));
    });
  }

  /** SIGTERM, then up to 3 s for it to go (SIGKILL and its tunnel's process group after that); `web.json` goes too. */
  private async stopDaemon(state: WebState, dir: string): Promise<void> {
    if (await isDaemon(state.pid)) {
      this.signal(state.pid, 'SIGTERM');
      for (let waited = 0; waited < STOP_WAIT_MS && processAlive(state.pid); waited += 100) await sleep(100);
      if (processAlive(state.pid)) {
        log.warn(`web access: pid ${state.pid} did not stop within 3 s; killing it`);
        this.signal(state.pid, 'SIGKILL');
        if (state.tunnelPid) this.signal(-state.tunnelPid, 'SIGTERM');
      }
    }
    const text = await readFile(webStatePath(dir), 'utf8').catch(() => undefined);
    if (text !== undefined && parseWebState(text)?.pid === state.pid) await rm(webStatePath(dir), { force: true });
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (err) {
      log.debug(`web access: kill ${signal} ${pid}: ${(err as Error).message}`);
    }
  }

  /**
   * A setting changed: a running daemon this extension started restarts when its config would differ, keeping the root
   * it was started for, so several windows don't take it over from each other. Every window gets the change: the first
   * to take the host-wide lock restarts the daemon, and the others, finding a new pid once they have the lock, leave it.
   */
  private async settingsChanged(): Promise<void> {
    const dir = webDir(sessionsStateDir());
    const seen = await this.status(dir);
    // Only a daemon Start ran (its config in its web folder), never one started by hand.
    if (seen.kind === 'off' || !seen.state.configPath.endsWith(`/${WEB_ACCESS.dirName}/config.json`)) {
      await this.refresh();
      return;
    }
    try {
      await this.hostWide(dir, async () => {
        const status = await this.status(dir);
        if (status.kind === 'off' || status.state.pid !== seen.state.pid) return;
        const running = await readFile(status.state.configPath, 'utf8')
          .then((t) => parseDaemonConfig(JSON.parse(t)))
          .catch(() => undefined);
        const runningConfig = running && 'config' in running ? running.config : undefined;
        const next = webAccessConfig(runningConfig ? (runningConfig.root ?? '') : undefined);
        if (runningConfig && JSON.stringify(runningConfig) === JSON.stringify(parseConfigRoundTrip(next))) return;
        log.info('web access: settings changed; restarting the daemon');
        await this.stopDaemon(status.state, webDir(runningConfig?.stateDir ?? sessionsStateDir()));
        await mkdir(next.webDir, { recursive: true, mode: 0o700 });
        await this.launch(next);
      });
    } catch (err) {
      if (!(err instanceof FileLockBusy)) throw err;
      log.warn(`web access: another window held ${err.lockPath} for over ${LOCK_WAIT_MS / 1000} s; not restarting the daemon`);
    }
    await this.refresh();
  }

  /** A panel with the tunnel URL's QR code, for a phone camera. */
  private showQr(url: string): void {
    const nonce = randomBytes(16).toString('base64');
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;font-family:var(--vscode-font-family)}
.qr{background:#fff;padding:8px;line-height:0}.url{word-break:break-all;text-align:center;user-select:text}</style></head>
<body><div class="qr">${qrSvg(url, 8)}</div><div class="url">${escapeHtml(url)}</div>
<div>Scan it with your phone's camera. The proxy in front of the tunnel decides who can open it.</div></body></html>`;
    if (!this.qrPanel) {
      this.qrPanel = vscode.window.createWebviewPanel(QR_PANEL, 'Web Access QR Code', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
      this.qrPanel.onDidDispose(() => (this.qrPanel = undefined));
    }
    this.qrPanel.webview.html = html;
    this.qrPanel.reveal();
  }
}

/** `config` as the daemon reads it back (clamps re-applied), so a running config compares equal to an unchanged one. */
function parseConfigRoundTrip(config: DaemonConfig): DaemonConfig | undefined {
  const parsed = parseDaemonConfig(JSON.parse(JSON.stringify(config)));
  return 'config' in parsed ? parsed.config : undefined;
}

/** Registers the web access commands and status bar item. */
export function registerWebAccess(ctx: vscode.ExtensionContext): WebAccess {
  const web = new WebAccess(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'web.js').fsPath);
  ctx.subscriptions.push(
    web,
    vscode.commands.registerCommand('devdesk.web.start', () => web.start()),
    vscode.commands.registerCommand('devdesk.web.stop', () => web.stop()),
    vscode.commands.registerCommand('devdesk.web.menu', () => web.menu()),
    vscode.commands.registerCommand('devdesk.web.restartTunnel', () => web.restartTunnel()),
    vscode.commands.registerCommand('devdesk.web.restart', () => web.restart()),
    vscode.commands.registerCommand('devdesk.web.copyUrl', () => web.copyUrl()),
    vscode.commands.registerCommand('devdesk.web.copyLocalUrl', () => web.copyLocal()),
    vscode.commands.registerCommand('devdesk.web.openUrl', () => web.openUrl()),
    vscode.commands.registerCommand('devdesk.web.showQr', () => web.qr()),
    vscode.commands.registerCommand('devdesk.web.openLog', () => vscode.window.showTextDocument(vscode.Uri.file(web.logPath()))),
    vscode.commands.registerCommand('devdesk.web.openSettings', () => openSettings('devdesk.web')),
    vscode.commands.registerCommand('devdesk.web.chooseTunnel', () => web.chooseTunnel()),
    vscode.commands.registerCommand('devdesk.web.setTunnelName', () => web.setTunnelName()),
  );
  web.panel = registerWebAccessView(ctx, web);
  return web;
}

/** Copies `text` and says so in the status bar. */
async function copied(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`$(copy) Copied ${text}`, 3000);
}
