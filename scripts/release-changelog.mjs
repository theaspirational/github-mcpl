// Runs as npm's `version` lifecycle hook: package.json already carries the
// new version, and files staged here go into the release commit that
// `npm version` then creates and tags.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG = "CHANGELOG.md";
const FRAGMENT_DIR = "changelog.d";
const CATEGORIES = ["breaking", "added", "changed", "fixed"];
const HEADINGS = {
  breaking: "Breaking",
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
};

// Refusals throw and set exitCode rather than calling process.exit(), which
// can cut off a stderr write still pending: Node writes to a pipe
// asynchronously on POSIX.
export class ReleaseError extends Error {}
const fail = (msg) => {
  throw new ReleaseError(msg);
};

// A heading inside a list item still renders as a heading.
const isBulletStart = (l) => /^[-*] /.test(l);
const isContinuation = (l) => /^ {2,}\S/.test(l);
const itemContent = (l) => l.replace(/^\s*(?:[-*]\s+)?/, "");
const isHeading = (s) => /^#{1,6}(\s|$)/.test(s);
const isRule = (s) => /^([-*_=])(\s*\1){2,}\s*$/.test(s);
const isBlockConstruct = (l) => isRule(l.trim()) || isHeading(itemContent(l));

function collectFragments(dir) {
  const fragments = [];
  if (!existsSync(join(dir, FRAGMENT_DIR))) return fragments;
  const entries = readdirSync(join(dir, FRAGMENT_DIR), { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of entries) {
    const { name } = entry;
    if (name === "README.md") continue;
    if (!entry.isFile()) {
      fail(
        `${FRAGMENT_DIR}/${name}: not a file. Fragments are flat files directly ` +
          `in ${FRAGMENT_DIR}/ — a slug cannot contain '/'; use the PR number, ` +
          "or the branch name with '/' replaced by '-'.",
      );
    }
    const m = name.match(/\.(breaking|added|changed|fixed)\.md$/);
    if (!m) {
      fail(
        `${FRAGMENT_DIR}/${name}: unrecognized file — name fragments ` +
          `'<slug>.<${CATEGORIES.join("|")}>.md' so the entry is not silently stranded.`,
      );
    }
    const body = readFileSync(join(dir, FRAGMENT_DIR, name), "utf8").trim();
    if (!body) fail(`${FRAGMENT_DIR}/${name}: empty fragment.`);
    const offending = body
      .split("\n")
      .find(
        (l) =>
          l.trim() !== "" &&
          (!(isBulletStart(l) || isContinuation(l)) || isBlockConstruct(l)),
      );
    if (offending !== undefined) {
      fail(
        `${FRAGMENT_DIR}/${name}: a fragment is one or more markdown bullets ` +
          "('- …'; continuation lines indented two spaces; no headings or " +
          `rules) — offending line: '${offending}'.`,
      );
    }
    fragments.push({ name, category: m[1], body });
  }
  return fragments;
}

function mergeFragments(body, frags) {
  const preamble = [];
  const parts = [];
  let current = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^###\s+(.*)$/);
    if (h) {
      current = { title: h[1].trim(), lines: [] };
      parts.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  for (const f of frags) {
    let part = parts.find((p) => p.title.toLowerCase().startsWith(f.category));
    if (!part) {
      part = { title: HEADINGS[f.category], lines: [] };
      parts.push(part);
    }
    part.lines.push("", ...f.body.split("\n"));
  }
  const rank = (t) => {
    const i = CATEGORIES.findIndex((c) => t.toLowerCase().startsWith(c));
    return i === -1 ? CATEGORIES.length : i;
  };
  const chunks = [];
  const pre = preamble.join("\n").trim();
  if (pre) chunks.push(pre);
  for (const p of [...parts].sort((a, b) => rank(a.title) - rank(b.title))) {
    const content = p.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    chunks.push(content ? `### ${p.title}\n\n${content}` : `### ${p.title}`);
  }
  return chunks.join("\n\n");
}

export function release(dir) {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const text = readFileSync(join(dir, CHANGELOG), "utf8");
  const fragments = collectFragments(dir);

  const headings = [...text.matchAll(/^## Unreleased[ \t]*$/gm)];
  if (headings.length === 0) {
    fail(`no '## Unreleased' section in ${CHANGELOG} — add one before releasing.`);
  }
  if (headings.length > 1) {
    const lines = headings.map((m) => text.slice(0, m.index).split("\n").length);
    fail(
      `${headings.length} '## Unreleased' headings (lines ${lines.join(", ")}). ` +
        "Only the first is released; fold them into one before releasing.",
    );
  }
  const [header] = headings;

  const escaped = version.replace(/[.]/g, "\\.");
  if (new RegExp(`^## ${escaped}([^0-9]|$)`, "m").test(text)) {
    fail(`a '## ${version}' section already exists.`);
  }

  const afterHeader = text.slice(header.index + header[0].length);
  const nextSection = afterHeader.search(/^## /m);
  const oldBody = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  const rest = nextSection === -1 ? "" : afterHeader.slice(nextSection);

  const merged = mergeFragments(oldBody, fragments);
  if (!/^[ \t]*[-*] /m.test(merged)) {
    fail(
      `nothing to release as ${version} — no fragments in ${FRAGMENT_DIR}/ ` +
        "and no entries under '## Unreleased'.",
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dir, CHANGELOG),
    text.slice(0, header.index) +
      `## Unreleased\n\n## ${version} — ${date}\n\n${merged}\n\n` +
      rest,
  );
  for (const f of fragments) unlinkSync(join(dir, FRAGMENT_DIR, f.name));
  return (
    `${CHANGELOG}: released '## ${version} — ${date}' from ${fragments.length} ` +
    "fragment(s) plus the Unreleased section."
  );
}

// import.meta.url names the script's real path, and argv[1] the path it was
// run by, which a symlink can differ from. When a module imports this one,
// argv[1] is that program's, and need not name a file at all.
function isMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    console.log(release(process.cwd()));
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    console.error(`release-changelog: ${e.message}`);
    process.exitCode = 1;
  }
}
