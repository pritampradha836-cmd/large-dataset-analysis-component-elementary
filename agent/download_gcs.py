"""Downloads the dataset files listed in /.agents/gcs_manifest.json.

This script is intentionally static. All request-specific values (bucket,
object, destination) are read from a JSON manifest written by the server and
are only ever used as data: as URL components and as a destination path that
must resolve inside /.agents/data. Nothing from the manifest is executed and
no credentials are present in the sandbox. See b/575856796.

The manifest shape is defined by `GcsManifest` in server/lib/gcsSources.ts.

Download strategy per file, first success wins:
  1. The server's /api/download-file proxy (only serves allowlisted buckets,
     credentials stay on the server).
  2. Anonymous GCS JSON API download (publicly readable objects).
  3. Anonymous GCS XML API download (publicly readable objects).
"""

from collections.abc import Mapping, Sequence
import json
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request

MANIFEST_PATH = os.environ.get("GCS_MANIFEST_PATH", "/.agents/gcs_manifest.json")
DATA_DIR = os.path.abspath(os.environ.get("GCS_DATA_DIR", "/.agents/data"))
DOWNLOAD_TIMEOUT_SECONDS = 300
GCS_JSON_API_BASE_URL = "https://storage.googleapis.com/storage/v1/b/"
GCS_XML_API_BASE_URL = "https://storage.googleapis.com/"


def build_candidate_urls(
    entry: Mapping[str, str], server_url: str | None
) -> Sequence[str]:
  """Returns the download URLs to try, in order, for one manifest entry."""
  bucket = entry["bucket"]
  obj = entry["object"]
  urls = []
  if server_url:
    query = urllib.parse.urlencode({"gsUri": f"gs://{bucket}/{obj}"})
    urls.append(f"{server_url}/api/download-file?{query}")
  quoted_bucket = urllib.parse.quote(bucket, safe="")
  urls.append(
      f"{GCS_JSON_API_BASE_URL}{quoted_bucket}/o/"
      f"{urllib.parse.quote(obj, safe='')}?alt=media"
  )
  urls.append(
      f"{GCS_XML_API_BASE_URL}{quoted_bucket}/{urllib.parse.quote(obj)}"
  )
  return urls


def safe_target(entry: Mapping[str, str]) -> str | None:
  """Returns the destination path, or None if it is not directly in DATA_DIR."""
  target = os.path.abspath(entry["target"])
  if os.path.dirname(target) != DATA_DIR:
    print(f"Refusing to write outside {DATA_DIR}: {target}", file=sys.stderr)
    return None
  return target


def download(url: str, target: str) -> None:
  """Atomically downloads `url` into `target`, raising on HTTP or I/O failure.

  The body is streamed to a sibling `.part` file (still inside DATA_DIR because
  `target` already passed `safe_target`) and renamed into place on success, so
  a failed attempt never leaves a truncated dataset behind.
  """
  partial = f"{target}.part"
  request = urllib.request.Request(url)
  try:
    with urllib.request.urlopen(
        request, timeout=DOWNLOAD_TIMEOUT_SECONDS
    ) as response, open(partial, "wb") as out:
      shutil.copyfileobj(response, out)
    os.replace(partial, target)
  finally:
    if os.path.exists(partial):
      os.unlink(partial)


def main() -> None:
  with open(MANIFEST_PATH, encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
  os.makedirs(DATA_DIR, exist_ok=True)

  failures = []
  for entry in manifest.get("files", []):
    target = safe_target(entry)
    if target is None:
      failures.append(entry)
      continue
    for url in build_candidate_urls(entry, manifest.get("serverUrl")):
      try:
        download(url, target)
      except (urllib.error.URLError, OSError, TimeoutError) as err:
        print(f"Download from {url} failed: {err}", file=sys.stderr)
      else:
        print(f"Downloaded gs://{entry['bucket']}/{entry['object']} -> {target}")
        break
    else:
      failures.append(entry)

  if failures:
    names = ", ".join(f"gs://{f['bucket']}/{f['object']}" for f in failures)
    print(f"Failed to download: {names}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
  main()
