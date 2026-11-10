import { describe, expect, it, vi } from 'vitest';

// The composer reads its settings through `vscode`: only `settings` are set here, and no folder is open.
const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('vscode', () => {
  class EventEmitter {
    private listeners: Array<() => void> = [];
    event = (l: () => void) => (this.listeners.push(l), { dispose() {} });
    fire() {
      for (const l of this.listeners) l();
    }
    dispose() {}
  }
  return {
    EventEmitter,
    workspace: { getConfiguration: () => ({ get: (key: string) => settings.get(key), inspect: () => undefined }), workspaceFolders: [], isTrusted: true },
    window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, dispose() {} }) },
    Uri: { file: (p: string) => ({ fsPath: p }) },
  };
});

const { BoardComposer } = await import('../src/boardComposer');
type Ctor = ConstructorParameters<typeof BoardComposer>;

/** A `globalState` that outlives the composer, as it outlives a window reload. */
function memento() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
    keys: () => [...values.keys()],
  };
}

const composer = (state: ReturnType<typeof memento>) => new BoardComposer({ featureList: [] } as unknown as Ctor[0], {} as Ctor[1], {} as Ctor[2], {} as Ctor[3], state as unknown as Ctor[4]);

describe('BoardComposer: models typed with /model', () => {
  it('are still offered, and allowed, after a window reload', () => {
    const state = memento();
    composer(state).addCustomModel('my-typed-model');
    const reloaded = composer(state);
    expect(reloaded.modelRows().map((r) => r.value)).toContain('my-typed-model');
    expect(reloaded.allowed().models).toContain('my-typed-model');
  });

  it('are not added twice, nor when the pill already offers them', () => {
    const state = memento();
    const c = composer(state);
    c.addCustomModel('my-typed-model');
    c.addCustomModel('my-typed-model');
    c.addCustomModel('sonnet');
    expect(composer(state).modelRows().filter((r) => r.value === 'my-typed-model')).toHaveLength(1);
    expect(state.get<string[]>('devdesk.board.customModels')).toEqual(['my-typed-model']);
  });

  it('can be forgotten, so a typo is not offered forever', () => {
    const state = memento();
    const c = composer(state);
    c.addCustomModel('opsu');
    expect(c.info().typedModels).toEqual(['opsu']);
    c.forgetCustomModels();
    expect(c.modelRows().map((r) => r.value)).not.toContain('opsu');
    expect(c.info().typedModels).toEqual([]);
    expect(composer(state).modelRows().map((r) => r.value)).not.toContain('opsu');
  });

  it('are not added to devdesk.board.models, which replaces the list, but stay allowed', () => {
    const state = memento();
    composer(state).addCustomModel('my-typed-model');
    settings.set('board.models', ['claude-sonnet-4-6', 'Default', 'my-model', 'opus']);
    try {
      const c = composer(state);
      expect(c.modelRows().map((r) => r.value)).toEqual(['claude-sonnet-4-6', 'Default', 'my-model', 'opus']);
      expect(c.info().aliases.map((r) => r.value)).toEqual(['my-typed-model']);
      expect(c.allowed().models).toContain('my-typed-model');
    } finally {
      settings.clear();
    }
  });
});

describe('BoardComposer: models typed with /model in several windows', () => {
  it('keeps what another window typed or forgot (read afresh, changed on what is saved now)', () => {
    const state = memento();
    const one = composer(state);
    const two = composer(state);
    one.addCustomModel('model-one');
    two.addCustomModel('model-two');
    expect(state.get<string[]>('devdesk.board.customModels')).toEqual(['model-one', 'model-two']);
    // Each window offers both without a reload.
    expect(one.info().typedModels).toEqual(['model-one', 'model-two']);
    two.forgetCustomModels();
    expect(one.info().typedModels).toEqual([]);
    one.addCustomModel('model-three');
    expect(two.info().typedModels).toEqual(['model-three']);
  });
});
