// Local HTTPS static server for dev — WebGazer refuses to run over plain
// http:// (it hard-checks location.protocol), so `python3 -m http.server`
// isn't enough for prototype 3. Run this instead:
//
//   node serve-https.js [port]   (defaults to 8443)
//   open https://localhost:8443/
//
// Cert is in .certs/ (gitignored, generated with `mkcert localhost 127.0.0.1 ::1`).
// If .certs/ is missing, regenerate with mkcert or your own self-signed pair.

const https = require("https");
const fs = require("fs");
const path = require("path");

const port = Number(process.argv[2]) || 8443;
const root = __dirname;
const certDir = path.join(__dirname, ".certs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

const options = {
  key: fs.readFileSync(path.join(certDir, "key.pem")),
  cert: fs.readFileSync(path.join(certDir, "cert.pem")),
};

https
  .createServer(options, (req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath.endsWith("/")) reqPath += "index.html";
    const filePath = path.join(root, reqPath);

    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // Dev server: never cache. Without this the browser happily reuses
        // a previously-fetched sketch.js/dwell.js while index.html reloads,
        // so you tune a value, hit refresh, and are silently still running
        // the old code — which looks exactly like "my change did nothing".
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(data);
    });
  })
  .listen(port, () => {
    console.log(`https://localhost:${port}/`);
  });
