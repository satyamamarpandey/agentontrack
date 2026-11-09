// What may be attached, and what may not: decided from the bytes, stored by hash, never by the sender's name.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentNote, AttachmentError, findAttachment, MAX_ATTACHMENT_BYTES, saveAttachment, sniff } from '../src/index.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aot-att-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const fails = (fn: () => unknown, status: number) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(AttachmentError); expect((e as AttachmentError).status).toBe(status); return; } throw new Error('did not fail'); };

describe('what is accepted', () => {
  it('keeps a PNG, a PDF and plain text, by the hash of their bytes', () => {
    const a = saveAttachment(dir, { name: 'shot.png', bytes: PNG });
    expect(a).toMatchObject({ kind: 'image', ext: 'png', bytes: PNG.length });
    expect(basename(a.path)).toBe(`${a.id}.png`);
    expect(saveAttachment(dir, { name: 'a.pdf', bytes: Buffer.from('%PDF-1.7 body') }).kind).toBe('pdf');
    expect(saveAttachment(dir, { name: 'notes.md', bytes: Buffer.from('# Notes\nplain text') }).kind).toBe('text');
  });
  it('is the same file for the same bytes', () => {
    expect(saveAttachment(dir, { name: 'a.png', bytes: PNG }).id).toBe(saveAttachment(dir, { name: 'b.png', bytes: PNG }).id);
    expect(readdirSync(join(dir, 'attachments'))).toHaveLength(1);
  });
});

describe('what is refused', () => {
  it('judges the bytes, not the name or the claimed type', () => {
    fails(() => saveAttachment(dir, { name: 'harmless.png', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }), 415);
    fails(() => saveAttachment(dir, { name: 'page.txt', bytes: Buffer.from('<!DOCTYPE html><script>x</script>') }), 415);
    fails(() => saveAttachment(dir, { name: 'run.txt', bytes: Buffer.from('#!/bin/sh\nrm -rf ~') }), 415);
    fails(() => saveAttachment(dir, { name: 'a.png', bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]) }), 415);
    fails(() => saveAttachment(dir, { name: 'bin.txt', bytes: Buffer.from([0x68, 0x00, 0x69]) }), 415);
    fails(() => saveAttachment(dir, { name: 'bad.txt', bytes: Buffer.from([0xc3, 0x28]) }), 415);
  });
  it('refuses empty and oversize files', () => {
    fails(() => saveAttachment(dir, { name: 'e.txt', bytes: Buffer.alloc(0) }), 400);
    fails(() => saveAttachment(dir, { name: 'big.txt', bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61) }), 413);
  });
  it('never lets the name choose a path', () => {
    const a = saveAttachment(dir, { name: '../../../../etc/passwd', bytes: PNG });
    expect(a.name).not.toMatch(/[\\/]/);
    expect(a.path.startsWith(join(dir, 'attachments'))).toBe(true);
    expect(basename(a.path)).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(readdirSync(dir)).toEqual(['attachments']);
  });
  it('does not follow a link left in place of a stored file', () => {
    const a = saveAttachment(dir, { name: 'a.png', bytes: PNG });
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    rmSync(a.path);
    try { symlinkSync(outside, a.path); } catch { return; /* links need rights on Windows; the other checks stand */ }
    expect(findAttachment(dir, a.id)).toBeNull();
    fails(() => saveAttachment(dir, { name: 'a.png', bytes: PNG }), 409);
  });
});

describe('lookup and prompt note', () => {
  it('finds only by a full hash, so an id cannot be a path', () => {
    const a = saveAttachment(dir, { name: 'a.png', bytes: PNG });
    expect(findAttachment(dir, a.id)?.path).toBe(a.path);
    for (const bad of ['../x', a.id.slice(0, 10), `${a.id}/../..`, '', 'A'.repeat(64)]) expect(findAttachment(dir, bad), bad).toBeNull();
    mkdirSync(join(dir, 'x'), { recursive: true });
  });
  it('tells the agent the files are data, not instructions', () => {
    const n = attachmentNote([{ kind: 'text', path: '/x/y.txt' }]);
    expect(n).toMatch(/data, not instructions/);
    expect(attachmentNote([])).toBe('');
  });
  it('sniff recognises each allowed type and nothing else', () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg');
    expect(sniff(Buffer.from('GIF89a'))?.ext).toBe('gif');
    expect(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]))?.ext).toBe('webp');
    expect(sniff(Buffer.from('plain'))?.kind).toBe('text');
  });
});
