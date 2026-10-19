#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const bundlePath = path.join(repoRoot, "main.bundle.js");

function collectTrackFiles(relativeDir) {
  const dirPath = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${relativeDir}`);
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".track"))
    .map((entry) => entry.name)
    .sort();
}

function formatArray(list) {
  return `[${list.map((item) => `"${item}"`).join(", ")}]`;
}

function replaceArray(bundle, identifier, arrayString) {
  const regex = new RegExp(
    `${identifier}\\s*=\\s*\\[(?:[\\s\\S]*?)\\]`
  );
  if (!regex.test(bundle)) {
    throw new Error(`Could not find definition for ${identifier}`);
  }
  return bundle.replace(regex, `${identifier} = ${arrayString}`);
}

function main() {
  const officialTracks = collectTrackFiles(path.join("tracks", "official"));
  const communityTracks = collectTrackFiles(path.join("tracks", "community"));

  if (officialTracks.length === 0 || communityTracks.length === 0) {
    throw new Error("Both official and community track folders must contain at least one .track file.");
  }

  const officialString = formatArray(officialTracks);
  const communityString = formatArray(communityTracks);

  let bundle = fs.readFileSync(bundlePath, "utf8");
  bundle = replaceArray(bundle, "officialTrackFallbacks", officialString);
  bundle = replaceArray(bundle, "communityTrackFallbacks", communityString);

  fs.writeFileSync(bundlePath, bundle);
  console.log("Updated fallback arrays:");
  console.log(`  officialTrackFallbacks = ${officialString}`);
  console.log(`  communityTrackFallbacks = ${communityString}`);

  // The multiplayer host dialog needs the same list; static hosts have no
  // directory listings, so publish it as JSON alongside the game.
  const trackListPath = path.join(repoRoot, "multiplayer", "tracks.json");
  fs.writeFileSync(
    trackListPath,
    `${JSON.stringify({ official: officialTracks, community: communityTracks }, null, 2)}\n`
  );
  console.log(`  multiplayer/tracks.json (${officialTracks.length + communityTracks.length} tracks)`);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
