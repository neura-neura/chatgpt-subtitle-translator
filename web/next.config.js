const basePath = process.env.NODE_ENV === "production"
  ? "/chatgpt-subtitle-translator"
  : ""

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  ...(basePath ? { basePath } : {}),
  distDir: "chatgpt-subtitle-translator"
}

module.exports = nextConfig
module.exports.basePath = basePath
