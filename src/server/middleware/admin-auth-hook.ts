import { type FastifyReply, type FastifyRequest } from "fastify";

import { type AdminSessionManager } from "../admin-auth.js";

export function requireAdmin(adminSessions: AdminSessionManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!adminSessions.isConfigured()) {
      return reply.code(503).send({ error: "Admin password is not configured" });
    }
    const session = adminSessions.sessionFromCookie(request.headers.cookie);
    if (!session.authenticated) {
      return reply.code(401).send({ error: "Admin login required" });
    }
  };
}
