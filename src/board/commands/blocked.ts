import { blockedNotice } from '../../core/builtins';
import { keepText } from '../outcomes';
import type { Handler } from '../types';

/** Category E (`/login`, `/exit`, `/voice`, …): the box says why the board does not run it and keeps the text. */
export const blocked: Handler = async ({ submission, ui }) => keepText(ui, blockedNotice(submission));
