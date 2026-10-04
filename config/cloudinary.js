const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { Readable } = require("stream");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Single shared memory storage instance — no need to recreate it per call.
const memoryStorage = multer.memoryStorage();

// Pre-built multer instances (created once at startup, not on every request).
const imageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("الملف المرفوع يجب أن يكون صورة فقط"));
    }
  },
});

const fileUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// makeImageUpload / makeFileUpload kept for backwards-compatibility with
// adminRoutes.js call sites, but now return the same shared instance instead
// of creating a new one each time.
function makeImageUpload() {
  return imageUpload;
}

function makeFileUpload() {
  return fileUpload;
}

function uploadToCloudinary(buffer, folder, options = {}) {
  // For images, apply automatic format, quality optimization, and max dimension limits (1600px).
  // This reduces storage and bandwidth consumption by up to 90% without visible loss of quality.
  const isRaw = options.resource_type === "raw";
  const defaultImageOptions = isRaw
    ? {}
    : {
        transformation: [
          { width: 1600, height: 1600, crop: "limit" },
          { quality: "auto" },
          { fetch_format: "auto" },
        ],
      };

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, ...defaultImageOptions, ...options },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(url, resource_type) {
  if (!url || !url.includes("cloudinary.com")) return;
  try {
    const isRaw = resource_type === "raw" || url.includes("/raw/upload/") || url.includes("/raw/");
    const actualResourceType = isRaw ? "raw" : (resource_type || "image");

    const parts = url.split("/");
    const uploadIndex = parts.indexOf("upload");
    if (uploadIndex === -1) return;
    let pathParts = parts.slice(uploadIndex + 1);
    if (/^v\d+$/.test(pathParts[0])) pathParts = pathParts.slice(1);

    let publicId = pathParts.join("/");
    // For images, Cloudinary strips the file extension in public_id.
    // For raw files (PDFs, docs), the public_id retains the file extension.
    if (!isRaw) {
      publicId = publicId.replace(/\.[^/.]+$/, "");
    }
    if (!publicId) return;
    await cloudinary.uploader.destroy(publicId, { resource_type: actualResourceType });
  } catch (e) {
    console.error("Cloudinary delete error:", e.message);
  }
}

module.exports = { makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary };
