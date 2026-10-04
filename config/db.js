const mongoose = require("mongoose");

let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
  if (cached.conn) {
    return cached.conn;
  }

  try {
    // Warn at startup if using the default insecure JWT secret.
    if (
      !process.env.JWT_SECRET ||
      process.env.JWT_SECRET.startsWith("CHANGE_THIS") ||
      process.env.JWT_SECRET === "burj_super_secret_jwt_key_2025_change_this_in_production"
    ) {
      console.warn("[SECURITY WARNING] JWT_SECRET is using the default insecure value. Change it in .env before going to production!");
    }

    if (!cached.promise) {
      cached.promise = mongoose.connect(process.env.MONGO_URI, {
        // Allow pool to scale down to 0 during idle periods to assist scale-to-zero
        minPoolSize: 0,
        // Limit the connection pool to avoid over-allocating connections on Atlas free-tier
        maxPoolSize: 10,
        // Drop connections that have been idle for more than 30 s so the pool
        // doesn't hold stale sockets against MongoDB Atlas.
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      }).then((instance) => {
        console.log("MongoDB connected");
        return instance;
      });
    }

    cached.conn = await cached.promise;
    return cached.conn;
  } catch (err) {
    cached.promise = null;
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }
};

// Log connection events for easier debugging in production.
mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
});

mongoose.connection.on("error", (err) => {
  console.error("MongoDB error:", err.message);
});

module.exports = connectDB;
