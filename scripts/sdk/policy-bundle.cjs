// Shared source loader for SDK fixtures and the legacy extension asset copier.
// Cedar parsing and full ManifestV2 validation remain the engine's responsibility.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function loadPolicyBundle(repoRoot, bundleName = "day1-safety") {
  if (!/^[a-z0-9-]+$/.test(bundleName)) throw new Error("Invalid policy bundle name");
  const root = join(repoRoot, "policy-bundles", bundleName);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.package !== bundleName || !Array.isArray(pkg.policies) || pkg.policies.length === 0) {
    throw new Error(`Invalid policy package: ${bundleName}`);
  }
  const seen = new Set();
  // Preserve the package's declared order and the policy/manifest bytes' content.
  return pkg.policies.map(({ id, dir, severity }) => {
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id) || seen.has(id) || dir !== `policies/${id}`) {
      throw new Error(`Invalid or duplicate policy entry: ${id}`);
    }
    seen.add(id);
    const policy = readFileSync(join(root, dir, "policy.cedar"), "utf8");
    const manifest = JSON.parse(readFileSync(join(root, dir, "manifest.json"), "utf8"));
    if (!manifest || Array.isArray(manifest) || manifest.id !== id || manifest.schema_version !== 2) {
      throw new Error(`Invalid manifest identity/version: ${id}`);
    }
    const annotatedId = policy.match(/^@id\("([^"\r\n]+)"\)/m)?.[1];
    const annotatedSeverity = policy.match(/^@severity\("([^"\r\n]+)"\)/m)?.[1];
    if (annotatedId !== id || !["warn", "deny"].includes(severity) || annotatedSeverity !== severity) {
      throw new Error(`Policy annotations disagree with package: ${id}`);
    }
    return { id, policy, manifest };
  });
}

// Existing baseline hash covers this exact format, with no trailing newline.
function serializePolicyBundle(bundles) {
  return JSON.stringify(bundles, null, 2);
}

module.exports = { loadPolicyBundle, serializePolicyBundle };
