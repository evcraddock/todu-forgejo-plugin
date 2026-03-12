import { FORGEJO_PROVIDER_NAME, FORGEJO_PROVIDER_VERSION, syncProvider } from "@/index";

describe("public exports", () => {
  it("exports the expected provider manifest", () => {
    expect(syncProvider.manifest.name).toBe(FORGEJO_PROVIDER_NAME);
    expect(syncProvider.manifest.version).toBe(FORGEJO_PROVIDER_VERSION);
  });
});
