/**
 * Helix icon set.
 *
 * Original 24x24 stroke paths drawn for Helix - no third-party icon library and
 * no copied assets. Uniform 1.6 stroke weight and rounded caps keep the
 * navigation visually consistent.
 */

export type IconName =
  | 'plus'
  | 'conversation'
  | 'brain'
  | 'folder'
  | 'globe'
  | 'code'
  | 'image'
  | 'earth'
  | 'drive'
  | 'upload'
  | 'gesture'
  | 'gear'
  | 'lock'
  | 'clock'
  | 'microphone'
  | 'paperclip'
  | 'panel'
  | 'send'
  | 'activity'
  | 'chip'
  | 'close'
  | 'menu';

const PATHS: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  conversation: 'M21 11.5a8.4 8.4 0 0 1-9 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5z',
  brain:
    'M9.5 4.5A2.5 2.5 0 0 0 7 7a2.5 2.5 0 0 0-1 4.8V15a3 3 0 0 0 4.5 2.6M9.5 4.5A2.5 2.5 0 0 1 12 7v11M9.5 4.5a2.5 2.5 0 0 1 5 0M14.5 4.5A2.5 2.5 0 0 1 17 7a2.5 2.5 0 0 1 1 4.8V15a3 3 0 0 1-4.5 2.6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z',
  code: 'M8 17l-5-5 5-5M16 7l5 5-5 5M14 4l-4 16',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
  earth:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.6 9h4.2l2 3-1.5 3.4 1.8 3.3M20.2 8.4l-3.4 1.2-2.4-1.8L15 4.2',
  drive: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 15h.01M11 15h6',
  upload: 'M12 16V4m0 0L8 8m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  gesture:
    'M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4.5A5.5 5.5 0 0 1 11.5 21H11a6 6 0 0 1-6-6v-2a1.5 1.5 0 0 1 3 0',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.1 14.4a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.1-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1z',
  lock: 'M6 11h12v9H6zM9 11V7.5a3 3 0 0 1 6 0V11',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  microphone: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM5 11a7 7 0 0 0 14 0M12 18v3',
  paperclip: 'M21 11.5 12.3 20a5 5 0 0 1-7-7L14 4.3a3.3 3.3 0 1 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 1 1-2.4-2.4l7.9-7.8',
  panel: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM15 5v14',
  send: 'M12 19V5m0 0-6 6m6-6 6 6',
  activity: 'M4 12h3l2.5-7 5 14 2.5-7h3',
  chip: 'M8 8h8v8H8zM4 10h4M4 14h4M16 10h4M16 14h4M10 4v4M14 4v4M10 16v4M14 16v4',
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
