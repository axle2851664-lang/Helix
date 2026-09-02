/**
 * Helix settings schema (spec 15).
 *
 * Settings are declared as field descriptors rather than a plain interface, so
 * one declaration gives us the TypeScript type, the default value, runtime
 * validation of persisted data, and a place to migrate from older shapes.
 * Persisted settings are untrusted input: they can be stale, hand-edited, or
 * written by an older Helix, so every value is validated on load.
 *
 * SECRETS ARE NOT SETTINGS. This schema holds provider *selection* and
 * endpoints only. API keys, tokens and passwords are never stored here and must
 * never be added to it - see docs/SECURITY.md.
 */

export type SettingsSection =
  | 'appearance'
  | 'voice'
  | 'camera'
  | 'vision'
  | 'gestures'
  | 'providers'
  | 'relay'
  | 'storage'
  | 'privacy'
  | 'advanced';

interface BaseField<T> {
  section: SettingsSection;
  label: string;
  description?: string;
  default: T;
}

export interface BooleanField extends BaseField<boolean> {
  kind: 'boolean';
}

export interface EnumField<T extends string> extends BaseField<T> {
  kind: 'enum';
  options: readonly T[];
  /** Labels shown in the UI, keyed by option value. */
  optionLabels?: Readonly<Record<T, string>>;
}

export interface NumberField extends BaseField<number> {
  kind: 'number';
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

export interface StringField extends BaseField<string> {
  kind: 'string';
  maxLength: number;
  placeholder?: string;
  /** Marks a field that names a location, for portability checks. */
  isPath?: boolean;
}

export type SettingsField =
  | BooleanField
  | EnumField<string>
  | NumberField
  | StringField;

/**
 * The schema. Adding a field here is all that is required for it to be typed,
 * defaulted, validated, persisted and rendered.
 */
export const SETTINGS_SCHEMA = {
  // ---------------------------------------------------------------- appearance
  theme: {
    kind: 'enum',
    section: 'appearance',
    label: 'Theme',
    options: ['dark', 'midnight'],
    optionLabels: { dark: 'Dark', midnight: 'Midnight' },
    default: 'dark',
  },
  accentIntensity: {
    kind: 'number',
    section: 'appearance',
    label: 'Accent intensity',
    description: 'Strength of the Helix red accent across the interface.',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    default: 70,
  },
  reduceMotion: {
    kind: 'boolean',
    section: 'appearance',
    label: 'Reduce motion',
    description: 'Disable status animations. Follows your system setting when enabled there.',
    default: false,
  },

  // --------------------------------------------------------------------- voice
  voiceInputMode: {
    kind: 'enum',
    section: 'voice',
    label: 'Voice input mode',
    description: 'How Helix begins listening.',
    options: ['push-to-talk', 'wake-word', 'continuous', 'disabled'],
    optionLabels: {
      'push-to-talk': 'Push to talk',
      'wake-word': 'Wake word',
      continuous: 'Continuous',
      disabled: 'Disabled',
    },
    default: 'push-to-talk',
  },
  wakeWord: {
    kind: 'string',
    section: 'voice',
    label: 'Wake word',
    maxLength: 32,
    placeholder: 'Helix',
    default: 'Helix',
  },
  speechToTextProvider: {
    kind: 'enum',
    section: 'voice',
    label: 'Speech recognition',
    description: 'Provider used to turn speech into text.',
    options: ['none', 'local', 'browser'],
    optionLabels: {
      none: 'None',
      local: 'Whisper on this machine (private)',
      browser: 'Browser speech (sends audio to Google)',
    },
    default: 'local',
  },
  textToSpeechProvider: {
    kind: 'enum',
    section: 'voice',
    label: 'Text to speech',
    options: ['none', 'browser', 'local', 'cloud'],
    optionLabels: {
      none: 'None',
      browser: 'Browser (Speech Synthesis)',
      local: 'Local model',
      cloud: 'Cloud provider',
    },
    /**
     * On by default, which the speech *input* setting deliberately is not.
     *
     * The two are not the same risk and should not share a default. Listening
     * opens a microphone; speaking hands text that is already on screen to the
     * operating system's own voices. Nothing is captured and nothing is sent.
     *
     * It was 'none', and the consequence was that Helix never spoke on a call:
     * `outputBlocker()` returned "no text-to-speech provider is configured"
     * and `speak()` returned silently, so a voice call worked in every respect
     * except the one the user was listening for.
     */
    default: 'browser',
  },
  /**
   * Which installed voice to speak with. Empty means choose the best match.
   *
   * Automatic by default, because the right answer is machine-dependent and
   * `selectVoice` ranks what is actually installed. Overridable, because
   * ranking voices by their names is crude and the user can hear what it
   * cannot.
   */
  voiceId: {
    kind: 'string',
    section: 'voice',
    label: 'Voice',
    description: 'Empty means the closest match to the Helix character.',
    maxLength: 300,
    default: '',
  },
  speechRate: {
    kind: 'number',
    section: 'voice',
    label: 'Speech rate',
    min: 50,
    max: 200,
    step: 5,
    unit: '%',
    default: 100,
  },

  /**
   * Free disk space below which Helix clears its own rebuildable caches.
   *
   * Zero switches it off entirely. The default is five gigabytes rather than
   * the 0.33 originally asked for, and the difference is not a liberty: on a
   * 237 GB drive, 0.33 GB free means Windows is already failing to save, while
   * the caches Helix can clear are measured in megabytes. Acting there would
   * be a gesture rather than a rescue. The lower figure is still permitted -
   * it is the user's machine - and `thresholdWarning` says plainly that it is
   * too late to help rather than accepting it in silence.
   */
  diskCleanupThresholdGb: {
    kind: 'number',
    section: 'storage',
    label: 'Clear caches below',
    description: 'Free disk space at which Helix clears its own caches. 0 turns it off.',
    min: 0,
    max: 100,
    step: 0.5,
    unit: ' GB',
    default: 5,
  },

  // --------------------------------------------------------------------- relay
  /**
   * The phone relay: a mailbox Helix polls for commands.
   *
   * Off by default, and that is not timidity. Switching it on turns an email
   * address into a way to make Helix act, and a feature that reaches the
   * machine from outside should be something the user turned on deliberately
   * rather than something they discovered was already on.
   */
  relayEnabled: {
    kind: 'boolean',
    section: 'relay',
    label: 'Accept commands by email',
    description: 'Poll the relay mailbox for instructions sent from your phone.',
    default: false,
  },
  relayOwnerAddress: {
    kind: 'string',
    section: 'relay',
    label: 'Your address',
    description: 'The only address Helix will take instructions from.',
    placeholder: 'you@gmail.com',
    maxLength: 320,
    default: '',
  },
  /**
   * The shared secret the phone includes in every message.
   *
   * Stored like every other setting, which on the shell means a file on this
   * disk. That is the same trust boundary as the Google refresh token beside
   * it: readable by this user's account, not encrypted. Worth knowing, and
   * worth not overstating - a machine where something hostile is already
   * running as the user has bigger problems than this field.
   */
  relaySecret: {
    kind: 'string',
    section: 'relay',
    label: 'Shared key',
    description: 'Four or five unrelated words. Messages without it are ignored.',
    maxLength: 200,
    default: '',
  },
  relayPollSeconds: {
    kind: 'number',
    section: 'relay',
    label: 'Check every',
    description: 'How often to look for new instructions.',
    min: 15,
    max: 600,
    step: 5,
    unit: ' seconds',
    default: 30,
  },
  /**
   * The OAuth client id and secret for the Google project.
   *
   * The word "secret" here is Google's, not a description. RFC 8252 is
   * explicit that an installed application cannot keep a client secret - it
   * ships on the user's machine, so anyone with the binary has it - and Google
   * documents desktop client secrets as not confidential for exactly that
   * reason. The security of this flow rests on PKCE and the loopback redirect,
   * both of which are in the shell. Storing this beside the other settings is
   * therefore not the weak point it looks like.
   *
   * The refresh token is an entirely different matter and never comes near
   * here: it is minted, stored and used in the shell, and no command returns
   * it.
   */
  googleClientId: {
    kind: 'string',
    section: 'relay',
    label: 'Google client ID',
    description: 'From the OAuth client you created in Google Cloud.',
    placeholder: '000000000000-xxxxxxxx.apps.googleusercontent.com',
    maxLength: 300,
    default: '',
  },
  googleClientSecret: {
    kind: 'string',
    section: 'relay',
    label: 'Google client secret',
    description: 'Not confidential for a desktop client - PKCE is what secures this.',
    maxLength: 300,
    default: '',
  },

  // -------------------------------------------------------------------- camera
  cameraDeviceId: {
    kind: 'string',
    section: 'camera',
    label: 'Preferred camera',
    description: 'Empty means use the system default.',
    maxLength: 200,
    default: '',
  },
  cameraIndicatorAlwaysVisible: {
    kind: 'boolean',
    section: 'camera',
    label: 'Always show camera indicator',
    description: 'Keep the active-camera indicator visible whenever the camera is on. Cannot be disabled.',
    default: true,
  },

  // -------------------------------------------------------------------- vision
  visionProvider: {
    kind: 'enum',
    section: 'vision',
    label: 'Vision provider',
    description: 'Used to analyse images, screenshots and camera frames.',
    options: ['none', 'local', 'cloud'],
    optionLabels: { none: 'None', local: 'Local model', cloud: 'Cloud provider' },
    default: 'none',
  },
  visionEndpoint: {
    kind: 'string',
    section: 'vision',
    label: 'Vision endpoint',
    description: 'Base URL of the vision provider. Credentials are stored separately, never here.',
    maxLength: 500,
    placeholder: 'http://localhost:11434',
    default: '',
  },

  // ------------------------------------------------------------------ gestures
  gestureProvider: {
    kind: 'enum',
    section: 'gestures',
    label: 'Hand tracking provider',
    options: ['none', 'mediapipe'],
    optionLabels: { none: 'None', mediapipe: 'MediaPipe Hands' },
    default: 'none',
  },
  gestureSensitivity: {
    kind: 'number',
    section: 'gestures',
    label: 'Pinch sensitivity',
    min: 1,
    max: 10,
    step: 1,
    default: 5,
  },

  // ----------------------------------------------------------------- providers
  languageProvider: {
    kind: 'enum',
    section: 'providers',
    label: 'Language model',
    description: 'Primary provider for conversation and reasoning.',
    options: ['none', 'local', 'cloud'],
    optionLabels: { none: 'None', local: 'Local model', cloud: 'Cloud provider' },
    default: 'none',
  },
  /**
   * Which infrastructure runs the model.
   *
   * Separate from the model itself, deliberately. Cerebras is not a model; it
   * is a service that runs Llama, Qwen and gpt-oss. Collapsing these two
   * settings into one is what produces a status panel reading
   * "AI MODEL: Cerebras".
   */
  inferenceProvider: {
    kind: 'enum',
    section: 'providers',
    label: 'Inference provider',
    description: 'The infrastructure that runs the model. Not the model itself.',
    options: ['none', 'local', 'cerebras', 'anthropic'],
    optionLabels: {
      none: 'None',
      local: 'Local inference (on this machine)',
      cerebras: 'Cerebras',
      anthropic: 'Anthropic',
    },
    default: 'none',
  },
  /** Used when the chosen provider fails or is over its limit. */
  fallbackInferenceProvider: {
    kind: 'enum',
    section: 'providers',
    label: 'Fallback provider',
    description: 'Used when the first choice fails. Helix always says when it falls back.',
    options: ['none', 'local', 'cerebras', 'anthropic'],
    optionLabels: {
      none: 'None',
      local: 'Local inference (on this machine)',
      cerebras: 'Cerebras',
      anthropic: 'Anthropic',
    },
    default: 'none',
  },
  preferLocalInference: {
    kind: 'boolean',
    section: 'providers',
    label: 'Prefer local inference',
    description:
      'Use a local model when one is configured, whatever else is available. Your words stay on this machine.',
    default: true,
  },
  temperature: {
    kind: 'number',
    section: 'providers',
    label: 'Temperature',
    description: 'Higher is more varied. Lower is more repeatable.',
    min: 0,
    max: 2,
    step: 0.1,
    default: 0.7,
  },
  maxOutputTokens: {
    kind: 'number',
    section: 'providers',
    label: 'Maximum output tokens',
    description: 'The longest reply Helix will ask for.',
    min: 256,
    max: 128_000,
    step: 256,
    default: 4096,
  },
  languageModel: {
    kind: 'enum',
    section: 'providers',
    label: 'Claude model',
    description:
      'Which Claude model Helix uses. Switch it here, or say "switch to Sonnet" on the home screen.',
    options: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'gpt-oss-120b',
      'llama-3.3-70b',
      'qwen-3-32b',
      'local-gguf',
    ],
    optionLabels: {
      'claude-opus-5': 'Opus 5 - most capable',
      'claude-sonnet-5': 'Sonnet 5 - balanced',
      'claude-haiku-4-5': 'Haiku 4.5 - fastest',
    },
    default: 'claude-opus-5',
  },

  languageEndpoint: {
    kind: 'string',
    section: 'providers',
    label: 'Language endpoint',
    maxLength: 500,
    placeholder: 'http://localhost:11434',
    default: '',
  },
  imageTo3DProvider: {
    kind: 'enum',
    section: 'providers',
    label: 'Image to 3D',
    options: ['none', 'local', 'cloud'],
    optionLabels: { none: 'None', local: 'Local model', cloud: 'Cloud provider' },
    default: 'none',
  },

  // ------------------------------------------------------------------- storage
  portableMode: {
    kind: 'boolean',
    section: 'storage',
    label: 'Portable mode',
    description: 'Keep all Helix data beside the application so it travels with the drive.',
    default: true,
  },
  dataDirectory: {
    kind: 'string',
    section: 'storage',
    label: 'Data location',
    description: 'Used only when portable mode is off.',
    maxLength: 400,
    isPath: true,
    default: '',
  },
  storageLimitGb: {
    kind: 'number',
    section: 'storage',
    label: 'Storage ceiling',
    description: 'Helix will not exceed this. Actual free space may be lower and always wins.',
    min: 1,
    max: 500,
    step: 1,
    unit: 'GB',
    default: 500,
  },
  backupCount: {
    kind: 'number',
    section: 'storage',
    label: 'Backups kept',
    min: 0,
    max: 10,
    step: 1,
    default: 2,
  },

  // ------------------------------------------------------------------- privacy
  saveConversationHistory: {
    kind: 'boolean',
    section: 'privacy',
    label: 'Keep conversation history',
    description: 'Short-term context is always in memory. This controls whether it is written to disk.',
    default: false,
  },
  allowLongTermMemory: {
    kind: 'boolean',
    section: 'privacy',
    label: 'Allow long-term memory',
    description: 'Helix only saves what you explicitly ask it to remember.',
    default: true,
  },
  allowComputerControl: {
    kind: 'boolean',
    section: 'privacy',
    label: 'Allow computer control',
    description: 'Lets Helix act on your computer. Destructive actions always require confirmation.',
    default: false,
  },

  // ------------------------------------------------------------------ advanced
  logLevel: {
    kind: 'enum',
    section: 'advanced',
    label: 'Log level',
    options: ['ERROR', 'WARN', 'INFO', 'DEBUG'],
    default: 'INFO',
  },
  offlineMode: {
    kind: 'enum',
    section: 'advanced',
    label: 'Connectivity',
    description: 'Automatic follows the network. Offline stops all cloud requests.',
    options: ['auto', 'offline'],
    optionLabels: { auto: 'Automatic', offline: 'Force offline' },
    default: 'auto',
  },
} as const satisfies Record<string, SettingsField>;

export type SettingsSchema = typeof SETTINGS_SCHEMA;
export type SettingsKey = keyof SettingsSchema;

/** Derives the value type of a field from its descriptor. */
type FieldValue<F> = F extends { kind: 'boolean' }
  ? boolean
  : F extends { kind: 'number' }
    ? number
    : F extends { kind: 'enum'; options: readonly (infer O)[] }
      ? O
      : F extends { kind: 'string' }
        ? string
        : never;

export type HelixSettings = {
  -readonly [K in SettingsKey]: FieldValue<SettingsSchema[K]>;
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA) as SettingsKey[];

export function getDefaultSettings(): HelixSettings {
  const out = {} as Record<string, unknown>;
  for (const key of SETTINGS_KEYS) {
    out[key] = SETTINGS_SCHEMA[key].default;
  }
  return out as HelixSettings;
}

/**
 * Validate and coerce a single value against its field descriptor.
 * Returns the field default when the value is unusable, so a corrupt or
 * outdated stored value degrades to a sane setting instead of breaking startup.
 */
export function coerceSetting<K extends SettingsKey>(
  key: K,
  value: unknown,
): { value: HelixSettings[K]; valid: boolean } {
  const field = SETTINGS_SCHEMA[key] as SettingsField;
  const fallback = field.default as HelixSettings[K];

  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { value: value as HelixSettings[K], valid: true }
        : { value: fallback, valid: false };

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { value: fallback, valid: false };
      }
      // Out-of-range values clamp rather than reset: a user who stored 900 GB
      // means "as much as possible", not "back to default".
      const clamped = Math.min(field.max, Math.max(field.min, value));
      return { value: clamped as HelixSettings[K], valid: clamped === value };
    }

    case 'enum':
      return typeof value === 'string' && (field.options as readonly string[]).includes(value)
        ? { value: value as HelixSettings[K], valid: true }
        : { value: fallback, valid: false };

    case 'string': {
      if (typeof value !== 'string') return { value: fallback, valid: false };
      if (value.length > field.maxLength) {
        return { value: value.slice(0, field.maxLength) as HelixSettings[K], valid: false };
      }
      return { value: value as HelixSettings[K], valid: true };
    }

    default: {
      // Exhaustiveness guard: a new field kind must be handled above.
      const never: never = field;
      void never;
      return { value: fallback, valid: false };
    }
  }
}

export interface ValidationReport {
  settings: HelixSettings;
  /** Keys whose stored value was missing, invalid, clamped or truncated. */
  repaired: SettingsKey[];
  /** Keys present in stored data that the schema no longer defines. */
  unknown: string[];
}

/** Validate an arbitrary persisted object into a complete settings record. */
export function validateSettings(input: unknown): ValidationReport {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const settings = {} as Record<string, unknown>;
  const repaired: SettingsKey[] = [];

  for (const key of SETTINGS_KEYS) {
    if (!(key in source)) {
      settings[key] = SETTINGS_SCHEMA[key].default;
      // A key absent from an older file is filled in, not treated as damage.
      continue;
    }
    const result = coerceSetting(key, source[key]);
    settings[key] = result.value;
    if (!result.valid) repaired.push(key);
  }

  const known = new Set<string>(SETTINGS_KEYS);
  const unknown = Object.keys(source).filter((key) => !known.has(key));

  return { settings: settings as HelixSettings, repaired, unknown };
}
