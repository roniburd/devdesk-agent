import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { listClaude } from '../core/cliList';
import { listProcesses } from '../core/processes';
import { programStatusDirIn, readCardProgramStatus } from '../core/programStatus';
import { discoverSlashCommands } from '../core/slashCommands';
import { claudeInvocationOf } from '../core/web/composer';
import { ComposerCache } from '../core/web/composerCache';
import { processAlive } from '../core/sessions';
import { tmuxRunner } from '../core/tmux';
import { type DaemonConfig, defaultDaemonConfig, fillTunnelCommand, parseDaemonArgs, parseDaemonConfig } from '../core/web/config';
import { SessionSnapshot } from '../core/web/snapshot';
import { publicHostOf } from '../core/web/tunnel';
import { classifyTunnelUrl, ngrokPolicy } from '../core/web/tunnelPresets';
import { AccessKeyCache } from './accessKeys';
import { EXIT_BAD_CONFIG, EXIT_PORT_IN_USE, type WebState, webStatePath } from '../core/web/webState';
import { PAGE } from './pageAssets';
import { createWebServer, LOOPBACK } from './server';
import { log, removeWebState, writeWebState } from './stateFile';
import { runTunnel } from './tunnel';

/**
 * The web access daemon, `node dist/web.js [--config <file>] [flags]` (see parseDaemonArgs): serves the sessions on
 * 127.0.0.1, writes `web.json`, runs the tunnel command. SIGUSR1 restarts the tunnel; SIGTERM and SIGINT stop.
 */

const fail = (message: string, code: number): never => {
  log(message);
  process.exit(code);
};

/** The config file (or the manual-run defaults) with the flags over it, checked. */
async function loadConfig(argv: readonly string[]): Promise<{ config: DaemonConfig; configPath: string }> {
  const args = parseDaemonArgs(argv);
  if ('error' in args) return fail(args.error, EXIT_BAD_CONFIG);
  let base: unknown;
  let configPath = '';
  if (args.configPath !== undefined) {
    configPath = resolve(args.configPath);
    let text: string;
    try {
      text = await readFile(configPath, 'utf8');
    } catch (err) {
      return fail(`cannot read the config ${configPath}: ${(err as Error).message}`, EXIT_BAD_CONFIG);
    }
    try {
      base = JSON.parse(text);
    } catch {
      return fail(`the config ${configPath} is not JSON`, EXIT_BAD_CONFIG);
    }
  } else {
    base = defaultDaemonConfig(homedir(), process.env.USER || userInfo().username);
  }
  const parsed = parseDaemonConfig(base && typeof base === 'object' ? { ...base, ...args.overrides } : base);
  if ('error' in parsed) return fail(parsed.error, EXIT_BAD_CONFIG);
  return { config: parsed.config, configPath };
}

async function main(): Promise<void> {
  const { config, configPath } = await loadConfig(process.argv.slice(2));
  const runner = (server: string) =>
    tmuxRunner(server, { bin: config.tmux.bin, ...(server === config.tmux.server && config.tmux.configFile ? { configFile: config.tmux.configFile } : {}) });
  const snapshot = new SessionSnapshot(config, { tmux: runner, listProcesses, alive: processAlive });
  let tunnelHost = '';
  const accessKeys = config.auth === 'cloudflare' && config.cloudflare.team ? new AccessKeyCache(config.cloudflare.team, log) : undefined;
  void accessKeys?.refresh(true);
  const server = createWebServer({
    config,
    snapshot,
    actions: {
      tmux: runner,
      listProcesses,
      tmpDir: tmpdir(),
      settleMs: config.pasteSettleMs,
      programStatus: (card) => readCardProgramStatus(programStatusDirIn(config.stateDir), card, processAlive),
    },
    page: PAGE,
    publicHost: () => config.publicHost || tunnelHost,
    log,
    composer: new ComposerCache({
      list: (dir) => listClaude(claudeInvocationOf(config.claude), dir, undefined, (m) => log(m), config.claude.env),
      disk: (dir) => discoverSlashCommands(config.claude.configDir || join(homedir(), '.claude'), [dir]),
      now: Date.now,
    }),
    ...(accessKeys ? { accessKeys } : {}),
  });

  let port: number;
  try {
    ({ port } = await server.listen());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') fail(`port ${config.port} is in use: change devdesk.web.port (or --port)`, EXIT_PORT_IN_USE);
    return fail(`cannot listen on ${LOOPBACK}:${config.port}: ${e.message}`, 1);
  }
  log(`listening on http://${LOOPBACK}:${port}/ (auth: ${config.auth}${config.tunnel ? `, tunnel: ${config.tunnel}` : ''})`);
  if (config.auth === 'tunnel') log('the tunnel lets in only its owner and names no one: any process on this host can also use web access');

  await mkdir(config.webDir, { recursive: true, mode: 0o700 });
  // ngrok's traffic policy (sign-in, who may pass, the identity header), private like config.json.
  const ngrokPolicyPath = join(config.webDir, 'ngrok-policy.yml');
  if (config.tunnel === 'ngrok') await writeFile(ngrokPolicyPath, ngrokPolicy(config.allowedUsers, config.ngrokProvider), { mode: 0o600 });
  const statePath = webStatePath(config.webDir);
  const state: WebState = {
    version: 1,
    pid: process.pid,
    host: LOOPBACK,
    port,
    startedAt: Date.now(),
    configPath,
    tunnel: config.tunnelCommand ? 'starting' : 'none',
  };
  // Writes go one after another, so the file always ends with the newest state.
  let writing = Promise.resolve();
  const save = () => {
    const snap = { ...state };
    writing = writing.then(() => writeWebState(statePath, snap)).catch((err: unknown) => log(`cannot write ${statePath}: ${(err as Error).message}`));
    return writing;
  };
  await save();

  let tunnel: { pid?: number; stop(): void } | undefined;
  const startTunnel = () => {
    if (!config.tunnelCommand) return;
    const command = fillTunnelCommand(config.tunnelCommand, { port, user: config.user, host: hostname(), tunnelName: config.tunnelName, publicHost: config.publicHost, ngrokPolicy: ngrokPolicyPath });
    const spec = { urlHost: config.tunnelUrlHost, actionHost: config.tunnelActionHost };
    const rules = {
      classify: (url: string) => classifyTunnelUrl(url, spec, config.publicHost),
      ...(config.tunnelReadyLine && config.publicHost ? { ready: new RegExp(config.tunnelReadyLine), readyUrl: `https://${config.publicHost}/` } : {}),
    };
    const run = runTunnel(command, {
      onAction: (url) => {
        if (tunnel !== run) return;
        state.tunnelAction = url;
        log(`the tunnel asks you to open ${url}`);
        void save();
      },
      onUrl: (url) => {
        if (tunnel !== run) return;
        tunnelHost = publicHostOf(url) ?? '';
        Object.assign(state, { tunnel: 'up', url });
        delete state.tunnelError;
        delete state.tunnelAction;
        log(`tunnel up: ${url}`);
        void save();
      },
      onDown: (error) => {
        if (tunnel !== run) return;
        tunnelHost = '';
        state.tunnel = 'down';
        state.tunnelError = error;
        delete state.url;
        delete state.tunnelAction;
        log(`tunnel down: ${error}`);
        void save();
      },
    }, undefined, rules);
    tunnel = run;
    state.tunnel = 'starting';
    delete state.url;
    delete state.tunnelError;
    delete state.tunnelAction;
    if (run.pid !== undefined) state.tunnelPid = run.pid;
    else delete state.tunnelPid;
    void save();
  };
  const stopTunnel = () => {
    const t = tunnel;
    tunnel = undefined;
    t?.stop();
  };
  startTunnel();

  process.on('SIGUSR1', () => {
    log('restarting the tunnel');
    stopTunnel();
    tunnelHost = '';
    startTunnel();
  });
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    stopTunnel();
    accessKeys?.dispose();
    await server.close();
    await writing;
    await removeWebState(statePath, process.pid);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  // However the daemon ends, the tunnel it started ends with it.
  process.on('exit', stopTunnel);
}

main().catch((err: unknown) => fail(`web access failed: ${(err as Error).stack ?? err}`, 1));
