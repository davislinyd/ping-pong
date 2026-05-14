import net from "node:net";
import os from "node:os";

export type ClientSafety = {
  isLocalClient: boolean;
  reason: "loopback" | "server-address" | null;
  message: string | null;
};

export function detectLocalClient(clientIp: string | undefined): ClientSafety {
  const normalized = normalizeIp(clientIp);

  if (!normalized) {
    return safeRemote();
  }

  if (isLoopback(normalized)) {
    return {
      isLocalClient: true,
      reason: "loopback",
      message: "This browser is connected from the same machine through loopback. Speed values are functional checks, not real network measurements."
    };
  }

  if (serverAddresses().has(normalized)) {
    return {
      isLocalClient: true,
      reason: "server-address",
      message: "This browser appears to be running on the speed-test server. Use another device to measure the real intranet path."
    };
  }

  return safeRemote();
}

function safeRemote(): ClientSafety {
  return {
    isLocalClient: false,
    reason: null,
    message: null
  };
}

function serverAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      const normalized = normalizeIp(item.address);
      if (normalized) {
        addresses.add(normalized);
      }
    }
  }

  return addresses;
}

function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  const stripped = value.trim().replace(/^::ffff:/, "");
  const zoneIndex = stripped.indexOf("%");
  const normalized = zoneIndex === -1 ? stripped : stripped.slice(0, zoneIndex);

  if (net.isIP(normalized) === 0) {
    return null;
  }

  return normalized.toLowerCase();
}

function isLoopback(value: string): boolean {
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;

  if (net.isIPv4(value)) {
    const [first] = value.split(".");
    return first === "127";
  }

  return false;
}
