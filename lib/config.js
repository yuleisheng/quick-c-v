const DEFAULT_PORT = 4785;

function parsePortValue(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be a number from 1 to 65535.");
  }

  return port;
}

function parsePortArgs(args) {
  const portFlag = args.find((arg) => arg.startsWith("--port="));
  if (portFlag) {
    const value = portFlag.slice("--port=".length);
    if (value === "") {
      throw new Error("Port must be a number from 1 to 65535.");
    }
    return parsePortValue(value);
  }

  const portIndex = args.indexOf("--port");
  if (portIndex !== -1) {
    const value = args[portIndex + 1];
    if (value === undefined) {
      throw new Error("Port must be a number from 1 to 65535.");
    }
    return parsePortValue(value);
  }

  return undefined;
}

module.exports = {
  DEFAULT_PORT,
  parsePortArgs,
  parsePortValue
};
