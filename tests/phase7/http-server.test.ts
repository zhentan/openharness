import http from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Phase 7: HTTP static server", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-http-server-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("serves built dashboard assets from dashboard/dist", async () => {
    const { createStaticServer } = await import("../../src/server/http-server.js");

    await mkdir(join(repoDir, "dashboard", "dist", "assets"), { recursive: true });
    await writeFile(join(repoDir, "dashboard", "dist", "index.html"), "<html>ok</html>", "utf8");
    await writeFile(join(repoDir, "dashboard", "dist", "assets", "app.js"), "console.log('ok');", "utf8");

    const server = createStaticServer(repoDir);
    await listen(server);

    try {
      const indexResponse = await request(server, "/");
      expect(indexResponse.statusCode).toBe(200);
      expect(indexResponse.headers["content-type"]).toMatch(/text\/html/);
      expect(indexResponse.body).toContain("<html>ok</html>");

      const assetResponse = await request(server, "/assets/app.js");
      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.headers["content-type"]).toMatch(/text\/javascript/);
      expect(assetResponse.body).toContain("console.log('ok');");
    } finally {
      await close(server);
    }
  });

  it("falls back to index.html for unknown SPA routes", async () => {
    const { createStaticServer } = await import("../../src/server/http-server.js");

    await mkdir(join(repoDir, "dashboard", "dist"), { recursive: true });
    await writeFile(join(repoDir, "dashboard", "dist", "index.html"), "<html>spa</html>", "utf8");

    const server = createStaticServer(repoDir);
    await listen(server);

    try {
      const response = await request(server, "/tasks/t_123");
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.body).toContain("<html>spa</html>");
    } finally {
      await close(server);
    }
  });

  it("blocks path traversal outside dashboard/dist", async () => {
    const { createStaticServer } = await import("../../src/server/http-server.js");

    await mkdir(join(repoDir, "dashboard", "dist"), { recursive: true });
    await writeFile(join(repoDir, "dashboard", "dist", "index.html"), "<html>safe</html>", "utf8");
    await writeFile(join(repoDir, "secret.txt"), "top secret", "utf8");

    const server = createStaticServer(repoDir);
    await listen(server);

    try {
      const response = await request(server, "/../../secret.txt");
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("Forbidden");
    } finally {
      await close(server);
    }
  });

  it("blocks symlinks that escape dashboard/dist", async () => {
    const { createStaticServer } = await import("../../src/server/http-server.js");

    await mkdir(join(repoDir, "dashboard", "dist", "assets"), { recursive: true });
    await writeFile(join(repoDir, "dashboard", "dist", "index.html"), "<html>safe</html>", "utf8");
    await writeFile(join(repoDir, "secret.txt"), "top secret", "utf8");
    await symlink(join(repoDir, "secret.txt"), join(repoDir, "dashboard", "dist", "assets", "secret.txt"));

    const server = createStaticServer(repoDir);
    await listen(server);

    try {
      const response = await request(server, "/assets/secret.txt");
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("Forbidden");
    } finally {
      await close(server);
    }
  });

  it("returns a helpful 404 when the dashboard has not been built", async () => {
    const { createStaticServer } = await import("../../src/server/http-server.js");

    const server = createStaticServer(repoDir);
    await listen(server);

    try {
      const response = await request(server, "/");
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("Dashboard not built");
    } finally {
      await close(server);
    }
  });
});

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function request(server: http.Server, path: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }

  return await new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );

    req.on("error", reject);
  });
}