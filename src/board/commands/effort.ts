import { DEFAULT_CHOICE } from '../../core/composer';
import { parseEffortCommand } from '../../core/effort';
import { keepText } from '../outcomes';
import type { Handler } from '../types';

/** An effort choice as the box names it (`Default` is `/effort auto`). */
const effortName = (effort: string) => (effort === DEFAULT_CHOICE ? 'auto (the model’s default)' : effort);

/**
 * `/effort` opens the model pill's effort row; `/effort <level|auto>` sets the effort for the next session the board
 * starts (`auto`: Default, no `--effort`), from the levels the chosen model offers; `/effort status` says what is chosen;
 * `/effort ultracode [on|off]` flips the Ultracode switch. Never saved, never sent to a session.
 */
export const effort: Handler = async ({ submission, choice, composer, ui }) => {
  // Every model the box takes, not only the pill's rows: one of Claude's aliases or a typed model chosen without a row
  // offers every level, as the pill and `parseChoice` say.
  const row = composer.allowedRows().find((r) => r.value === choice.model);
  const offered = row?.efforts ?? [];
  const name = row ? (row.value === DEFAULT_CHOICE ? 'the default model' : row.label) : choice.model;
  const command = parseEffortCommand(submission.arg, offered);
  switch (command.kind) {
    case 'open':
      // The pill shows no effort row for a model without effort: say so instead of opening a list without one.
      if (!offered.length) {
        ui.notice({ text: `${name} takes no effort level: pick another model to choose one.`, tone: 'info' });
        ui.openPicker('model');
      } else ui.openPicker('effort');
      return { clear: true };
    case 'status': {
      const levels = offered.length ? `offers ${offered.join(', ')}` : 'takes no effort level';
      ui.notice({ text: `Effort for new sessions: ${effortName(choice.effort)}; Ultracode ${choice.ultracode ? 'on' : 'off'}. ${name} ${levels}. Not saved in your Claude settings.`, tone: 'info' });
      return { clear: true };
    }
    case 'set':
      ui.setChoice({ effort: command.effort });
      ui.notice({ text: `Effort for new sessions: ${effortName(command.effort)}. Not saved in your Claude settings.`, tone: 'info' });
      return { clear: true };
    case 'unsupported':
      return keepText(
        ui,
        command.offered.length
          ? `${name} does not offer ${command.level} effort: use ${command.offered.join(', ')} or auto.`
          : `${name} takes no effort level: pick another model to choose ${command.level}.`,
      );
    case 'ultracode': {
      const on = command.on ?? !choice.ultracode;
      ui.setChoice({ ultracode: on });
      ui.notice({ text: `Ultracode ${on ? 'on' : 'off'} for new sessions${on ? ': prompts end with “ultracode”' : ''}. Not saved in your Claude settings.`, tone: 'info' });
      return { clear: true };
    }
    case 'invalid':
      return keepText(ui, command.reason);
  }
};
