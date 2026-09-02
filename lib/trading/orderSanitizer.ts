/**
 * Utility to sanitize order `info` metadata before displaying it in the UI
 * or delivering it via API endpoints.
 * 
 * Completely neutralizes exposure of internal UUIDs, routing tags, and system operation logs,
 * preserving ONLY valid, human-readable user rejection or status messages.
 */

const SYSTEM_PREFIXES = [
  'EXIT -',
  'FIFO_',
  'POS-SL-',
  'POS-TARGET-',
  'POS-GTT-',
  'MODIFIED TO',
  'CANCELLED BY SYSTEM',
];

const SYSTEM_EXACT = new Set([
  'FIFO_EXIT',
  'EXIT - USER',
  'EXIT - SYSTEM',
  'EXIT - BROKER',
  'EXIT - LIQUIDATION',
  'SYSTEM_CANCEL',
]);

/**
 * Sanitizes raw `info` string from database or system logs.
 * Returns clean human-readable text, or `null` if the string contains internal metadata.
 */
export function sanitizeOrderInfo(info?: string | null): string | null {
  if (!info || typeof info !== 'string') return null;
  const trimmed = info.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();

  // 1. Check exact system tags
  if (SYSTEM_EXACT.has(upper)) {
    return null;
  }

  // 2. Check system prefixes
  for (const prefix of SYSTEM_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return null;
    }
  }

  // 3. Detect any UUID (7-8 hex chars, 4 hex chars, 4 hex chars, 4 hex chars, 12 hex chars) anywhere in the string
  // Handles standalone UUIDs like "0b01cd9-1878-4c86-a17f-6af9cf5d9027" or embedded ones in "0b01cd9-1878... (Modified to SLM)"
  const uuidRegex = /[0-9a-fA-F]{6,8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  if (uuidRegex.test(trimmed)) {
    return null;
  }

  // 4. Any hyphenated ID without spaces or with (Modified to...) suffix
  if (/^[0-9a-fA-F]{6,}-[0-9a-fA-F]{4,}/.test(trimmed)) {
    return null;
  }

  // 5. If info contains "(Modified to ...)" tag attached to internal info
  if (upper.includes('(MODIFIED TO')) {
    return null;
  }

  // If it survived all checks, return trimmed human-readable info
  return trimmed;
}

/**
 * Returns true if the `info` string contains valid user-visible information.
 */
export function isUserVisibleInfo(info?: string | null): boolean {
  return sanitizeOrderInfo(info) !== null;
}
