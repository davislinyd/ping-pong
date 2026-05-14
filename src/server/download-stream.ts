import crypto from "node:crypto";
import { Readable } from "node:stream";

export function createDownloadStream(totalBytes: number): Readable {
  const chunkSize = Math.min(1_048_576, totalBytes);
  const chunk = crypto.randomBytes(chunkSize);
  let remaining = totalBytes;

  return new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }

      const size = Math.min(chunk.length, remaining);
      remaining -= size;
      this.push(chunk.subarray(0, size));
    }
  });
}
