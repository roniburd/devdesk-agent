import { savedLaunchSettingNotice } from '../../core/builtins';
import { keepText } from '../outcomes';
import type { Handler } from '../types';
import { interactiveOnly } from './interactiveOnly';

/**
 * `/config` (`/settings`): the settings panel, as the other category D commands, except `model=` or `effortLevel=`,
 * which would save the model or effort to the user's Claude settings: the box says to use `/model` or `/effort` (for
 * the next launch only) and keeps the text; nothing is started or typed.
 */
export const config: Handler = async (ctx) => {
  const notice = savedLaunchSettingNotice(ctx.submission);
  if (!notice) return interactiveOnly(ctx);
  return keepText(ctx.ui, notice);
};
