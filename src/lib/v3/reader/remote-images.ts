/** Block network-loaded images without disturbing embedded CID/data images. */
export function stripRemoteImages(html: string): string {
  let result = html.replace(
    /(<img\b[^>]*?)(\ssrc\s*=\s*)(["'])(https?:\/\/[^"']*)\3/gi,
    '$1 data-blocked-src=$3$4$3 src=$3$3',
  );
  result = result.replace(
    /url\(\s*(["']?)(https?:\/\/[^)"']*)\1\s*\)/gi,
    "none",
  );
  return result;
}

export function restoreRemoteImages(html: string): string {
  return html.replace(
    /(<img\b[^>]*?)\sdata-blocked-src\s*=\s*(["'])(https?:\/\/[^"']*)\2([^>]*?)\ssrc\s*=\s*(["'])\5/gi,
    "$1 src=$2$3$2$4",
  );
}

export function hasRemoteImages(html: string): boolean {
  return /data-blocked-src\s*=\s*["']https?:\/\//i.test(html);
}
