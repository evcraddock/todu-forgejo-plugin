import fs from "node:fs";

import { FORGEJO_PROVIDER_NAME, FORGEJO_PROVIDER_VERSION, syncProvider } from "@/index";

describe("public exports", () => {
  it("exports the expected provider manifest", () => {
    expect(syncProvider.manifest.name).toBe(FORGEJO_PROVIDER_NAME);
    const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(FORGEJO_PROVIDER_VERSION).toBe(version);
    expect(syncProvider.manifest.version).toBe(version);
    expect(syncProvider.provider.version).toBe(version);
    expect(syncProvider.manifest.apiVersion).toBe(4);
  });
});
