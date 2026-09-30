import {readFileSync} from 'node:fs';

const BLOCKED_HOST = 'registry.npmjs.org';
const KNOWN_HOSTS = new Set(['libraries.cgr.dev']);

const LOCKFILE = process.argv[2] ?? 'package-lock.json';
const MAX_LISTED = 10;

const HASH = /\bsha\d+-/g;

const scan = (lockfilePath) => {
  const blocked = [];
  const multiHash = [];
  const unknown = new Map();
  const {packages = {}} = JSON.parse(readFileSync(lockfilePath, 'utf8'));
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '' || entry.link) continue;
    const pkg =
      key.replace(/^.*node_modules\//, '') +
      (entry.version ? `@${entry.version}` : '');

    const integrity = entry.integrity;
    if (integrity && (integrity.match(HASH) ?? []).length > 1)
      multiHash.push(pkg);

    const url = entry.resolved;
    if (!url) continue;
    const {protocol, host} = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') continue;
    if (host === BLOCKED_HOST) {
      blocked.push(pkg);
    } else if (!KNOWN_HOSTS.has(host)) {
      if (!unknown.has(host)) unknown.set(host, []);
      unknown.get(host).push(pkg);
    }
  }
  return {blocked, multiHash, unknown};
};

const list = (entries) => {
  for (const entry of entries.slice(0, MAX_LISTED)) console.error(`  ${entry}`);
  if (entries.length > MAX_LISTED) {
    console.error(`  ...and ${entries.length - MAX_LISTED} more`);
  }
};

const remedy = () => {
  console.error(
    [
      '',
      'Rewrite the lockfile hashes, then commit the result:',
      '',
      '  export CHAINGUARD_TOKEN=$(chainctl auth token --audience=libraries.cgr.dev)',
      `  chainctl libraries update-hashes --replace ${LOCKFILE}`,
      '',
      'See the Dependencies section of README.md.',
      '',
    ].join('\n')
  );
};

let result;
try {
  result = scan(LOCKFILE);
} catch (error) {
  console.error(`Could not read ${LOCKFILE}: ${error.message}`);
  process.exit(1);
}

let failed = false;

if (result.unknown.size > 0) {
  failed = true;
  console.error(
    `\n${LOCKFILE} resolves packages from ${result.unknown.size} host(s) that are ` +
      `neither Chainguard Libraries nor a known exception. .npmrc sets ` +
      `allow-remote=all, so npm itself will not refuse these tarballs:\n`
  );
  for (const [host, packages] of result.unknown) {
    console.error(`  ${host} (${packages.length} package(s))`);
    list(packages);
  }
  console.error(
    '\nIf the host is expected, add it to KNOWN_HOSTS in ' +
      'scripts/check-chainguard-lockfile.mjs.\n'
  );
}

if (result.blocked.length > 0) {
  failed = true;
  console.error(
    `\n${result.blocked.length} package(s) in ${LOCKFILE} resolve from ${BLOCKED_HOST} ` +
      `instead of Chainguard Libraries. npm ci fetches the resolved URL recorded in the ` +
      `lockfile and ignores the registry setting in .npmrc, so these would bypass Chainguard:\n`
  );
  list(result.blocked);
}

if (result.multiHash.length > 0) {
  failed = true;
  console.error(
    `\n${result.multiHash.length} package(s) in ${LOCKFILE} carry more than one integrity ` +
      `hash. npm accepts a tarball matching any one of them, so the lockfile still admits ` +
      `the upstream npm tarball alongside the one Chainguard serves:\n`
  );
  list(result.multiHash);
}

if (failed) {
  remedy();
  process.exit(1);
}

console.error(
  `${LOCKFILE}: no packages resolve from ${BLOCKED_HOST}, and every entry carries a single integrity hash.`
);
