import { type FastifyReply, type FastifyRequest } from "fastify";

import { detectLocalClient } from "../local-client.js";
import { type RuntimeSettingsService } from "../settings.js";

export function requireTestAccess(runtimeSettings: RuntimeSettingsService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const settings = runtimeSettings.current();
    const safety = detectLocalClient(request.ip);
    const canRunTest = settings.allowLocalSelfTest || !safety.isLocalClient;

    if (canRunTest) return;

    return reply.code(403).send({
      error: "Local self-tests are disabled",
      clientSafety: {
        ...safety,
        canRunTest,
        message:
          safety.isLocalClient && !canRunTest
            ? `${safety.message} Testing is disabled on this machine.`
            : safety.message
      }
    });
  };
}
