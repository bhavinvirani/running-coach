import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { authHandler } from "./auth/handler";
import { config } from "./lib/config";
import { errorHandler, notFoundHandler } from "./lib/errors";
import { logger, requestIdMiddleware } from "./lib/logger";
import { paths } from "./lib/paths";
import { registerRoutes } from "./routes";

// Files the browser must revalidate on every load so a deploy reaches installed PWAs.
const NO_CACHE_FILES = new Set(["index.html", "sw.js", "registerSW.js", "manifest.webmanifest"]);

function serveWebApp(app: Express, webDist: string): void {
  const indexHtml = path.join(webDist, "index.html");
  if (!existsSync(indexHtml)) return;

  app.use(
    express.static(webDist, {
      index: false,
      setHeaders(res, filePath) {
        const relative = path.relative(webDist, filePath);
        if (relative.startsWith(`assets${path.sep}`)) {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        } else if (NO_CACHE_FILES.has(relative)) {
          res.setHeader("cache-control", "no-cache");
        }
      },
    }),
  );
  // SPA fallback: client routes get index.html; a missing file (anything with an extension) stays a 404.
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/") || path.extname(req.path) !== "") {
      next();
      return;
    }
    res.setHeader("cache-control", "no-cache");
    res.sendFile(indexHtml);
  });
}

export interface AppOptions {
  /** The built web app to serve; skipped when it has no index.html (dev runs Vite instead). */
  webDist?: string;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  // Render puts one proxy in front; req.ip and req.protocol come from its X-Forwarded-* headers.
  app.set("trust proxy", 1);

  const csp = helmet.contentSecurityPolicy.getDefaultDirectives();
  if (config.APP_URL.startsWith("http://")) delete csp["upgrade-insecure-requests"];
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: csp } }));

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => String(res.getHeader("x-request-id")),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        return res.statusCode >= 400 ? "warn" : "info";
      },
      // Method, path and status only: no headers (cookies), no query strings.
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          path: req.url.split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );
  app.use(cors({ origin: config.APP_URL, credentials: true }));

  // Better Auth reads the raw body, so it comes before express.json().
  app.use("/api/auth", authHandler);
  app.use(express.json({ limit: "1mb" }));

  registerRoutes(app);
  serveWebApp(app, options.webDist ?? paths.webDist);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
