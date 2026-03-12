import { createForgejoSyncProvider, FORGEJO_PROVIDER_NAME, syncProvider } from "@/index";

describe("forgejo provider scaffold", () => {
  it("exports the expected provider manifest", () => {
    expect(syncProvider.manifest.name).toBe(FORGEJO_PROVIDER_NAME);
    expect(syncProvider.manifest.version).toBe("0.1.0");
  });

  it("tracks initialized state", async () => {
    const provider = createForgejoSyncProvider();

    expect(provider.getState().initialized).toBe(false);

    await provider.initialize({ settings: {} });
    expect(provider.getState().initialized).toBe(true);

    await provider.shutdown();
    expect(provider.getState().initialized).toBe(false);
  });
});
