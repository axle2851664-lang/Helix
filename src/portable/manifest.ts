import type { PortablePlan } from './plan.js';
import { NEVER_COPIED, formatBytes } from './plan.js';

/**
 * The note written beside the copy, in plain text.
 *
 * It exists for the moment somebody finds this disk in a drawer in two years
 * and wants to know what is on it without running anything. That reader has
 * no Helix, no browser and no patience, so it is a text file, and it says
 * what is there rather than what the feature is called.
 *
 * It also names what is deliberately absent. A person restoring this copy
 * needs to know the Google connection did not come with it before they
 * wonder why the mail will not load.
 */
export function manifestText(plan: PortablePlan, when: Date): string {
  const lines: string[] = [
    'HELIX - PORTABLE COPY',
    '',
    `Written ${when.toISOString()}`,
    '',
    'WHAT IS IN THIS FOLDER',
  ];

  if (plan.include.length === 0) {
    lines.push('  Nothing.');
  }

  for (const item of plan.include) {
    const size = item.bytes === null ? '' : ` (${formatBytes(item.bytes)})`;
    lines.push(`  - ${item.label}${size}: ${item.detail}`);
  }

  if (plan.personal.length > 0) {
    lines.push(
      '',
      'THIS DISK IS NOT ENCRYPTED',
      '  Anyone who finds it can read the following without a password:',
    );
    for (const item of plan.personal) {
      lines.push(`  - ${item.label}: ${item.ifLost ?? ''}`);
    }
  }

  lines.push('', 'WHAT IS DELIBERATELY NOT HERE');
  for (const entry of NEVER_COPIED) {
    lines.push(`  - ${entry.what}: ${entry.because}`);
  }

  lines.push(
    '',
    'HOW TO USE IT',
    plan.carriesApp
      ? '  Open the "app" folder and run Helix from there. It needs nothing installed.'
      : '  This copy holds data only. Install Helix on the other machine first.',
    plan.include.some((item) => item.id !== 'app')
      ? '  Then use Settings > Storage > Restore, and choose data.helix.json from this folder.'
      : '',
    '',
    '  You will need to sign in to Google again on the other machine. That is on purpose:',
    '  a sign-in token on a disk you can lose is your mailbox in somebody else’s hands.',
  );

  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}
