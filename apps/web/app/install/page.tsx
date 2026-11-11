import { INSTALL_GATED } from '../../lib/accounts-config';
import { Article } from '../content';
import { InstallGate } from './gate';
import { InstallSteps } from './steps';

export const metadata = { title: 'Install' };

export default function Install() {
  return (
    <Article title="Install AgentOnTrack" intro="For one user, with no administrator rights and nothing else required: the download includes its own runtime. The installer checks each file against the published checksum, and installs nothing if they differ.">
      {INSTALL_GATED ? <InstallGate /> : <InstallSteps />}
    </Article>
  );
}
