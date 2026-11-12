import type { PlanLimits } from './board/messages';
import { sessionsStateDir, usagePlanLimits } from './config';
import { limitsView, readRateLimits } from './core/statusLine';
import { statusLineStatus } from './statusLineCommands';

/**
 * The 📊 popup's plan limits now: what DevDesk's status line last recorded, or the offer to install it (when it is not,
 * and there are no numbers). Nothing when `devdesk.usage.planLimits` is off.
 */
export async function planLimits(now = Date.now()): Promise<PlanLimits> {
  if (!usagePlanLimits()) return {};
  const view = limitsView(await readRateLimits(sessionsStateDir()), now);
  if (view) return { view };
  return (await statusLineStatus()) === 'missing' ? { setup: true } : {};
}
