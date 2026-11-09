import { promptDecoration } from '../../core/effort';
import { startedOutcome } from '../outcomes';
import type { Handler } from '../types';

/**
 * Category F (skills, workflows, prompt commands) and plain text: a new session on the text as its first prompt, with
 * the box's choices (Ultracode only for these kinds: `promptDecoration`).
 */
export const passThrough: Handler = async (ctx) => {
  const decoration = promptDecoration(ctx.submission.kind, { ultracode: ctx.choice.ultracode });
  return startedOutcome(await ctx.composer.start(ctx.text, ctx.choice, { ...decoration, ui: ctx.ui }));
};
