import { readBearerToken, verifyJwt } from "../services/adminAuth.js";

export function requireAdminAuth(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing admin token" });
    }

    const payload = verifyJwt(token);
    if (payload.scope !== "admin" || payload.stage !== "access") {
      return res.status(401).json({ error: "Invalid admin session" });
    }

    req.admin = {
      loginId: String(payload.sub || ""),
      displayName: String(payload.displayName || "OrderX Admin"),
      exp: Number(payload.exp || 0),
      iat: Number(payload.iat || 0),
    };

    return next();
  } catch (error) {
    return res.status(401).json({ error: error?.message || "Unauthorized" });
  }
}
