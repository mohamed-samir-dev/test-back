require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const connectDB = require("./config/db");
const mongoose = require("mongoose");
const productRoutes = require("./routes/productRoutes");
const checkoutRoutes = require("./routes/checkoutRoutes");
const adminRoutes = require("./routes/adminRoutes");

connectDB();

const app = express();
const isProd = process.env.NODE_ENV === "production";

// Trust first proxy (Render, Railway, Fly.io, Cloudflare, etc.) so req.ip returns the real client IP
app.set("trust proxy", 1);

// Compress all HTTP response payloads (reduces egress bandwidth by 60-70%).
app.use(compression());

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",").map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// Keep body limits tight — the largest legitimate payload is a product with
// a few image URLs. 1 MB is generous; 2 MB was never needed.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Lightweight in-process rate limiter for the login endpoint.
// Prevents brute-force without adding a dependency.
// Stores at most MAX_ENTRIES IPs; oldest entries are purged each window.
// ---------------------------------------------------------------------------
const LOGIN_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX        = 10;              // max attempts per window per IP
const MAX_ENTRIES      = 5_000;          // cap map size to avoid memory leak
const loginAttempts    = new Map();       // ip → { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now >= entry.resetAt) loginAttempts.delete(ip);
  }
}, LOGIN_WINDOW_MS).unref(); // .unref() so the timer doesn't keep Node alive

app.use("/api/admin/login", (req, res, next) => {
  if (req.method !== "POST") return next();
  const ip  = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    // Evict oldest entry when the map is full.
    if (loginAttempts.size >= MAX_ENTRIES) {
      loginAttempts.delete(loginAttempts.keys().next().value);
    }
    loginAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > LOGIN_MAX) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set("Retry-After", retryAfter);
    return res.status(429).json({ error: "محاولات كثيرة، حاول بعد قليل" });
  }
  next();
});

// Root & lightweight health endpoints
app.get("/", (req, res) => {
  res.json({ message: "API is running..." });
});

app.get("/health", (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res.status(dbStatus === "connected" ? 200 : 503).json({
    status: dbStatus === "connected" ? "healthy" : "unhealthy",
    db: dbStatus,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (req, res) => {
  res.json({});
});

app.use("/api/products", productRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/orders", checkoutRoutes);
app.use("/api/admin", adminRoutes);

// Centralized JSON error handler
// Ensures all errors (Multer file limits, CORS, syntax errors) return JSON
// and never leak stack traces to clients in production.
app.use((err, req, res, next) => {
  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "حجم الملف كبير جداً" });
    }
    return res.status(400).json({ error: `خطأ في رفع الملف: ${err.message}` });
  }

  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "غير مصرح به عبر CORS" });
  }

  const statusCode = err.status || err.statusCode || 500;
  const message = isProd && statusCode === 500 ? "خطأ في الخادم" : err.message || "خطأ في الخادم";

  console.error(`[Error] ${req.method} ${req.url}:`, err.message);
  res.status(statusCode).json({ error: message });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Graceful Shutdown: safely close server and database connections on restart/termination
const gracefulShutdown = async (signal) => {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  server.close(async () => {
    console.log("HTTP server closed.");
    try {
      await mongoose.connection.close(false);
      console.log("MongoDB connection closed.");
      process.exit(0);
    } catch (dbErr) {
      console.error("Error closing MongoDB connection:", dbErr.message);
      process.exit(1);
    }
  });

  // Force shutdown after 10s if connections remain open
  setTimeout(() => {
    console.error("Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000).unref();
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Prevent silent crashes from unhandled promise rejections.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});
