#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FORGEJO_STORAGE_STATE_FILES = ["item-links.json", "comment-links.json", "runtime-state.json"];

function parseArgs(argv) {
  const args = {
    from: null,
    to: getForgejoAppStateRoot(),
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--from") {
      args.from = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--to") {
      args.to = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--write") {
      args.write = true;
      continue;
    }

    if (arg === "--dry-run") {
      args.write = false;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.from) {
    throw new Error("Missing required --from <legacy-storage-dir>");
  }

  return {
    from: requireAbsolutePath(expandHomePath(args.from), "--from"),
    to: requireAbsolutePath(expandHomePath(args.to), "--to"),
    write: args.write,
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-forgejo-storage.mjs --from <legacy-storage-dir> [options]

Dry-run by default. Moves known Forgejo plugin state files from an old cwd-relative
storage directory into a stable storage directory without overwriting existing files.

Options:
  --from <path>   absolute path to old .todu-forgejo-plugin directory (required)
  --to <path>     absolute destination storage directory
                  default: ${getForgejoAppStateRoot()}
  --write         perform the move; otherwise only print planned actions
  --dry-run       print planned actions without moving files (default)
  -h, --help      show help

Known state files:
  ${FORGEJO_STORAGE_STATE_FILES.join("\n  ")}
`);
}

function getForgejoAppStateRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "todu", "forgejo-plugin");
  }

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "todu", "forgejo-plugin");
  }

  const xdgStateHome =
    process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
  return path.join(xdgStateHome, "todu", "forgejo-plugin");
}

function expandHomePath(inputPath) {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function requireAbsolutePath(inputPath, flag) {
  if (!path.isAbsolute(inputPath)) {
    throw new Error(`${flag} must be an absolute path`);
  }

  return path.normalize(inputPath);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

function moveFileWithoutOverwrite(sourcePath, destinationPath) {
  if (fs.existsSync(destinationPath)) {
    throw new Error(
      `Cannot migrate ${sourcePath}: destination already exists at ${destinationPath}`
    );
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EXDEV") {
      throw error;
    }

    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(sourcePath);
  }
}

function inspectMigration(options) {
  if (path.resolve(options.from) === path.resolve(options.to)) {
    throw new Error("--from and --to resolve to the same directory");
  }

  if (!fs.existsSync(options.from)) {
    throw new Error(`Legacy storage directory does not exist: ${options.from}`);
  }

  const legacyStats = fs.statSync(options.from);
  if (!legacyStats.isDirectory()) {
    throw new Error(`Legacy storage path is not a directory: ${options.from}`);
  }

  return FORGEJO_STORAGE_STATE_FILES.map((filename) => {
    const sourcePath = path.join(options.from, filename);
    const destinationPath = path.join(options.to, filename);

    if (!fs.existsSync(sourcePath)) {
      return { filename, sourcePath, destinationPath, action: "skip-missing" };
    }

    const sourceStats = fs.statSync(sourcePath);
    if (!sourceStats.isFile()) {
      return { filename, sourcePath, destinationPath, action: "error-not-file" };
    }

    if (fs.existsSync(destinationPath)) {
      return { filename, sourcePath, destinationPath, action: "error-destination-exists" };
    }

    return { filename, sourcePath, destinationPath, action: "move" };
  });
}

function printPlan(options, plan) {
  console.log(`Forgejo storage migration (${options.write ? "write" : "dry-run"})`);
  console.log(`From: ${options.from}`);
  console.log(`To:   ${options.to}`);
  console.log("");

  for (const item of plan) {
    if (item.action === "move") {
      console.log(`MOVE  ${item.filename}`);
      console.log(`      ${item.sourcePath}`);
      console.log(`   -> ${item.destinationPath}`);
      continue;
    }

    if (item.action === "skip-missing") {
      console.log(`SKIP  ${item.filename} (missing)`);
      continue;
    }

    if (item.action === "error-not-file") {
      console.log(`ERROR ${item.filename} (source is not a file): ${item.sourcePath}`);
      continue;
    }

    if (item.action === "error-destination-exists") {
      console.log(`ERROR ${item.filename} (destination exists): ${item.destinationPath}`);
    }
  }
}

function applyMigration(options, plan) {
  const blockingErrors = plan.filter((item) => item.action.startsWith("error-"));
  if (blockingErrors.length > 0) {
    throw new Error("Migration blocked; resolve errors above before running with --write");
  }

  let moved = 0;
  for (const item of plan) {
    if (item.action !== "move") {
      continue;
    }

    moveFileWithoutOverwrite(item.sourcePath, item.destinationPath);
    moved += 1;
  }

  if (moved > 0) {
    try {
      fs.rmdirSync(options.from);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")) {
        throw error;
      }
    }
  }

  return moved;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = inspectMigration(options);
  printPlan(options, plan);

  const blockingErrors = plan.filter((item) => item.action.startsWith("error-"));
  if (blockingErrors.length > 0) {
    process.exitCode = 1;
    return;
  }

  if (!options.write) {
    console.log("\nDry-run only. Re-run with --write to move files.");
    return;
  }

  const moved = applyMigration(options, plan);
  console.log(`\nMoved ${moved} file(s).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
