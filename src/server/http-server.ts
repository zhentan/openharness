import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const BOOTSTRAP_PATH = "/_api/bootstrap";

export interface BootstrapProvider {
  getBootstrapData(): { wsUrl: string; token: string; kernelId: number } | null;
  isStopped(): boolean;
}

export function createStaticServer(repoDir: string, bootstrap?: BootstrapProvider): http.Server {
  const distDir = join(repoDir, "dashboard", "dist");

  return http.createServer(async (req, res) => {
    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    const pathname = safeDecodePath(rawPath);

    // Bootstrap endpoint: must resolve before SPA fallback (I7).
    if (pathname === BOOTSTRAP_PATH) {
      handleBootstrap(res, bootstrap);
      return;
    }

    if (pathname.includes("..")) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const filePath = resolve(distDir, pathname === "/" ? "index.html" : `.${pathname}`);
    const relativePath = relative(distDir, filePath);

    if (relativePath.startsWith("..") || resolve(distDir, relativePath) !== filePath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const fileStats = await stat(filePath);
      if (fileStats.isFile()) {
        const realDistDir = await realpath(distDir);
        const realFilePath = await realpath(filePath);
        const realRelativePath = relative(realDistDir, realFilePath);

        if (realRelativePath.startsWith("..") || resolve(realDistDir, realRelativePath) !== realFilePath) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }

        const content = await readFile(realFilePath);
        const contentType = MIME_TYPES[extname(realFilePath)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
        return;
      }
    } catch {
      // Fall back to the SPA entrypoint when a concrete asset is not found.
    }

    try {
      const indexPath = join(distDir, "index.html");
      const content = await readFile(indexPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Dashboard not built. Run: cd dashboard && npm run build");
    }
  });
}

function handleBootstrap(res: http.ServerResponse, bootstrap?: BootstrapProvider): void {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  // No bootstrap provider → runtime control not enabled (e.g., :memory: mode)
  if (!bootstrap) {
    res.writeHead(503, headers);
    res.end(JSON.stringify({ error: "Kernel not available" }));
    return;
  }

  // Kernel is shutting down
  if (bootstrap.isStopped()) {
    res.writeHead(503, headers);
    res.end(JSON.stringify({ error: "Kernel is shutting down" }));
    return;
  }

  // Wrap in try/catch — wsServer.url throws if not listening (F18)
  try {
    const data = bootstrap.getBootstrapData();
    if (!data) {
      res.writeHead(503, headers);
      res.end(JSON.stringify({ error: "Kernel not ready" }));
      return;
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify(data));
  } catch {
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
}

function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
