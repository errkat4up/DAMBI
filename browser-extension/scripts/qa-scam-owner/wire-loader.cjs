// Transform the compiled development host at its existing dependency boundary.
// Stop on source drift; ordinary Chrome, Firefox and release builds never load this.
const path = require("node:path");
module.exports = function (source) {
  function replaceOnce(before, after) {
    if (source.split(before).length !== 2) throw new Error("Comparison host seam changed: " + before);
    source = source.replace(before, after);
  }
  replaceOnce("const provider = createScamFactProvider({", "const provider = createComparisonProvider(config, signal, {");
  replaceOnce("host.invalidate();", "invalidateComparisonScope(); host.invalidate();");
  return 'import { createComparisonProvider, invalidateComparisonScope } from ' + JSON.stringify(path.resolve(__dirname, "bridge.js")) + ';\n' + source;
};
