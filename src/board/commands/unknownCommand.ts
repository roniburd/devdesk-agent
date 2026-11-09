import { unknownCommandNotice } from '../../core/builtins';
import { keepText } from '../outcomes';
import type { Handler } from '../types';

/**
 * A command neither the catalog nor the CLI knows: a warning, as sent it would cost a model turn, with "Send as text
 * anyway", which starts a session on it as typed (as category F).
 */
export const unknownCommand: Handler = async ({ text, submission, choice, composer, ui }) =>
  keepText(ui, { text: unknownCommandNotice(submission), actions: [{ label: 'Send as text anyway', run: () => composer.submit(text, choice, ui, { as: 'F' }) }] });
