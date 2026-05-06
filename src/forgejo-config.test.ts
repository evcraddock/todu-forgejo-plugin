import os from "node:os";
import path from "node:path";

import {
  ForgejoProviderConfigError,
  getForgejoAppStateRoot,
  loadForgejoProviderSettings,
  normalizeForgejoBaseUrl,
  resolveForgejoInstanceSettings,
  resolveForgejoStorageDir,
} from "@/forgejo-config";

describe("forgejo config", () => {
  it("normalizes forgejo base urls and derives api base url", () => {
    const settings = loadForgejoProviderSettings({
      settings: {
        baseUrl: "https://code.example.com/forgejo/",
        token: " secret-token ",
      },
    });

    expect(settings.baseUrl).toBe("https://code.example.com/forgejo");
    expect(settings.apiBaseUrl).toBe("https://code.example.com/forgejo/api/v1");
    expect(settings.token).toBe("secret-token");
    expect(settings.storageDir).toBeNull();
    expect(settings.legacyStorageDir).toBeNull();
    expect(settings.authType).toBe("token");
  });

  it("supports bearer auth type when configured", () => {
    const settings = loadForgejoProviderSettings({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
        authType: "bearer",
      },
    });

    expect(settings.authType).toBe("bearer");
  });

  it("loads named forgejo instances with a configured default", () => {
    const settings = loadForgejoProviderSettings({
      settings: {
        defaultInstance: "forgejo",
        instances: {
          forgejo: {
            baseUrl: "https://forgejo.caradoc.com/",
            token: " forgejo-token ",
          },
          forge: {
            baseUrl: "https://forge.caradoc.com",
            token: "forge-token",
            authType: "bearer",
          },
        },
      },
    });

    expect(settings.defaultInstance).toBe("forgejo");
    expect(settings.baseUrl).toBe("https://forgejo.caradoc.com");
    expect(settings.token).toBe("forgejo-token");
    expect(settings.instances.forge.baseUrl).toBe("https://forge.caradoc.com");
    expect(settings.instances.forge.apiBaseUrl).toBe("https://forge.caradoc.com/api/v1");
    expect(settings.instances.forge.authType).toBe("bearer");
  });

  it("resolves the default or binding-selected forgejo instance", () => {
    const settings = loadForgejoProviderSettings({
      settings: {
        defaultInstance: "forgejo",
        instances: {
          forgejo: {
            baseUrl: "https://forgejo.caradoc.com",
            token: "forgejo-token",
          },
          forge: {
            baseUrl: "https://forge.caradoc.com",
            token: "forge-token",
          },
        },
      },
    });

    expect(resolveForgejoInstanceSettings(settings, {}).baseUrl).toBe(
      "https://forgejo.caradoc.com"
    );
    expect(
      resolveForgejoInstanceSettings(settings, { options: { instance: "forge" } }).baseUrl
    ).toBe("https://forge.caradoc.com");
  });

  it("preserves an explicit absolute storage directory when configured", () => {
    const storageDir = path.join(os.tmpdir(), "todu-forgejo-plugin-state");
    const settings = loadForgejoProviderSettings({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
        storageDir,
      },
    });

    expect(settings.storageDir).toBe(path.normalize(storageDir));
  });

  it("resolves relative storage directories under the app state root", () => {
    const settings = loadForgejoProviderSettings({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
        storageDir: ".todu-forgejo-plugin",
      },
    });

    expect(settings.storageDir).toBe(path.join(getForgejoAppStateRoot(), ".todu-forgejo-plugin"));
  });

  it("derives platform-specific app state roots", () => {
    expect(getForgejoAppStateRoot({ homedir: "/Users/alice", platform: "darwin" })).toBe(
      path.join("/Users/alice", "Library", "Application Support", "todu", "forgejo-plugin")
    );
    expect(getForgejoAppStateRoot({ env: {}, homedir: "/home/alice", platform: "linux" })).toBe(
      path.join("/home/alice", ".local", "state", "todu", "forgejo-plugin")
    );
    expect(
      getForgejoAppStateRoot({
        env: { XDG_STATE_HOME: "/var/state/alice" },
        homedir: "/home/alice",
        platform: "linux",
      })
    ).toBe(path.join("/var/state/alice", "todu", "forgejo-plugin"));
  });

  it("resolves home-relative and relative storage paths", () => {
    expect(resolveForgejoStorageDir("~/state", { homedir: "/Users/alice" })).toBe(
      path.join("/Users/alice", "state")
    );
    expect(
      resolveForgejoStorageDir("plugin-state", {
        env: {},
        homedir: "/home/alice",
        platform: "linux",
      })
    ).toBe(path.join("/home/alice", ".local", "state", "todu", "forgejo-plugin", "plugin-state"));
  });

  it("supports an explicit absolute legacy storage directory", () => {
    const storageDir = path.join(os.tmpdir(), "todu-forgejo-plugin-state");
    const legacyStorageDir = path.join(os.tmpdir(), "legacy-todu-forgejo-plugin-state");
    const settings = loadForgejoProviderSettings({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
        storageDir,
        legacyStorageDir,
      },
    });

    expect(settings.storageDir).toBe(path.normalize(storageDir));
    expect(settings.legacyStorageDir).toBe(path.normalize(legacyStorageDir));
  });

  it("rejects missing token or base url", () => {
    expect(() => loadForgejoProviderSettings({ settings: { token: "secret-token" } })).toThrow(
      ForgejoProviderConfigError
    );
    expect(() =>
      loadForgejoProviderSettings({ settings: { baseUrl: "https://code.example.com" } })
    ).toThrow(ForgejoProviderConfigError);
  });

  it("rejects invalid base urls", () => {
    expect(() => normalizeForgejoBaseUrl("not-a-url")).toThrow(ForgejoProviderConfigError);
  });

  it("rejects invalid auth types", () => {
    expect(() =>
      loadForgejoProviderSettings({
        settings: {
          baseUrl: "https://code.example.com",
          token: "secret-token",
          authType: "basic",
        },
      })
    ).toThrow(ForgejoProviderConfigError);
  });

  it("rejects invalid named instance settings with instance context", () => {
    expect(() =>
      loadForgejoProviderSettings({
        settings: {
          defaultInstance: "forge",
          instances: {
            forge: {
              baseUrl: "not-a-url",
              token: "secret-token",
            },
          },
        },
      })
    ).toThrow(/settings\.instances\.forge\.baseUrl/);
  });

  it("rejects unknown default or binding-selected instances", () => {
    expect(() =>
      loadForgejoProviderSettings({
        settings: {
          defaultInstance: "missing",
          instances: {
            forge: {
              baseUrl: "https://forge.caradoc.com",
              token: "secret-token",
            },
          },
        },
      })
    ).toThrow(ForgejoProviderConfigError);

    const settings = loadForgejoProviderSettings({
      settings: {
        defaultInstance: "forge",
        instances: {
          forge: {
            baseUrl: "https://forge.caradoc.com",
            token: "secret-token",
          },
        },
      },
    });

    expect(() =>
      resolveForgejoInstanceSettings(settings, { options: { instance: "missing" } })
    ).toThrow(/Unknown Forgejo instance `missing`/);
  });

  it("rejects relative legacy storage directories", () => {
    expect(() =>
      loadForgejoProviderSettings({
        settings: {
          baseUrl: "https://code.example.com",
          token: "secret-token",
          storageDir: "plugin-state",
          legacyStorageDir: ".todu-forgejo-plugin",
        },
      })
    ).toThrow(ForgejoProviderConfigError);
  });

  it("rejects legacy storage directories without storage directories", () => {
    expect(() =>
      loadForgejoProviderSettings({
        settings: {
          baseUrl: "https://code.example.com",
          token: "secret-token",
          legacyStorageDir: path.join(os.tmpdir(), "legacy-todu-forgejo-plugin-state"),
        },
      })
    ).toThrow(ForgejoProviderConfigError);
  });
});
