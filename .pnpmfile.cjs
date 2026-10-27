// TypeScript 7 ships no compiler API, so tools that call it (typescript-eslint, tsup) get the
// TS 6 compatibility package instead of the root `typescript` peer.
// Remove once these tools support TS 7: https://github.com/typescript-eslint/typescript-eslint/issues/10940
const TS6 = "npm:@typescript/typescript6@^6.0.2";
const usesTs6 = (name) =>
  name === "typescript-eslint" ||
  name === "tsup" ||
  name.startsWith("@typescript-eslint/") ||
  name === "ts-api-utils";

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (usesTs6(pkg.name) && pkg.peerDependencies?.typescript) {
        delete pkg.peerDependencies.typescript;
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
      }
      return pkg;
    },
  },
};
