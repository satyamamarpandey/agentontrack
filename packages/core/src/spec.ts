import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanRelative } from './workspace.js';

/**
 * A structure check for a written design or specification, run by the engine and not by a model. It answers one narrow question:
 * are the things an implementer needs actually written down? It cannot tell whether the design is any good. That is for reviewers
 * who start without the author's context, and for the person who approves it.
 */
export interface SpecFinding { code: string; severity: 'missing' | 'unclear'; message: string; line?: number }
export interface SpecCheck { verdict: 'go' | 'no-go'; findings: SpecFinding[]; paths: { path: string; exists: boolean; markedNew: boolean }[]; limits: string }

const SECTIONS: [string, RegExp, string][] = [
  ['problem', /^#{1,4}\s+.*(problem|goal|context|background|motivation)/im, 'a section that states the problem'],
  ['plan', /^#{1,4}\s+.*(plan|approach|design|solution|proposal)/im, 'a section that gives the plan'],
  ['alternatives', /^#{1,4}\s+.*(alternative|options? considered|rejected|trade-?offs?)/im, 'a section on the alternatives that were considered'],
  ['files', /^#{1,4}\s+.*(files?|changes?|modules?|touch|affected)/im, 'a section that lists the exact files to change'],
];
const VAGUE = /\b(tbd|todo|etc\.?|and so on|as needed|as appropriate|somehow|maybe|figure out|to be decided|various)\b/i;
const SIGNATURE = /(?:\b(?:function|def|fn|func|async function)\s+[A-Za-z_]\w*\s*\(|\b[A-Za-z_]\w*\s*\([^()\n]*\)\s*(?::|->|=>)\s*[\w<[{]|\([^()\n]*\)\s*:\s*[A-Za-z_][\w<>[\]| ]*\s*(?:\{|=>))/;
const STRUCTURE = /\b(?:interface|type|struct|class|enum|schema|table|record|dataclass)\s+[A-Za-z_]\w*|\{\s*[A-Za-z_]\w*\??\s*:\s*[A-Za-z_]/;
const PATH = /`([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+|[A-Za-z0-9_-]+\.[A-Za-z]{1,6})`/g;

export function checkSpec(markdown: string, root: string): SpecCheck {
  const findings: SpecFinding[] = [];
  const lines = markdown.split('\n');
  for (const [code, re, what] of SECTIONS) if (!re.test(markdown)) findings.push({ code: `missing-${code}`, severity: 'missing', message: `There is no ${what}.` });

  const paths: SpecCheck['paths'] = [];
  const seen = new Set<string>();
  lines.forEach((line) => {
    for (const m of line.matchAll(PATH)) {
      const raw = m[1]!;
      if (seen.has(raw) || /^\d+\.\d+/.test(raw)) continue;
      seen.add(raw);
      let exists = false;
      try { const rel = cleanRelative(root, raw); exists = !!rel && existsSync(join(root, rel)); } catch { /* not a path inside the project */ }
      paths.push({ path: raw, exists, markedNew: /\b(new|create[sd]?|add(?:s|ed)?)\b/i.test(line) });
    }
  });
  if (!paths.length) findings.push({ code: 'no-paths', severity: 'missing', message: 'No file path is named. Name the exact files to change, in backticks.' });
  for (const p of paths) if (!p.exists && !p.markedNew) findings.push({ code: 'unknown-path', severity: 'unclear', message: `\`${p.path}\` does not exist in the project and is not marked as new. Say whether it is new, or correct the path.` });

  if (!STRUCTURE.test(markdown)) findings.push({ code: 'no-data-structures', severity: 'missing', message: 'No data structure is defined (a type, interface, schema or table with its fields).' });
  if (!SIGNATURE.test(markdown)) findings.push({ code: 'no-signatures', severity: 'missing', message: 'No function signature is written out, with its parameters and return type.' });

  let inFence = false;
  lines.forEach((line, i) => {
    if (line.trim().startsWith('```')) { inFence = !inFence; return; }
    if (!inFence && VAGUE.test(line)) findings.push({ code: 'vague', severity: 'unclear', message: `Vague wording: "${line.trim().slice(0, 100)}"`, line: i + 1 });
  });

  return {
    verdict: findings.some((f) => f.severity === 'missing') || findings.length > 5 ? 'no-go' : 'go',
    findings, paths,
    limits: 'This checks that the parts are written down. It does not judge whether the design is correct or wise. Reviewers who start without the author\'s context, and the person who approves, do that.',
  };
}
