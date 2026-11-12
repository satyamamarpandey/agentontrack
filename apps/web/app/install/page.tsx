import { INSTALL_GATED } from '../../lib/accounts-config';
import { Article } from '../content';
import { InstallGate } from './gate';
import { InstallSteps } from './steps';

export const metadata = { title: 'Install' };

export default function Install() {
  return (
    <Article title="Install AgentOnTrack" intro="For one user, with no administrator rights. The installer includes its own runtime, checks each file against the published checksum, and installs nothing if they differ. You also need an AI agent, installed and logged in separately: AgentOnTrack supervises one, it does not provide one.">
      {INSTALL_GATED ? <InstallGate /> : <InstallSteps />}
    </Article>
  );
}
