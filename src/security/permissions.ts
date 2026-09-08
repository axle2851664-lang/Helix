/**
 * What Helix is allowed to do, declared as data (spec 6).
 *
 * The rule this file exists to enforce is a single sentence from the
 * specification: *Helix must not automatically have unrestricted access to
 * everything.* Every sensitive capability is named here, and nothing that is
 * not named here can be granted - `PermissionManager` refuses ids it does not
 * recognise rather than inventing a record for them.
 *
 * Three fields carry most of the weight, and each is here because leaving it
 * out produces a specific failure:
 *
 * - **`secondGate`** names the *other* thing that must also say yes. A Helix
 *   grant is necessary, never sufficient: the microphone still needs the
 *   operating system, and Gmail still needs Google's own consent screen. Left
 *   out, "granted" starts to read as "working", and the first honest bug
 *   report is a feature that claims a capability it does not have.
 *
 * - **`alwaysConfirm`** marks the permissions that a grant must never turn into
 *   a blanket. Deleting, exporting and sending are irreversible from the user's
 *   side; agreeing once that Helix *may* delete is not agreeing that it may
 *   delete *this*. The action layer reads this flag; the grant alone is not
 *   enough to proceed.
 *
 * - **`requires`** records a real dependency between capabilities. Hand
 *   tracking is a camera feed with a model on top, so granting hand tracking
 *   while the camera is denied would be a permission that cannot do anything.
 *   Stating it here means the check happens once, in the manager, rather than
 *   being remembered at every call site.
 *
 * `risk` orders the Settings list and decides nothing on its own. It is a
 * label for the user, not a switch.
 */

export type PermissionId =
  // --- Files (spec 6, 11) ---
  | 'FILES_READ'
  | 'FILES_WRITE'
  | 'FILES_DELETE'
  | 'FILES_MOVE'
  | 'FILES_EXPORT'
  // --- Google (spec 8) ---
  | 'GOOGLE_ACCOUNT'
  | 'GOOGLE_GMAIL_READ'
  | 'GOOGLE_GMAIL_SEND'
  | 'GOOGLE_CALENDAR_READ'
  | 'GOOGLE_CALENDAR_WRITE'
  | 'GOOGLE_DRIVE_READ'
  | 'GOOGLE_DRIVE_WRITE'
  | 'GOOGLE_YOUTUBE_READ'
  | 'GOOGLE_YOUTUBE_MANAGE'
  // --- Phone (spec 9) ---
  | 'PHONE_PAIR'
  | 'PHONE_MESSAGES_READ'
  | 'PHONE_MESSAGES_SEND'
  | 'PHONE_NOTIFICATIONS'
  | 'PHONE_FILES'
  // --- Sensors (spec 5, 10) ---
  | 'MICROPHONE'
  | 'CAMERA'
  | 'HAND_TRACKING'
  // --- The rest (spec 6) ---
  | 'WEB_ACCESS'
  | 'SYSTEM_ACTIONS';

export type PermissionGroup = 'files' | 'google' | 'phone' | 'sensors' | 'system';

export type PermissionRisk = 'low' | 'medium' | 'high';

export interface PermissionDescriptor {
  id: PermissionId;
  group: PermissionGroup;
  /** Shown in Settings. */
  label: string;
  /** What the user is agreeing to, in their words. No jargon, no scope URLs. */
  description: string;
  risk: PermissionRisk;
  /**
   * The other consent that must also be given, or null when Helix's own grant
   * is the only gate. Never a thing Helix can grant itself.
   */
  secondGate: string | null;
  /**
   * True when each individual use needs its own confirmation, however the
   * permission was granted. Irreversible and outbound actions only.
   */
  alwaysConfirm: boolean;
  /** A permission this one cannot work without. */
  requires: PermissionId | null;
}

function permission(descriptor: PermissionDescriptor): PermissionDescriptor {
  return descriptor;
}

export const PERMISSIONS: Readonly<Record<PermissionId, PermissionDescriptor>> = {
  // ------------------------------------------------------------------- files
  FILES_READ: permission({
    id: 'FILES_READ',
    group: 'files',
    label: 'Read your files',
    description: 'Open and read files in the folders you have added to your vault.',
    risk: 'low',
    secondGate: null,
    alwaysConfirm: false,
    requires: null,
  }),
  FILES_WRITE: permission({
    id: 'FILES_WRITE',
    group: 'files',
    label: 'Create and change files',
    description: 'Write new files, and edit existing ones, inside your vault folders.',
    risk: 'medium',
    secondGate: null,
    alwaysConfirm: false,
    requires: null,
  }),
  FILES_DELETE: permission({
    id: 'FILES_DELETE',
    group: 'files',
    label: 'Delete files',
    description: 'Remove files from your vault folders. Helix asks before each deletion.',
    risk: 'high',
    secondGate: null,
    // Nothing here is undoable from the user's side, so one grant is never
    // agreement to a particular deletion.
    alwaysConfirm: true,
    requires: null,
  }),
  FILES_MOVE: permission({
    id: 'FILES_MOVE',
    group: 'files',
    label: 'Move and rename files',
    description: 'Move files between your vault folders, and rename them.',
    risk: 'medium',
    secondGate: null,
    alwaysConfirm: false,
    requires: null,
  }),
  FILES_EXPORT: permission({
    id: 'FILES_EXPORT',
    group: 'files',
    label: 'Copy files out of Helix',
    description:
      'Copy files to somewhere outside your vault, such as a USB drive or another folder.',
    risk: 'high',
    secondGate: null,
    // An export is the one file action whose result Helix stops governing.
    alwaysConfirm: true,
    requires: null,
  }),

  // ------------------------------------------------------------------ google
  GOOGLE_ACCOUNT: permission({
    id: 'GOOGLE_ACCOUNT',
    group: 'google',
    label: 'Connect a Google account',
    description: 'Sign in to Google so Helix can be given access to specific Google services.',
    risk: 'low',
    secondGate: "Google's own sign-in and consent screen",
    alwaysConfirm: false,
    requires: null,
  }),
  GOOGLE_GMAIL_READ: permission({
    id: 'GOOGLE_GMAIL_READ',
    group: 'google',
    label: 'Read your mail',
    description: 'Read messages in your Gmail account, including senders, subjects and bodies.',
    risk: 'high',
    secondGate: "Google's consent screen, which grants the mail scopes separately",
    alwaysConfirm: false,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_GMAIL_SEND: permission({
    id: 'GOOGLE_GMAIL_SEND',
    group: 'google',
    label: 'Send mail as you',
    description: 'Send email from your account. Helix shows you every message before it goes.',
    risk: 'high',
    secondGate: "Google's consent screen, which grants the send scope separately",
    alwaysConfirm: true,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_CALENDAR_READ: permission({
    id: 'GOOGLE_CALENDAR_READ',
    group: 'google',
    label: 'Read your calendar',
    description: 'See your events, so Helix can answer what is coming up.',
    risk: 'medium',
    secondGate: "Google's consent screen",
    alwaysConfirm: false,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_CALENDAR_WRITE: permission({
    id: 'GOOGLE_CALENDAR_WRITE',
    group: 'google',
    label: 'Change your calendar',
    description: 'Create, edit and cancel events. Invitations reach other people, so Helix asks first.',
    risk: 'high',
    secondGate: "Google's consent screen",
    alwaysConfirm: true,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_DRIVE_READ: permission({
    id: 'GOOGLE_DRIVE_READ',
    group: 'google',
    label: 'Read your Drive files',
    description: 'Open files stored in your Google Drive.',
    risk: 'high',
    secondGate: "Google's consent screen",
    alwaysConfirm: false,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_DRIVE_WRITE: permission({
    id: 'GOOGLE_DRIVE_WRITE',
    group: 'google',
    label: 'Change your Drive files',
    description: 'Upload to, and edit files in, your Google Drive.',
    risk: 'high',
    secondGate: "Google's consent screen",
    alwaysConfirm: false,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_YOUTUBE_READ: permission({
    id: 'GOOGLE_YOUTUBE_READ',
    group: 'google',
    label: 'Read your YouTube channel',
    description: 'See your uploads, playlists and channel statistics.',
    risk: 'medium',
    secondGate: "Google's consent screen",
    alwaysConfirm: false,
    requires: 'GOOGLE_ACCOUNT',
  }),
  GOOGLE_YOUTUBE_MANAGE: permission({
    id: 'GOOGLE_YOUTUBE_MANAGE',
    group: 'google',
    label: 'Manage your YouTube channel',
    description: 'Upload videos and change titles, descriptions and visibility.',
    risk: 'high',
    secondGate: "Google's consent screen",
    // Publishing is public and immediate; a grant is not a licence to publish.
    alwaysConfirm: true,
    requires: 'GOOGLE_ACCOUNT',
  }),

  // ------------------------------------------------------------------- phone
  PHONE_PAIR: permission({
    id: 'PHONE_PAIR',
    group: 'phone',
    label: 'Pair with your phone',
    description: 'Let a phone you have paired connect to Helix over your own private network.',
    risk: 'low',
    secondGate: null,
    alwaysConfirm: false,
    requires: null,
  }),
  PHONE_MESSAGES_READ: permission({
    id: 'PHONE_MESSAGES_READ',
    group: 'phone',
    label: 'Receive your messages',
    description: 'Save messages your phone forwards to Helix into your vault.',
    risk: 'high',
    secondGate: 'the phone itself, which decides what it is willing to forward',
    alwaysConfirm: false,
    requires: 'PHONE_PAIR',
  }),
  PHONE_MESSAGES_SEND: permission({
    id: 'PHONE_MESSAGES_SEND',
    group: 'phone',
    label: 'Send messages from your phone',
    description: 'Ask your phone to send a message. Helix shows you the message before it goes.',
    risk: 'high',
    secondGate: 'the phone itself',
    alwaysConfirm: true,
    requires: 'PHONE_PAIR',
  }),
  PHONE_NOTIFICATIONS: permission({
    id: 'PHONE_NOTIFICATIONS',
    group: 'phone',
    label: 'Receive phone notifications',
    description: 'See notifications your phone forwards to Helix.',
    risk: 'medium',
    secondGate: 'the phone itself',
    alwaysConfirm: false,
    requires: 'PHONE_PAIR',
  }),
  PHONE_FILES: permission({
    id: 'PHONE_FILES',
    group: 'phone',
    label: 'Exchange files with your phone',
    description: 'Send files to your phone, and accept files it sends to Helix.',
    risk: 'medium',
    secondGate: 'the phone itself',
    alwaysConfirm: false,
    requires: 'PHONE_PAIR',
  }),

  // ----------------------------------------------------------------- sensors
  MICROPHONE: permission({
    id: 'MICROPHONE',
    group: 'sensors',
    label: 'Use your microphone',
    description: 'Listen when you are speaking to Helix. Nothing is recorded to disk.',
    risk: 'high',
    // The OS prompt is the real gate. Helix cannot answer it on the user's
    // behalf and must not present its own grant as though it had.
    secondGate: 'your operating system, which asks separately and can revoke it at any time',
    alwaysConfirm: false,
    requires: null,
  }),
  CAMERA: permission({
    id: 'CAMERA',
    group: 'sensors',
    label: 'Use your camera',
    description: 'Show a live camera view. A frame is captured only when you ask for one.',
    risk: 'high',
    secondGate: 'your operating system, which asks separately and can revoke it at any time',
    alwaysConfirm: false,
    requires: null,
  }),
  HAND_TRACKING: permission({
    id: 'HAND_TRACKING',
    group: 'sensors',
    label: 'Track your hands',
    description: 'Watch the camera for hand gestures so you can point, grab and pinch.',
    risk: 'high',
    secondGate: 'your operating system, through the camera permission this depends on',
    alwaysConfirm: false,
    // A gesture model with no camera feed is a permission that can do nothing.
    requires: 'CAMERA',
  }),

  // ------------------------------------------------------------------ system
  WEB_ACCESS: permission({
    id: 'WEB_ACCESS',
    group: 'system',
    label: 'Reach the internet',
    description: 'Fetch pages and search the web when you ask a question Helix cannot answer locally.',
    risk: 'medium',
    secondGate: null,
    alwaysConfirm: false,
    requires: null,
  }),
  SYSTEM_ACTIONS: permission({
    id: 'SYSTEM_ACTIONS',
    group: 'system',
    label: 'Control this computer',
    description: 'Open applications and act on this computer on your behalf.',
    risk: 'high',
    secondGate: 'your operating system, which gates automation separately on macOS and Windows',
    alwaysConfirm: true,
    requires: null,
  }),
};

export const PERMISSION_IDS = Object.keys(PERMISSIONS) as PermissionId[];

/** Narrow untrusted input - a stored record, a relay command - to a known id. */
export function isPermissionId(value: unknown): value is PermissionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function describePermission(id: PermissionId): PermissionDescriptor {
  return PERMISSIONS[id];
}

/** Ids in a stable order for Settings: grouped, then most sensitive first. */
export function permissionsByGroup(group: PermissionGroup): PermissionDescriptor[] {
  const rank: Record<PermissionRisk, number> = { high: 0, medium: 1, low: 2 };
  return PERMISSION_IDS.map((id) => PERMISSIONS[id])
    .filter((descriptor) => descriptor.group === group)
    .sort((a, b) => rank[a.risk] - rank[b.risk] || a.label.localeCompare(b.label));
}
