import os from "node:os";
import path from "node:path";

import type { IntegrationBinding, SyncProviderConfig } from "@todu/core";

export type ForgejoProviderConfigErrorCode =
  | "INVALID_SETTINGS"
  | "MISSING_BASE_URL"
  | "INVALID_BASE_URL"
  | "MISSING_TOKEN"
  | "INVALID_AUTH_TYPE"
  | "INVALID_STORAGE_DIR"
  | "INVALID_INSTANCE"
  | "UNKNOWN_INSTANCE";

export type ForgejoAuthType = "token" | "bearer";

export interface ForgejoInstanceSettings {
  name: string;
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  authType: ForgejoAuthType;
}

export interface ForgejoProviderSettings extends ForgejoInstanceSettings {
  storageDir: string | null;
  legacyStorageDir: string | null;
  defaultInstance: string | null;
  instances: Record<string, ForgejoInstanceSettings>;
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

export function normalizeForgejoBaseUrl(baseUrl: string, field = "settings.baseUrl"): string {
  const normalizedInput = baseUrl.trim();
  if (!normalizedInput) {
    throw new ForgejoProviderConfigError(
      "MISSING_BASE_URL",
      `Invalid Forgejo provider settings: missing non-empty ${field}`,
      {
        field,
      }
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedInput);
  } catch {
    throw new ForgejoProviderConfigError(
      "INVALID_BASE_URL",
      `Invalid Forgejo provider settings: ${field} must be a valid URL (received: \`${baseUrl}\`)`,
      {
        field,
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

export interface ForgejoAppStateRootOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
}

export function getForgejoAppStateRoot(options: ForgejoAppStateRootOptions = {}): string {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "todu", "forgejo-plugin");
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homedir, "AppData", "Local");
    return path.join(localAppData, "todu", "forgejo-plugin");
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir, ".local", "state");
  return path.join(xdgStateHome, "todu", "forgejo-plugin");
}

export function expandForgejoHomePath(inputPath: string, homedir = os.homedir()): string {
  if (inputPath === "~") {
    return homedir;
  }

  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homedir, inputPath.slice(2));
  }

  return inputPath;
}

export function resolveForgejoStorageDir(
  storageDir: string,
  options: ForgejoAppStateRootOptions = {}
): string {
  const homedir = options.homedir ?? os.homedir();
  const expandedStorageDir = expandForgejoHomePath(storageDir.trim(), homedir);

  if (path.isAbsolute(expandedStorageDir)) {
    return path.normalize(expandedStorageDir);
  }

  return path.resolve(getForgejoAppStateRoot(options), expandedStorageDir);
}

export function deriveForgejoApiBaseUrl(baseUrl: string): string {
  return `${normalizeForgejoBaseUrl(baseUrl)}/api/v1`;
}

export function getForgejoBindingInstanceName(
  binding: Pick<IntegrationBinding, "options">
): string | null {
  const selectedInstance = binding.options?.instance;
  if (selectedInstance === undefined || selectedInstance === null) {
    return null;
  }

  if (typeof selectedInstance !== "string" || !selectedInstance.trim()) {
    throw new ForgejoProviderConfigError(
      "INVALID_INSTANCE",
      "Invalid Forgejo integration binding option: options.instance must be a non-empty string",
      {
        field: "options.instance",
        instance: selectedInstance,
      }
    );
  }

  return selectedInstance.trim();
}

export function resolveForgejoInstanceSettings(
  settings: ForgejoProviderSettings,
  binding: Pick<IntegrationBinding, "options">
): ForgejoInstanceSettings {
  const selectedInstance = getForgejoBindingInstanceName(binding) ?? settings.defaultInstance;
  if (!selectedInstance) {
    return settings;
  }

  const instance = settings.instances[selectedInstance];
  if (!instance) {
    throw new ForgejoProviderConfigError(
      "UNKNOWN_INSTANCE",
      `Unknown Forgejo instance \`${selectedInstance}\`: configure settings.instances.${selectedInstance}`,
      {
        field: "options.instance",
        instance: selectedInstance,
      }
    );
  }

  return instance;
}

export function loadForgejoProviderSettings(config: SyncProviderConfig): ForgejoProviderSettings {
  const settings = config.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ForgejoProviderConfigError(
      "INVALID_SETTINGS",
      "Invalid Forgejo provider settings: expected an object"
    );
  }

  const storage = loadForgejoStorageSettings(settings);
  const instances = loadForgejoInstances(settings);
  const defaultInstance = loadDefaultForgejoInstanceName(settings, instances);

  const legacyInstance = loadOptionalForgejoInstance(settings, "settings");
  const selectedDefaultInstance = defaultInstance ? instances[defaultInstance] : legacyInstance;

  if (!selectedDefaultInstance) {
    throw new ForgejoProviderConfigError(
      "MISSING_BASE_URL",
      "Invalid Forgejo provider settings: configure either settings.baseUrl/settings.token or settings.instances with settings.defaultInstance",
      {
        field: "settings.baseUrl",
      }
    );
  }

  return {
    ...selectedDefaultInstance,
    storageDir: storage.storageDir,
    legacyStorageDir: storage.legacyStorageDir,
    defaultInstance,
    instances,
  };
}

function loadDefaultForgejoInstanceName(
  settings: Record<string, unknown>,
  instances: Record<string, ForgejoInstanceSettings>
): string | null {
  const defaultInstance = settings.defaultInstance;
  if (defaultInstance === undefined || defaultInstance === null) {
    return null;
  }

  if (typeof defaultInstance !== "string" || !defaultInstance.trim()) {
    throw new ForgejoProviderConfigError(
      "INVALID_INSTANCE",
      "Invalid Forgejo provider settings: settings.defaultInstance must be a non-empty string",
      {
        field: "settings.defaultInstance",
        defaultInstance,
      }
    );
  }

  const normalizedDefaultInstance = defaultInstance.trim();
  if (!instances[normalizedDefaultInstance]) {
    throw new ForgejoProviderConfigError(
      "UNKNOWN_INSTANCE",
      `Invalid Forgejo provider settings: settings.defaultInstance \`${normalizedDefaultInstance}\` is not defined in settings.instances`,
      {
        field: "settings.defaultInstance",
        defaultInstance: normalizedDefaultInstance,
      }
    );
  }

  return normalizedDefaultInstance;
}

function loadForgejoInstances(
  settings: Record<string, unknown>
): Record<string, ForgejoInstanceSettings> {
  const rawInstances = settings.instances;
  if (rawInstances === undefined || rawInstances === null) {
    return {};
  }

  if (typeof rawInstances !== "object" || Array.isArray(rawInstances)) {
    throw new ForgejoProviderConfigError(
      "INVALID_INSTANCE",
      "Invalid Forgejo provider settings: settings.instances must be an object when provided",
      {
        field: "settings.instances",
      }
    );
  }

  const instances: Record<string, ForgejoInstanceSettings> = {};
  for (const [instanceName, rawInstance] of Object.entries(rawInstances)) {
    const normalizedInstanceName = instanceName.trim();
    if (!normalizedInstanceName) {
      throw new ForgejoProviderConfigError(
        "INVALID_INSTANCE",
        "Invalid Forgejo provider settings: settings.instances keys must be non-empty strings",
        {
          field: "settings.instances",
          instance: instanceName,
        }
      );
    }

    instances[normalizedInstanceName] = loadRequiredForgejoInstance(
      rawInstance,
      normalizedInstanceName,
      `settings.instances.${normalizedInstanceName}`
    );
  }

  return instances;
}

function loadRequiredForgejoInstance(
  rawInstance: unknown,
  name: string,
  fieldPrefix: string
): ForgejoInstanceSettings {
  if (!rawInstance || typeof rawInstance !== "object" || Array.isArray(rawInstance)) {
    throw new ForgejoProviderConfigError(
      "INVALID_INSTANCE",
      `Invalid Forgejo provider settings: ${fieldPrefix} must be an object`,
      {
        field: fieldPrefix,
        instance: name,
      }
    );
  }

  const instance = loadOptionalForgejoInstance(
    rawInstance as Record<string, unknown>,
    fieldPrefix,
    name
  );
  if (!instance) {
    throw new ForgejoProviderConfigError(
      "MISSING_BASE_URL",
      `Invalid Forgejo provider settings: missing non-empty ${fieldPrefix}.baseUrl`,
      {
        field: `${fieldPrefix}.baseUrl`,
        instance: name,
      }
    );
  }

  return instance;
}

function loadOptionalForgejoInstance(
  settings: Record<string, unknown>,
  fieldPrefix: string,
  name = "default"
): ForgejoInstanceSettings | null {
  const hasBaseUrl = settings.baseUrl !== undefined && settings.baseUrl !== null;
  const hasToken = settings.token !== undefined && settings.token !== null;
  if (!hasBaseUrl && !hasToken) {
    return null;
  }

  const baseUrl = normalizeForgejoBaseUrl(String(settings.baseUrl ?? ""), `${fieldPrefix}.baseUrl`);

  const token = settings.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new ForgejoProviderConfigError(
      "MISSING_TOKEN",
      `Invalid Forgejo provider settings: missing non-empty ${fieldPrefix}.token`,
      {
        field: `${fieldPrefix}.token`,
        instance: name,
      }
    );
  }

  const authType = settings.authType;
  if (authType !== undefined && authType !== "token" && authType !== "bearer") {
    throw new ForgejoProviderConfigError(
      "INVALID_AUTH_TYPE",
      `Invalid Forgejo provider settings: ${fieldPrefix}.authType must be \`token\` or \`bearer\` when provided`,
      {
        field: `${fieldPrefix}.authType`,
        instance: name,
        authType,
      }
    );
  }

  return {
    name,
    baseUrl,
    apiBaseUrl: deriveForgejoApiBaseUrl(baseUrl),
    token: token.trim(),
    authType: authType ?? "token",
  };
}

function loadForgejoStorageSettings(settings: Record<string, unknown>): {
  storageDir: string | null;
  legacyStorageDir: string | null;
} {
  const storageDir = settings.storageDir;
  if (storageDir !== undefined && (typeof storageDir !== "string" || !storageDir.trim())) {
    throw new ForgejoProviderConfigError(
      "INVALID_STORAGE_DIR",
      "Invalid Forgejo provider settings: settings.storageDir must be a non-empty string when provided",
      {
        field: "settings.storageDir",
      }
    );
  }

  const legacyStorageDir = settings.legacyStorageDir;
  if (
    legacyStorageDir !== undefined &&
    (typeof legacyStorageDir !== "string" || !legacyStorageDir.trim())
  ) {
    throw new ForgejoProviderConfigError(
      "INVALID_STORAGE_DIR",
      "Invalid Forgejo provider settings: settings.legacyStorageDir must be a non-empty string when provided",
      {
        field: "settings.legacyStorageDir",
      }
    );
  }

  if (legacyStorageDir !== undefined && storageDir === undefined) {
    throw new ForgejoProviderConfigError(
      "INVALID_STORAGE_DIR",
      "Invalid Forgejo provider settings: settings.legacyStorageDir requires settings.storageDir",
      {
        field: "settings.legacyStorageDir",
      }
    );
  }

  const resolvedLegacyStorageDir =
    typeof legacyStorageDir === "string" ? expandForgejoHomePath(legacyStorageDir.trim()) : null;
  if (resolvedLegacyStorageDir && !path.isAbsolute(resolvedLegacyStorageDir)) {
    throw new ForgejoProviderConfigError(
      "INVALID_STORAGE_DIR",
      "Invalid Forgejo provider settings: settings.legacyStorageDir must be an absolute path",
      {
        field: "settings.legacyStorageDir",
        legacyStorageDir,
      }
    );
  }

  return {
    storageDir: typeof storageDir === "string" ? resolveForgejoStorageDir(storageDir) : null,
    legacyStorageDir: resolvedLegacyStorageDir ? path.normalize(resolvedLegacyStorageDir) : null,
  };
}
