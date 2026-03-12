import {
  ForgejoProviderConfigError,
  loadForgejoProviderSettings,
  normalizeForgejoBaseUrl,
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
    expect(settings.storageDir).toBe(".todu-forgejo-plugin");
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
});
