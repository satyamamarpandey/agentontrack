// The post-publication install check must test the version that was just published. A pre-release is never "latest", so an unpinned install would install an older
// release and the check could pass for the wrong build (found by an independent review of the rc.5 draft).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'scripts', 'release', 'public-install.yml');
const yml = readFileSync(FILE, 'utf8');

describe('public-install workflow', () => {
  it('takes the version from the published release, or from an input when run by hand', () => {
    expect(yml).toMatch(/RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \|\| inputs\.version \}\}/);
    expect(yml).toMatch(/workflow_dispatch:\s+inputs:\s+version:[\s\S]*?required: true/);
  });
  it('never installs without a version', () => {
    const unix = yml.split('\n').filter((l) => l.includes('install.sh'));
    expect(unix.length).toBeGreaterThan(0);
    for (const l of unix) expect(l).toMatch(/sh -s -- --version "\$VERSION"/);
    const ps = yml.split('\n');
    const i = ps.findIndex((l) => l.includes('install.ps1'));
    expect(i).toBeGreaterThan(0);
    expect(ps.slice(0, i).some((l) => l.includes('$env:AOT_VERSION = $version'))).toBe(true);
  });
  it('fails unless the installed program reports that version, on both shells', () => {
    expect(yml).toMatch(/grep -Fq -- "\$VERSION" v\.txt \|\| \{[^}]*exit 1/);
    expect(yml).toMatch(/\$reported\.Contains\(\$version\)\) \{[^}]*exit 1/);
  });
  it('accepts a release tag and refuses anything that is not a version', () => {
    const re = new RegExp(/printf '%s' "\$VERSION" \| grep -Eq '([^']+)'/.exec(yml)![1]!);
    for (const ok of ['1.0.0-rc.5', '1.0.0', '2.3.4-beta.1']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['', 'latest', '1.0.0; rm -rf ~', '$(id)', '../1.0.0', '1.0']) expect(re.test(bad), bad).toBe(false);
    expect('v1.0.0-rc.5'.replace(/^v/, '')).toBe('1.0.0-rc.5');
  });
  it('stays free of secrets and write permission', () => {
    expect(yml).toMatch(/permissions: \{\}/);
    expect(yml).not.toMatch(/secrets\./);
  });
});
