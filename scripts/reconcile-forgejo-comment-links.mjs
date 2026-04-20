#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SYNC_EXTERNAL_ID_TAG_PREFIX = "sync:externalId:";
const LEGACY_NOTE_ID_PREFIX = "external:";

function parseArgs(argv) {
  const args = {
    storageDir: path.join(os.homedir(), ".config", "todu", "data", "forgejo-plugin-state"),
    toduBin: "todu",
    write: false,
    bindingId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--write") {
      args.write = true;
      continue;
    }

    if (arg === "--storage-dir") {
      args.storageDir = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--todu-bin") {
      args.toduBin = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--binding") {
      args.bindingId = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/reconcile-forgejo-comment-links.mjs [options]

Dry-run by default. Rewrites legacy Forgejo comment link note IDs like external:2592
into real local note IDs by matching task notes with sync:externalId:<commentId> tags.

Options:
  --write                 persist the repaired comment-links.json
  --storage-dir <path>    forgejo plugin storage dir
  --todu-bin <path>       todu CLI binary to use (default: todu)
  --binding <id>          limit reconciliation to one binding id
  -h, --help              show help
`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runToduJson(toduBin, args) {
  const result = spawnSync(toduBin, ["--format", "json", ...args], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${[toduBin, "--format", "json", ...args].join(" ")}\n${result.stderr || result.stdout}`
    );
  }

  return JSON.parse(result.stdout || "null");
}

function getTaskNotesCached(cache, toduBin, taskId) {
  if (!cache.has(taskId)) {
    const notes = runToduJson(toduBin, ["note", "list", "--task", taskId]);
    cache.set(taskId, Array.isArray(notes) ? notes : []);
  }

  return cache.get(taskId);
}

function getSyncExternalId(note) {
  const tags = Array.isArray(note?.tags) ? note.tags : [];
  const syncTag = tags.find(
    (tag) => typeof tag === "string" && tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX)
  );
  return syncTag ? syncTag.slice(SYNC_EXTERNAL_ID_TAG_PREFIX.length) : null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const commentLinksPath = path.join(options.storageDir, "comment-links.json");
  const itemLinksPath = path.join(options.storageDir, "item-links.json");

  const commentLinks = readJson(commentLinksPath);
  const itemLinks = readJson(itemLinksPath);
  const itemLinksByIssue = new Map(
    itemLinks.map((link) => [`${link.bindingId}:${link.issueNumber}`, link])
  );
  const notesCache = new Map();

  const stats = {
    total: 0,
    targeted: 0,
    updated: 0,
    noteIdUpdated: 0,
    taskIdUpdated: 0,
    forgejoCommentIdUpdated: 0,
    unresolved: 0,
    ambiguous: 0,
    missingItemLink: 0,
  };

  const repairs = [];
  const unresolved = [];
  const ambiguous = [];
  const nextCommentLinks = commentLinks.map((link) => {
    stats.total += 1;

    if (options.bindingId && link.bindingId !== options.bindingId) {
      return link;
    }

    const issueKey = `${link.bindingId}:${link.issueNumber}`;
    const itemLink = itemLinksByIssue.get(issueKey);
    const canonicalTaskId = itemLink?.taskId ?? link.taskId;
    const legacyNoteId =
      typeof link.noteId === "string" && link.noteId.startsWith(LEGACY_NOTE_ID_PREFIX);
    const staleTaskId = canonicalTaskId !== link.taskId;

    const notes = getTaskNotesCached(notesCache, options.toduBin, canonicalTaskId);
    const currentNote = notes.find((note) => note.id === link.noteId);
    const taggedExternalId = getSyncExternalId(currentNote);
    const staleForgejoCommentId =
      taggedExternalId !== null && taggedExternalId !== String(link.forgejoCommentId);

    if (!legacyNoteId && !staleTaskId && !staleForgejoCommentId) {
      return link;
    }

    stats.targeted += 1;

    if (!itemLink) {
      stats.missingItemLink += 1;
      unresolved.push({
        bindingId: link.bindingId,
        issueNumber: link.issueNumber,
        forgejoCommentId: link.forgejoCommentId,
        reason: "missing item link",
      });
      return link;
    }

    let nextLink = link;

    if (legacyNoteId) {
      const matches = notes.filter(
        (note) => getSyncExternalId(note) === String(link.forgejoCommentId)
      );

      if (matches.length === 0) {
        stats.unresolved += 1;
        unresolved.push({
          bindingId: link.bindingId,
          issueNumber: link.issueNumber,
          forgejoCommentId: link.forgejoCommentId,
          taskId: canonicalTaskId,
          reason: "no matching local note with sync tag",
        });
        return link;
      }

      if (matches.length > 1) {
        stats.ambiguous += 1;
        ambiguous.push({
          bindingId: link.bindingId,
          issueNumber: link.issueNumber,
          forgejoCommentId: link.forgejoCommentId,
          taskId: canonicalTaskId,
          noteIds: matches.map((note) => note.id),
        });
        return link;
      }

      nextLink = {
        ...nextLink,
        noteId: matches[0].id,
      };
      stats.noteIdUpdated += 1;
    }

    if (nextLink.taskId !== canonicalTaskId) {
      nextLink = {
        ...nextLink,
        taskId: canonicalTaskId,
      };
      stats.taskIdUpdated += 1;
    }

    if (taggedExternalId !== null && nextLink.forgejoCommentId !== Number(taggedExternalId)) {
      nextLink = {
        ...nextLink,
        forgejoCommentId: Number(taggedExternalId),
      };
      stats.forgejoCommentIdUpdated += 1;
    }

    if (nextLink !== link) {
      stats.updated += 1;
      repairs.push({
        bindingId: link.bindingId,
        issueNumber: link.issueNumber,
        forgejoCommentId: link.forgejoCommentId,
        fromTaskId: link.taskId,
        toTaskId: nextLink.taskId,
        fromNoteId: link.noteId,
        toNoteId: nextLink.noteId,
        fromForgejoCommentId: link.forgejoCommentId,
        toForgejoCommentId: nextLink.forgejoCommentId,
      });
    }

    return nextLink;
  });

  console.log(`Storage dir: ${options.storageDir}`);
  console.log(`Mode: ${options.write ? "write" : "dry-run"}`);
  if (options.bindingId) {
    console.log(`Binding filter: ${options.bindingId}`);
  }
  console.log("");
  console.log(`Total comment links: ${stats.total}`);
  console.log(`Targeted legacy/stale links: ${stats.targeted}`);
  console.log(`Repairs: ${stats.updated}`);
  console.log(`- noteId updates: ${stats.noteIdUpdated}`);
  console.log(`- taskId updates: ${stats.taskIdUpdated}`);
  console.log(`- forgejoCommentId updates: ${stats.forgejoCommentIdUpdated}`);
  console.log(`Unresolved: ${stats.unresolved}`);
  console.log(`Ambiguous: ${stats.ambiguous}`);
  console.log(`Missing item links: ${stats.missingItemLink}`);

  if (repairs.length > 0) {
    console.log("\nRepairs:");
    for (const repair of repairs) {
      console.log(
        `- ${repair.bindingId} issue #${repair.issueNumber} comment ${repair.forgejoCommentId}: task ${repair.fromTaskId} -> ${repair.toTaskId}; note ${repair.fromNoteId} -> ${repair.toNoteId}` +
          (repair.fromForgejoCommentId && repair.fromForgejoCommentId !== repair.toForgejoCommentId
            ? `; forgejoComment ${repair.fromForgejoCommentId} -> ${repair.toForgejoCommentId}`
            : "")
      );
    }
  }

  if (unresolved.length > 0) {
    console.log("\nUnresolved:");
    for (const item of unresolved) {
      console.log(
        `- ${item.bindingId} issue #${item.issueNumber} comment ${item.forgejoCommentId}: ${item.reason}${item.taskId ? ` (task ${item.taskId})` : ""}`
      );
    }
  }

  if (ambiguous.length > 0) {
    console.log("\nAmbiguous:");
    for (const item of ambiguous) {
      console.log(
        `- ${item.bindingId} issue #${item.issueNumber} comment ${item.forgejoCommentId}: matches ${item.noteIds.join(", ")}`
      );
    }
  }

  if (options.write && repairs.length > 0) {
    writeJson(commentLinksPath, nextCommentLinks);
    console.log(`\nWrote updated links to ${commentLinksPath}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
