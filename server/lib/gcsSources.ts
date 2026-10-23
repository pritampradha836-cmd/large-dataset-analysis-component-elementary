/**
 * Validation and serialization helpers for user-supplied Google Cloud Storage
 * (GCS) sources.
 *
 * SECURITY INVARIANTS (b/575856796):
 *
 * 1. Every value in this module originates from an unauthenticated HTTP
 *    request. It MUST NEVER be interpolated into generated source code
 *    (Python, shell, ...). The sandbox only ever receives these values as a
 *    JSON manifest that the static `agent/download_gcs.py` script parses.
 * 2. URIs are validated against the GCS bucket/object naming rules before
 *    they are used anywhere, and rejected with a 400 otherwise.
 * 3. Service-account credentials never leave the server process.
 */

/** A parsed and validated `gs://bucket/object` reference. */
export interface GcsObjectRef {
  readonly bucket: string;
  readonly object: string;
}

/** One entry of the download manifest handed to the sandbox. */
export interface GcsManifestEntry extends GcsObjectRef {
  /** Absolute path inside the sandbox the object is written to. */
  readonly target: string;
}

/** Shape of `/.agents/gcs_manifest.json`. Keep in sync with download_gcs.py. */
export interface GcsManifest {
  /** Public base URL of this server, used for the allowlisted proxy path. */
  readonly serverUrl: string | null;
  readonly files: readonly GcsManifestEntry[];
}

/** Result of {@link parseGcsUri}: a validated reference or a user-facing error. */
export type GcsUriParseResult =
  | { readonly ok: true; readonly ref: GcsObjectRef }
  | { readonly ok: false; readonly error: string };

/** Sandbox path of the manifest consumed by `agent/download_gcs.py`. */
export const GCS_MANIFEST_TARGET = "/.agents/gcs_manifest.json";

/** Sandbox directory all dataset files are staged in. */
export const SANDBOX_DATA_DIR = "/.agents/data";

/** Sandbox path of the static download script (checked in under agent/). */
export const SANDBOX_DOWNLOAD_SCRIPT = "/.agents/download_gcs.py";

const GS_SCHEME = "gs://";
const GCS_JSON_API_BASE_URL = "https://storage.googleapis.com/storage/v1/b/";

// https://cloud.google.com/storage/docs/buckets#naming
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

// https://cloud.google.com/storage/docs/objects#naming
const MAX_OBJECT_NAME_BYTES = 1024;
const OBJECT_NAME_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Parses and strictly validates a user-supplied `gs://` URI.
 *
 * The returned bucket and object names are safe to use as data (JSON, URL
 * components) but are still not safe to splice into code.
 */
export function parseGcsUri(uri: unknown): GcsUriParseResult {
  if (typeof uri !== "string") {
    return { ok: false, error: "GCS URI must be a string." };
  }
  const trimmed = uri.trim();
  if (!trimmed.startsWith(GS_SCHEME)) {
    return { ok: false, error: `GCS URI must start with ${GS_SCHEME}.` };
  }
  const withoutScheme = trimmed.slice(GS_SCHEME.length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) {
    return { ok: false, error: "GCS URI must include an object path." };
  }
  const bucket = withoutScheme.slice(0, slashIndex);
  const object = withoutScheme.slice(slashIndex + 1);

  if (!BUCKET_NAME_RE.test(bucket)) {
    return { ok: false, error: `Invalid GCS bucket name "${bucket}".` };
  }
  if (object.length === 0 || object === "." || object === "..") {
    return { ok: false, error: "GCS object name is empty or invalid." };
  }
  if (OBJECT_NAME_CONTROL_CHARS_RE.test(object)) {
    return {
      ok: false,
      error: "GCS object name contains control characters.",
    };
  }
  if (Buffer.byteLength(object, "utf8") > MAX_OBJECT_NAME_BYTES) {
    return { ok: false, error: "GCS object name is too long." };
  }
  return { ok: true, ref: { bucket, object } };
}

/** Canonical `gs://bucket/object` string for a validated reference. */
export function formatGcsUri(ref: GcsObjectRef): string {
  return `${GS_SCHEME}${ref.bucket}/${ref.object}`;
}

/** JSON API media URL for a validated reference (object name fully encoded). */
export function buildGcsObjectMediaUrl(ref: GcsObjectRef): string {
  const bucket = encodeURIComponent(ref.bucket);
  const object = encodeURIComponent(ref.object);
  return `${GCS_JSON_API_BASE_URL}${bucket}/o/${object}?alt=media`;
}

/**
 * Parses the `GCS_ALLOWED_BUCKETS` environment variable (comma separated).
 *
 * An empty set means "no restriction on which buckets may be referenced", in
 * which case only anonymously readable objects can be downloaded because no
 * credentials are ever attached outside of the allowlisted proxy path.
 */
export function parseAllowedBuckets(
  envValue: string | undefined,
): ReadonlySet<string> {
  const buckets = (envValue ?? "")
    .split(",")
    .map((bucket) => bucket.trim())
    .filter((bucket) => bucket.length > 0);
  return new Set(buckets);
}

/** Whether `bucket` may be referenced given the configured allowlist. */
export function isBucketAllowed(
  bucket: string,
  allowedBuckets: ReadonlySet<string>,
): boolean {
  return allowedBuckets.size === 0 || allowedBuckets.has(bucket);
}

/**
 * Whether the server may attach its own credentials when fetching `bucket`.
 * Unlike {@link isBucketAllowed}, an empty allowlist denies everything.
 */
export function isBucketProxyAllowed(
  bucket: string,
  allowedBuckets: ReadonlySet<string>,
): boolean {
  return allowedBuckets.has(bucket);
}

/**
 * Serializes the manifest consumed by the static `agent/download_gcs.py`.
 *
 * `JSON.stringify` is the only encoding step: no user-controlled value is ever
 * concatenated into code.
 */
export function buildGcsManifest(manifest: GcsManifest): string {
  return JSON.stringify(manifest, null, 2);
}
