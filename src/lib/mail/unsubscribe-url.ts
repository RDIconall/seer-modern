/**
 * List-Unsubscribe http(s) targets come from whoever sent the mail, so a
 * target is only handed to the user when it names a public host. Hosts
 * are read through the WHATWG URL parser — the same one the browser
 * navigates with — so decimal, hex, octal, userinfo and IPv4-mapped IPv6
 * spellings are judged by the address they actually reach.
 *
 * Pure and dependency-free: imported by both the server and the client.
 */

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
];

function nonPublicV4(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

/** Expand a canonical (WHATWG-serialized) IPv6 host into 8 groups. */
function v6Groups(host: string): number[] | null {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const groups = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

function nonPublicV6(host: string): boolean {
  const g = v6Groups(host);
  if (!g) return true;
  // ::/96 (IPv4-compatible, incl. :: and ::1) and ::ffff:0:0/96 (mapped)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0 || g[5] === 0xffff) return nonPublicV4(v4FromGroups(g[6], g[7]));
    return true;
  }
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // 64:ff9b::/96 NAT64 carries an IPv4 address; 64:ff9b:1::/48 is local-use
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return nonPublicV4(v4FromGroups(g[6], g[7]));
    }
    return true;
  }
  // 2002::/16 6to4 carries an IPv4 address in groups 1–2
  if (g[0] === 0x2002) return nonPublicV4(v4FromGroups(g[1], g[2]));
  // Teredo 2001::/32 and documentation 2001:db8::/32
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  return false;
}

function nonPublicHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    return nonPublicV6(host.slice(1, -1));
  }
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    return nonPublicV4(octets);
  }
  if (host.includes(":")) return true;
  if (host === "localhost") return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  // Single-label names resolve through local search domains only.
  if (!host.includes(".")) return true;
  return false;
}

/**
 * The canonical form of `raw` when it is an http(s) URL on a public host
 * with no embedded credentials, otherwise null. Callers must use the
 * returned string, not `raw`, so what was checked is what gets opened.
 */
export function publicUnsubscribeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (nonPublicHost(url.hostname)) return null;
  return url.href;
}
