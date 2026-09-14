import { fileTypeFromBuffer } from 'file-type';

/** MVP allowlist (docs/backend-architecture.md §10: "MVP permits JPEG, PNG,
 * WebP and PDF... Reject SVG/HTML"). Keyed by the value `file-type` itself
 * reports, never by a client-declared `Content-Type` header or filename
 * extension. */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export class UnsupportedFileTypeError extends Error {
  constructor(public readonly detectedType: string | null) {
    super(
      detectedType
        ? `Unsupported file type: ${detectedType}`
        : "Could not determine this file's actual type from its content",
    );
    this.name = 'UnsupportedFileTypeError';
  }
}

/**
 * Sniffs the buffer's actual content signature (magic bytes) and rejects
 * anything outside the allowlist — "verify... content signatures and
 * allowed media type, not just extension" (docs/backend-architecture.md
 * §10). A client claiming `Content-Type: image/png` for an HTML/SVG payload
 * (or any other mismatch) is caught here regardless of what the request
 * declared or what extension the filename carried.
 */
export async function detectAndValidateMimeType(
  buffer: Buffer,
): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
    throw new UnsupportedFileTypeError(detected?.mime ?? null);
  }
  return detected.mime;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function extensionForMimeType(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? 'bin';
}

const MAX_FILENAME_LENGTH = 255;

/**
 * Strips path separators, control characters, and anything else that could
 * make a filename dangerous in a `Content-Disposition` header or a naive
 * downstream consumer — this value is NEVER used to build a filesystem or
 * storage path (the opaque `storageKey` is), only echoed back for display
 * and download. Falls back to a generic name rather than ever returning an
 * empty string.
 */
export function sanitizeOriginalFilename(rawFilename: string): string {
  const base = rawFilename
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  const truncated = base.slice(0, MAX_FILENAME_LENGTH);
  return truncated.length > 0 ? truncated : 'file';
}
