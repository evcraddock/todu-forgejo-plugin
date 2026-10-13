import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("includes tombstones in CLI dry-run/write migration without overwriting them", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-tombstone-migration-"));
  try {
    const source = path.join(directory, "legacy");
    const destination = path.join(directory, "state");
    const filename = "issue-tombstones.json";
    const raw = '[{"bindingId":"binding-1","taskId":"task-1","issueNumber":1}]\n';
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, filename), raw);
    const run = (...flags: string[]) =>
      spawnSync(
        process.execPath,
        [
          path.join(process.cwd(), "scripts/migrate-forgejo-storage.mjs"),
          "--from",
          source,
          "--to",
          destination,
          ...flags,
        ],
        { encoding: "utf8", timeout: 10000 }
      );
    const dryRun = run();
    expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain(`MOVE  ${filename}`);
    expect(fs.readFileSync(path.join(source, filename), "utf8")).toBe(raw);
    expect(fs.existsSync(destination)).toBe(false);
    const write = run("--write");
    expect(write.status, write.stdout + write.stderr).toBe(0);
    expect(fs.readFileSync(path.join(destination, filename), "utf8")).toBe(raw);
    expect(fs.existsSync(source)).toBe(false);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, filename), "new evidence\n");
    const conflict = run("--write");
    expect(conflict.status).toBe(1);
    expect(conflict.stdout).toContain(`ERROR ${filename} (destination exists)`);
    expect(fs.readFileSync(path.join(destination, filename), "utf8")).toBe(raw);
    expect(fs.readFileSync(path.join(source, filename), "utf8")).toBe("new evidence\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
