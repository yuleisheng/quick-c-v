#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { getAppUrls } = require("../lib/network");

const DEFAULT_PORT = 3000;
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
  const portFlag = args.find((arg) => arg.startsWith("--port="));
  if (portFlag) {
    return Number(portFlag.slice("--port=".length));
  }

  const portIndex = args.indexOf("--port");
  if (portIndex !== -1) {
    return Number(args[portIndex + 1]);
  }

  if (process.env.PORT) {
    return Number(process.env.PORT);
  }

  return readLastPort() || DEFAULT_PORT;
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

  const port = parsePort(args);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Port must be a number from 1 to 65535.");
    process.exitCode = 1;
    return;
  }

  for (const url of getAppUrls(port)) {
    console.log(url);
  }
}

main();
