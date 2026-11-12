import { DEFAULT_CHOICE, findModel, isClaudeAlias, isDefaultModelName, longContextRow, modelsStartingWith } from '../../core/composer';
import { keepText } from '../outcomes';
import type { Handler } from '../types';

/**
 * `/model` opens the model pill's list; `/model <x>` sets the model for the next session the board starts (never saved,
 * never sent to a session). `<x>` is a row's value or name (any case, `opus 1m` for `Opus (1M context)`), `default` or
 * `Model` (Default; a warning when `devdesk.board.models` lists no Default), a Claude alias, or any other model id, which
 * is offered from then on (as Claude accepts ids it has no row for). A name several rows start with (`auto`) is a
 * warning listing them. A model id has no whitespace: `/model sonnet explain the bug` or a second line is a warning,
 * keeping the text, rather than `--model 'sonnet explain the bug'`.
 */
export const model: Handler = async ({ submission, composer, ui }) => {
  const want = submission.arg.trim();
  if (!want) {
    ui.openPicker('model');
    return { clear: true };
  }
  const rows = composer.modelRows();
  const row = findModel(rows, want);
  if (row) {
    ui.setChoice({ model: row.value });
    const id = row.value !== row.label && row.value !== DEFAULT_CHOICE ? ` (${row.value})` : '';
    const about = row.description ? `: ${row.description}` : '';
    const long = longContextRow(rows, row);
    const hint = long ? ` For 1M context, pick ${long.label}.` : '';
    ui.notice({ text: `Model for new sessions: ${row.label}${id}${about}. Not saved in your Claude settings.${hint}`, tone: 'info' });
    return { clear: true };
  }
  if (isDefaultModelName(want)) {
    // devdesk.board.models lists no Default: `--model default` is not the user's setting, so change nothing.
    ui.notice({ text: 'The model list (devdesk.board.models) has no Default: pick one of its models, or add Default to it.', tone: 'warning' });
    return { clear: true };
  }
  const several = modelsStartingWith(rows, want);
  if (several.length > 1) {
    const names = several.map((r) => r.label);
    const list = names.length === 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
    return keepText(ui, `${want} could be ${list}: type more of the name.`);
  }
  if (/\s/.test(want)) {
    return keepText(ui, 'Not a model: a model id has no spaces or line breaks. Send /model <id> on its own, then your prompt.');
  }
  if (isClaudeAlias(want)) {
    // Claude's aliases in any case (`OPUSPLAN`), as `findModel` and `modelsStartingWith` take them: spelled as Claude knows them.
    const alias = want.toLowerCase();
    composer.addCustomModel(alias);
    ui.setChoice({ model: alias });
    ui.notice({ text: `Model for new sessions: Claude's ${alias} alias (--model ${alias}). Not saved in your Claude settings.`, tone: 'info' });
  } else {
    composer.addCustomModel(want);
    ui.setChoice({ model: want });
    ui.notice({ text: `${want} is not in Claude's model list: new sessions start with --model ${want} as typed. Not saved in your Claude settings.`, tone: 'warning' });
  }
  return { clear: true };
};
