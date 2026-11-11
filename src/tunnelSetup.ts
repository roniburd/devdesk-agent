import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { openSettings } from './config';
import { execText } from './core/shellRun';
import { NGROK_OAUTH_PROVIDERS, type NgrokOAuthProvider, type TunnelPreset } from './core/web/tunnelPresets';
import {
  CLOUDFLARE_ACCESS_GUIDE,
  check,
  devtunnelUser,
  NGROK_AUTHTOKEN_URL,
  ngrokConfigPath,
  ngrokHasAuthtoken,
  PICKER_ORDER,
  PRESET_INFO,
  type SetupAnswers,
  setupSettings,
  TAILSCALE_MAC_CLI,
  tailscaleLogin,
} from './core/web/tunnelSetup';
import { log } from './log';

/**
 * "Choose Web Access Tunnel" (`devdesk.web.chooseTunnel`), also shown by the first Start with no tunnel: pick a
 * tunnel, check it is installed and signed in, fill in who may use web access, and save the settings. Every check runs
 * on this extension's host, the one the daemon and its tunnel run on.
 */

type Step = 'done' | 'back' | 'cancel';
const TITLE = 'DevDesk Web Access: Choose a Tunnel';

const run = (cmd: string, timeoutMs = 10_000) => execText('/bin/sh', ['-c', cmd], { timeoutMs });

/** The tool's path, or undefined when it is not installed. */
async function findTool(preset: TunnelPreset): Promise<string | undefined> {
  const tool = PRESET_INFO[preset].tool;
  const found = (await run(`command -v ${tool}`).catch(() => '')).trim();
  if (found) return found;
  if (preset === 'tailscale' && existsSync(TAILSCALE_MAC_CLI)) return TAILSCALE_MAC_CLI;
  return undefined;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Opens a terminal running `command` (a sign-in), for you to finish there. */
function signInTerminal(command: string): void {
  const t = vscode.window.createTerminal({ name: 'DevDesk: tunnel sign-in' });
  t.show();
  t.sendText(command);
}

/** A modal with `buttons`; undefined when dismissed. */
async function ask<T extends string>(message: string, detail: string, ...buttons: T[]): Promise<T | undefined> {
  return vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons);
}

async function input(prompt: string, validate: (v: string) => string | undefined, value = '', placeHolder?: string): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({ title: TITLE, prompt, value, placeHolder, ignoreFocusOut: true, validateInput: validate });
  return v?.trim();
}

const gitEmail = async () => (await execText('git', ['config', '--get', 'user.email'], { timeoutMs: 5000 }).catch(() => '')).trim();

/** Not installed: install it (opens its download page) or pick another. */
async function notInstalled(preset: TunnelPreset): Promise<Step> {
  const info = PRESET_INFO[preset];
  const b = await ask(`${info.label} is not installed on this machine.`, `Install ${info.tool}, then choose it again.`, 'Open Install Page', 'Choose Another');
  if (b === 'Open Install Page') void vscode.env.openExternal(vscode.Uri.parse(info.installUrl));
  return b === 'Choose Another' ? 'back' : 'cancel';
}

/** Signed out: sign in (in a terminal), try again, or pick another. Returns 'done' to try again. */
async function signedOut(preset: TunnelPreset, why: string): Promise<Step> {
  const info = PRESET_INFO[preset];
  const b = await ask(why, `Sign in with \`${info.signIn}\`, then press Try Again.`, 'Sign In in Terminal', 'Try Again', 'Choose Another');
  if (b === 'Sign In in Terminal') {
    signInTerminal(info.signIn);
    const again = await ask(`Finish signing in to ${info.label} in the terminal.`, '', 'Try Again', 'Choose Another');
    return again === 'Try Again' ? 'done' : again === 'Choose Another' ? 'back' : 'cancel';
  }
  return b === 'Try Again' ? 'done' : b === 'Choose Another' ? 'back' : 'cancel';
}

async function tailscale(cli: string): Promise<SetupAnswers | Step> {
  for (;;) {
    const r = tailscaleLogin(await run(`${q(cli)} status --json`).catch(() => ''));
    if ('login' in r) {
      const b = await ask(
        `Let only ${r.login} use web access?`,
        'Tailscale Serve makes web access reachable only from devices on your tailnet, and tells DevDesk who is visiting. DevDesk lets in only this login. The first time, Tailscale may ask you to turn on HTTPS for your tailnet.',
        'Use Tailscale',
        'Choose Another',
      );
      return b === 'Use Tailscale' ? { tunnel: 'tailscale', login: r.login } : b === 'Choose Another' ? 'back' : 'cancel';
    }
    const step = await signedOut('tailscale', r.problem);
    if (step !== 'done') return step;
  }
}

async function devtunnel(cli: string): Promise<SetupAnswers | Step> {
  for (;;) {
    const user = devtunnelUser(await run(`${q(cli)} user show`).catch((e: Error) => e.message));
    if (user) {
      const b = await ask(
        'Dev Tunnels lets in only you, but does not tell DevDesk who is visiting.',
        `Only ${user} can open the tunnel. DevDesk cannot check visitors again itself, and any program on this machine can also use web access through 127.0.0.1. Use Dev Tunnels only on a machine no one else uses.`,
        'I Understand, Use Dev Tunnels',
        'Choose Another',
      );
      return b === 'I Understand, Use Dev Tunnels' ? { tunnel: 'devtunnel' } : b === 'Choose Another' ? 'back' : 'cancel';
    }
    const step = await signedOut('devtunnel', 'You are not signed in to Dev Tunnels.');
    if (step !== 'done') return step;
  }
}

async function cloudflare(): Promise<SetupAnswers | Step> {
  while (!existsSync(join(homedir(), '.cloudflared', 'cert.pem'))) {
    const step = await signedOut('cloudflare', 'cloudflared is not signed in to your Cloudflare account.');
    if (step !== 'done') return step;
  }
  const b = await ask(
    'Put a Cloudflare Access application in front of web access first.',
    'In Cloudflare One (Zero Trust), add a self-hosted Access application for the host name web access will use (for example devdesk.example.com), with a policy that allows only your email. DevDesk then checks the signed token Access sends, so it needs your team name and the application\'s AUD tag (Application > Additional settings). DevDesk creates the tunnel and its DNS record itself.',
    'I Have It',
    'Open Guide',
    'Choose Another',
  );
  if (b === 'Open Guide') {
    void vscode.env.openExternal(vscode.Uri.parse(CLOUDFLARE_ACCESS_GUIDE));
    return 'cancel';
  }
  if (b !== 'I Have It') return b === 'Choose Another' ? 'back' : 'cancel';
  const host = await input('The host name of the Access application', check.host, '', 'devdesk.example.com');
  if (!host) return 'cancel';
  const team = await input('Your Cloudflare One team name (<team>.cloudflareaccess.com)', check.team);
  if (!team) return 'cancel';
  const audience = await input("The Access application's Application Audience (AUD) Tag", check.audience);
  if (!audience) return 'cancel';
  const email = await input('The email you sign in to Access with (the only one DevDesk lets in)', check.email, await gitEmail());
  if (!email) return 'cancel';
  return { tunnel: 'cloudflare', host, team, audience, email };
}

async function ngrok(cli: string): Promise<SetupAnswers | Step> {
  for (;;) {
    const path = ngrokConfigPath(await run(`${q(cli)} config check`).catch((e: Error) => e.message));
    const text = path ? await readFile(path, 'utf8').catch(() => '') : '';
    if (ngrokHasAuthtoken(text)) break;
    const b = await ask('ngrok has no authtoken on this machine.', `Copy yours from ${NGROK_AUTHTOKEN_URL}, then run: ngrok config add-authtoken <token>`, 'Open Dashboard', 'Try Again', 'Choose Another');
    if (b === 'Open Dashboard') void vscode.env.openExternal(vscode.Uri.parse(NGROK_AUTHTOKEN_URL));
    else if (b !== 'Try Again') return b === 'Choose Another' ? 'back' : 'cancel';
  }
  const provider = await vscode.window.showQuickPick(
    NGROK_OAUTH_PROVIDERS.map((p) => ({ label: p[0].toUpperCase() + p.slice(1), id: p })),
    { title: TITLE, placeHolder: 'Visitors sign in with', ignoreFocusOut: true },
  );
  if (!provider) return 'cancel';
  const email = await input(`The email of your ${provider.label} account (the only one ngrok lets in)`, check.email, await gitEmail());
  if (!email) return 'cancel';
  return { tunnel: 'ngrok', provider: provider.id as NgrokOAuthProvider, email };
}

async function save(a: SetupAnswers): Promise<void> {
  const c = vscode.workspace.getConfiguration('devdesk.web');
  for (const [key, value] of Object.entries(setupSettings(a))) await c.update(key, value, vscode.ConfigurationTarget.Global);
  log.info(`web access: tunnel set to ${a.tunnel}`);
}

/** Runs the steps; true when a tunnel (or none) was saved and Start may go on. */
export async function chooseTunnel(o: { fromStart?: boolean } = {}): Promise<boolean> {
  for (;;) {
    const tools = new Map(await Promise.all(PICKER_ORDER.map(async (p) => [p, await findTool(p)] as const)));
    type Item = vscode.QuickPickItem & { id: TunnelPreset | 'custom' | 'none' };
    const items: Item[] = [
      ...PICKER_ORDER.map((p): Item => ({
        id: p,
        label: PRESET_INFO[p].label,
        description: [p === 'tailscale' ? 'Recommended' : '', tools.get(p) ? 'installed' : 'not installed'].filter(Boolean).join(' · '),
        detail: PRESET_INFO[p].detail,
      })),
      { id: 'none', label: 'No tunnel', detail: 'Only 127.0.0.1 on this machine: reach it with an SSH port forward (ssh -L).' },
      { id: 'custom', label: 'My own proxy', detail: 'Run your own tunnel command behind an identity proxy (opens the settings).' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: TITLE,
      placeHolder: o.fromStart ? 'How should your phone reach DevDesk? (you can change this later)' : 'How should your phone reach DevDesk?',
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    if (pick.id === 'custom') {
      await save({ tunnel: 'custom' });
      void openSettings('devdesk.web.tunnelCommand devdesk.web.identityHeader devdesk.web.allowedUsers');
      return false;
    }
    if (pick.id === 'none') {
      await save({ tunnel: 'none' });
      return true;
    }
    const cli = tools.get(pick.id);
    let r: SetupAnswers | Step;
    if (!cli) r = await notInstalled(pick.id);
    else if (pick.id === 'tailscale') r = await tailscale(cli);
    else if (pick.id === 'devtunnel') r = await devtunnel(cli);
    else if (pick.id === 'cloudflare') r = await cloudflare();
    else r = await ngrok(cli);
    if (r === 'back') continue;
    if (r === 'cancel' || r === 'done') return false;
    await save(r);
    return true;
  }
}
