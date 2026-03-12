import type { SyncProviderConfig } from "@todu/core";

export type ForgejoProviderConfigErrorCode =
  | "INVALID_SETTINGS"
  | "MISSING_BASE_URL"
  | "INVALID_BASE_URL"
  | "MISSING_TOKEN"
  | "INVALID_AUTH_TYPE";

export type ForgejoAuthType = "token" | "bearer";

export interface ForgejoProviderSettings {
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  storageDir: string;
  authType: ForgejoAuthType;
}

export class ForgejoProviderConfigError extends Error {
  readonly code: ForgejoProviderConfigErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ForgejoProviderConfigErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ForgejoProviderConfigError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeForgejoBaseUrl(baseUrl: string): string {
  const normalizedInput = baseUrl.trim();
  if (!normalizedInput) {
    throw new ForgejoProviderConfigError(
      "MISSING_BASE_URL",
      "Invalid Forgejo provider settings: missing non-empty settings.baseUrl",
      {
        field: "settings.baseUrl",
      }
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedInput);
  } catch {
    throw new ForgejoProviderConfigError(
      "INVALID_BASE_URL",
      `Invalid Forgejo provider settings: settings.baseUrl must be a valid URL (received: \`${baseUrl}\`)`,
      {
        field: "settings.baseUrl",
        baseUrl,
      }
    );
  }

  parsedUrl.search = "";
  parsedUrl.hash = "";

  const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
  parsedUrl.pathname = normalizedPathname;

  return parsedUrl.toString().replace(/\/$/, "");
}

export function deriveForgejoApiBaseUrl(baseUrl: string): string {
  return `${normalizeForgejoBaseUrl(baseUrl)}/api/v1`;
}

export function loadForgejoProviderSettings(config: SyncProviderConfig): ForgejoProviderSettings {
  const settings = config.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ForgejoProviderConfigError(
      "INVALID_SETTINGS",
      "Invalid Forgejo provider settings: expected an object"
    );
  }

  const baseUrl = normalizeForgejoBaseUrl(String(settings.baseUrl ?? ""));

  const token = settings.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new ForgejoProviderConfigError(
      "MISSING_TOKEN",
      "Invalid Forgejo provider settings: missing non-empty settings.token",
      {
        field: "settings.token",
      }
    );
  }

  const storageDir = settings.storageDir;
  if (storageDir !== undefined && (typeof storageDir !== "string" || !storageDir.trim())) {
    throw new ForgejoProviderConfigError(
      "INVALID_SETTINGS",
      "Invalid Forgejo provider settings: settings.storageDir must be a non-empty string when provided",
      {
        field: "settings.storageDir",
      }
    );
  }

  const authType = settings.authType;
  if (authType !== undefined && authType !== "token" && authType !== "bearer") {
    throw new ForgejoProviderConfigError(
      "INVALID_AUTH_TYPE",
      "Invalid Forgejo provider settings: settings.authType must be `token` or `bearer` when provided",
      {
        field: "settings.authType",
        authType,
      }
    );
  }

  return {
    baseUrl,
    apiBaseUrl: deriveForgejoApiBaseUrl(baseUrl),
    token: token.trim(),
    storageDir: typeof storageDir === "string" ? storageDir.trim() : ".todu-forgejo-plugin",
    authType: authType ?? "token",
  };
}
