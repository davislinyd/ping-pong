import crypto from "node:crypto";

export function browserFamily(userAgentHeader: string | undefined): string {
  const userAgent = userAgentHeader ?? "";
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/Chrome\//i.test(userAgent) && !/Chromium\//i.test(userAgent)) return "Chrome";
  if (/Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent)) return "Safari";
  if (/Chromium\//i.test(userAgent)) return "Chromium";
  return "Unknown";
}

export function coarseIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  const cleaned = ip.replace(/^::ffff:/, "");

  const ipv4Match = cleaned.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4Match) {
    return `ipv4:${ipv4Match[1]}.${ipv4Match[2]}.${ipv4Match[3]}.0`;
  }

  if (cleaned === "::1" || cleaned === "127.0.0.1") return "loopback";

  if (cleaned.includes(":")) {
    const groups = cleaned.toLowerCase().split(":").filter(Boolean).slice(0, 4);
    return `ipv6:${groups.join(":") || "compressed"}`;
  }

  return "unknown";
}

export function anonymousClientId(input: {
  ip: string | undefined;
  userAgent: string | undefined;
  serverName: string;
}): { browserFamily: string; clientId: string } {
  const family = browserFamily(input.userAgent);
  const coarseAddress = coarseIp(input.ip);
  const clientId = crypto
    .createHash("sha256")
    .update(`${coarseAddress}|${family}|${input.serverName}`)
    .digest("hex")
    .slice(0, 20);

  return { browserFamily: family, clientId };
}

const browserClientIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function browserClientHash(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;

  const normalized = value.trim().toLowerCase();
  if (!browserClientIdPattern.test(normalized)) {
    return null;
  }

  return crypto.createHash("sha256").update(normalized).digest("hex");
}
