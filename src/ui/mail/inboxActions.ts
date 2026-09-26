/**
 * The two decisions the inbox screen makes that are worth testing.
 *
 * A React component with no test harness in this project gets verified in a
 * browser, which catches layout and misses arithmetic. These two are
 * arithmetic, and both have already been wrong once: the action layer takes a
 * comma-separated string and an array passed to it typechecks cleanly (params
 * are `unknown`) before being refused at runtime.
 */

/** Every action the screen offers, and the one that puts it back. */
export const MAIL_UNDO: Readonly<Record<string, { action: string; label: string }>> = {
  'mail.archive': { action: 'mail.unarchive', label: 'Put back in the inbox' },
  'mail.star': { action: 'mail.unstar', label: 'Remove the star' },
  'mail.markRead': { action: 'mail.markUnread', label: 'Mark unread again' },
  'mail.trash': { action: 'mail.untrash', label: 'Take it back out of Trash' },
};

/**
 * The `ids` parameter, in the only shape the action layer accepts.
 *
 * Gmail ids are hex, so a comma can never appear inside one and joining can
 * never split an id in half. An id that somehow contained one would, though,
 * so such an id is dropped rather than silently turned into two - acting on a
 * message nobody selected is worse than acting on one fewer.
 */
export function encodeIds(ids: readonly string[]): string {
  return ids
    .map((id) => id.trim())
    .filter((id) => id !== '' && !id.includes(','))
    .join(',');
}
