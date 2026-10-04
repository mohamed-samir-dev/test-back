const jwt = require("jsonwebtoken");

/**
 * Verifies the admin_token cookie and attaches the decoded payload to req.admin.
 * Used by both adminRoutes.js and checkoutRoutes.js.
 */
function authMiddleware(req, res, next) {
  const token =
    req.cookies?.admin_token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : null);

  if (!token) return res.status(401).json({ error: "غير مصرح" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "غير مصرح" });
  }
}

module.exports = { authMiddleware };
