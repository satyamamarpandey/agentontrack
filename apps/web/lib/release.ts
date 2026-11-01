// The one switch for whether downloads exist. It stays off until the owner has approved publication and the files are live.
export const RELEASE_VERSION = (process.env.NEXT_PUBLIC_RELEASE_VERSION ?? '').trim();
/** A release with no version cannot have a real file address, so it does not count as published. */
export const RELEASE_PUBLISHED = process.env.NEXT_PUBLIC_RELEASE_PUBLISHED === '1' && RELEASE_VERSION !== '';

export const REPO = 'https://github.com/satyamamarpandey/agentontrack';
export const RELEASES = `${REPO}/releases`;
export const ISSUES = `${REPO}/issues`;
export const ADVISORY = `${REPO}/security/advisories/new`;
/** Discussions are switched off on the repository today. Turn this on when the owner enables them. */
export const DISCUSSIONS_ENABLED = false;
export const DISCUSSIONS = `${REPO}/discussions`;

export const INSTALL_SH = 'curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh';
export const INSTALL_PS1 = 'irm https://pandeysatyam.com/agentontrack/install.ps1 | iex';
export const NOTICE = 'v1.0 release candidate awaiting publication, these will not work yet.';
export const SOURCE_STATUS = RELEASE_PUBLISHED ? 'Free and open source, Apache-2.0 licence.' : 'Free, and open source once published. The source is private until the owner approves publication.';

export const PLATFORMS = [
  { id: 'linux-x64', label: 'Linux x64', ext: 'tar.gz' },
  { id: 'linux-arm64', label: 'Linux Arm64', ext: 'tar.gz' },
  { id: 'macos-arm64', label: 'macOS Apple silicon', ext: 'tar.gz' },
  { id: 'macos-x64', label: 'macOS Intel', ext: 'tar.gz' },
  { id: 'windows-x64', label: 'Windows x64', ext: 'zip' },
] as const;

export const assetName = (id: string, ext: string, version = RELEASE_VERSION) => `agentontrack-${version}-${id}.${ext}`;
export const assetUrl = (file: string, version = RELEASE_VERSION) => `${RELEASES}/download/v${version}/${file}`;
