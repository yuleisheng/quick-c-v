const os = require("os");

function getLanUrls(port) {
  const urls = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return urls;
}

function getAppUrls(port) {
  return [`http://localhost:${port}`, ...getLanUrls(port)];
}

module.exports = {
  getAppUrls,
  getLanUrls
};
