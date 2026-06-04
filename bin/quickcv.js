#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { DEFAULT_PORT, parsePortArgs, parsePortValue } = require("../lib/config");
const { getAppUrls } = require("../lib/network");

const SERVER_STATE_PATH = path.join(__dirname, "..", "data", "server.json");

function readLastPort() {
  try {
    const state = JSON.parse(fs.readFileSync(SERVER_STATE_PATH, "utf8"));
    return Number.isInteger(state.port) ? state.port : undefined;
  } catch {
    return undefined;
  }
}

function parsePort(args) {
  return parsePortArgs(args) || parsePortValue(process.env.PORT) || readLastPort() || DEFAULT_PORT;
}

function printHelp() {
  console.log(`quickcv

Usage:
  quickcv urls [--port 3001]

Commands:
  urls    Print localhost and LAN URLs for the app
`);
}

function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command !== "urls") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  let port;
  try {
    port = parsePort(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  for (const url of getAppUrls(port)) {
    console.log(url);
  }
}

main();
