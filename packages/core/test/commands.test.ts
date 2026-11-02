import { describe, expect, it } from 'vitest';
import { checkSlashCommand, CommandRefused, detectIntent, leadingCommand, orchestrate } from '../src/index.js';

describe('intent', () => {
  it.each([['review the auth module', 'review'], ['keep going until the tests pass', 'loop'], ['plan the migration in phases', 'plan'], ['implement the export button', 'goal'], ['what is a monad', 'none'], ['', 'none']])('%s -> %s', (t, i) => expect(detectIntent(t)).toBe(i));
});
describe('slash commands', () => {
  it('finds a leading command and nothing else', () => { expect(leadingCommand('/goal fix it')).toBe('goal'); expect(leadingCommand('fix /goal')).toBeNull(); expect(leadingCommand('/')).toBeNull(); });
  it('refuses a command the runtime did not report, and any command when nothing was reported', () => {
    expect(() => checkSlashCommand('/review x', ['review', 'help'])).not.toThrow();
    expect(() => checkSlashCommand('/Review x', ['/review'])).not.toThrow();
    expect(() => checkSlashCommand('/goal x', ['review'])).toThrow(CommandRefused);
    expect(() => checkSlashCommand('/goal x', null)).toThrow(/has not told/);
    expect(() => checkSlashCommand('/goal x', [])).toThrow(CommandRefused);
    expect(() => checkSlashCommand('plain text', null)).not.toThrow();
  });
});
describe('orchestration', () => {
  it('runs a loop itself with limits when it can start the agent, and offers a native command only if reported', () => {
    const a = orchestrate('keep going until the tests pass', { agentCanStart: true, reportedCommands: ['loop'] });
    expect(a).toMatchObject({ intent: 'loop', recommended: 'managed', native: { command: 'loop' } });
    expect(a.managed!.limits).toMatch(/cancel/);
    expect(orchestrate('keep going until the tests pass', { agentCanStart: true, reportedCommands: null }).native).toBeNull();
  });
  it('never invents a command for an agent it cannot start', () => {
    expect(orchestrate('review this', { agentCanStart: false, reportedCommands: ['help'] })).toMatchObject({ recommended: 'plain', native: null, managed: null });
    expect(orchestrate('review this', { agentCanStart: false, reportedCommands: ['review'] })).toMatchObject({ recommended: 'native' });
  });
});
