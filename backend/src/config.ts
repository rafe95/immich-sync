/** Runtime configuration from environment variables (see .env.example and docker-compose.yml). */

export type Config = {
  /** Interface to listen on; loopback by default, the Docker image sets 0.0.0.0 behind its localhost-only port mapping. */
  host: string;
  port: number;
  databaseUrl: string;
  adminPassword: string;
  /** Encrypts stored API keys. */
  secretKey: string;
  /** Built frontend to serve; null in development (Vite serves it). */
  staticDir: string | null;
  /** Session cookie Secure flag: "auto" follows the request (HTTPS or X-Forwarded-Proto). */
  cookieSecure: boolean | "auto";
  /** Use the first X-Forwarded-For hop as the login backoff key. Only enable behind a proxy that sets it. */
  trustProxy: boolean;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const MIN_SECRET_LENGTH = 32;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];
  const get = (name: string) => env[name]?.trim() ?? "";

  const databaseUrl = get("DATABASE_URL");
  if (!databaseUrl) problems.push("DATABASE_URL is required (postgres://user:password@host:5432/db).");
  else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push("DATABASE_URL must start with postgres://.");

  const adminPassword = get("ADMIN_PASSWORD");
  if (!adminPassword) problems.push("ADMIN_PASSWORD is required.");

  const secretKey = get("SECRET_KEY");
  if (secretKey.length < MIN_SECRET_LENGTH) {
    problems.push(`SECRET_KEY must be at least ${MIN_SECRET_LENGTH} characters (try: openssl rand -hex 32).`);
  }

  const portText = get("PORT") || "8080";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT is not a valid port: ${portText}`);

  const host = get("HOST") || "127.0.0.1";

  const cookieText = (get("COOKIE_SECURE") || "auto").toLowerCase();
  if (!["auto", "true", "false"].includes(cookieText)) problems.push("COOKIE_SECURE must be auto, true or false.");
  const cookieSecure = cookieText === "auto" ? "auto" : cookieText === "true";

  const trustText = (get("TRUST_PROXY") || "false").toLowerCase();
  if (!["true", "false"].includes(trustText)) problems.push("TRUST_PROXY must be true or false.");

  if (problems.length) throw new ConfigError(problems);
  return { host, port, databaseUrl, adminPassword, secretKey, staticDir: get("STATIC_DIR") || null, cookieSecure, trustProxy: trustText === "true" };
}
