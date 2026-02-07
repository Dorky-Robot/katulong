const IMAGE_SIGNATURES = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ext: "png" },   // PNG
  { magic: Buffer.from([0xff, 0xd8, 0xff]),        ext: "jpg" },   // JPEG
  { magic: Buffer.from("GIF8"),                     ext: "gif" },   // GIF
];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// WebP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
export function detectImage(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length >= sig.magic.length && buf.subarray(0, sig.magic.length).equals(sig.magic)) {
      return sig.ext;
    }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return "webp";
  }
  return null;
}

export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Body too large"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
