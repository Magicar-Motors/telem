import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "scene deck launcher "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const name of ["client", "udp-client-receiver", "obs-controller-webapp"]) {
    mkdirSync(join(root, name));
    mkdirSync(join(root, name, "node_modules"));
  }
  const script = join(root, "start-all-client.sh");
  copyFileSync(new URL("../../start-all-client.sh", import.meta.url), script);
  const log = join(root, "commands.log");
  for (const name of ["npm", "tmux", "tailscale", "node"]) {
    writeFileSync(join(bin, name), `#!/bin/bash
printf '%s:%s:%s\\n' '${name}' "$PWD" "$*" >> "$LAUNCHER_TEST_LOG"
if [[ '${name}' == tmux && "$1" == has-session ]]; then exit "\${SESSION_STATUS:-1}"; fi
if [[ '${name}' == node ]]; then exit "\${FUNNEL_STATUS:-0}"; fi
exit 0
`, { mode: 0o755 });
  }
  return {
    run(shell = "/bin/bash", args = [], overrides = {}) {
      return spawnSync(shell, [script, ...args], {
        encoding: "utf8", input: "\n", timeout: 10000,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, LAUNCHER_TEST_LOG: log, ...overrides },
      });
    },
    log: () => readFileSync(log, "utf8"), root,
  };
}

for (const shell of ["/bin/bash", "/bin/sh", "/bin/zsh"]) {
  test(`launcher prepares Funnel under ${shell} with spaces in its path`, (t) => {
    const f = fixture(t); const result = f.run(shell);
    assert.equal(result.status, 0, result.stderr);
    const log = f.log();
    assert.doesNotMatch(log, /:ci$/m);
    assert.equal(log.match(/:i$/gm)?.length, 3);
    assert.match(log, /:run build:funnel/);
    assert.match(log, /:funnel --bg --yes http:\/\/127\.0\.0\.1:8787/);
    assert.match(log, /tmux:.*:split-window .*\/bin\/bash .*--run obs-controller/);
    assert.ok(log.indexOf(":run build:funnel") < log.indexOf(":new-session"));
  });
}

test("controller pane runs the Funnel variant", (t) => {
  const f = fixture(t); assert.equal(f.run("/bin/bash", ["--run", "obs-controller"]).status, 0);
  assert.match(f.log(), /:run start:funnel/);
  assert.doesNotMatch(f.log(), /:run dev/);
});

test("missing Funnel permission fails before creating panes", (t) => {
  const f = fixture(t); assert.equal(f.run("/bin/bash", [], { FUNNEL_STATUS: "1" }).status, 1);
  assert.doesNotMatch(f.log(), /:new-session/);
});

test("an existing session is left running without installing or rebuilding", (t) => {
  const f = fixture(t); assert.equal(f.run("/bin/bash", [], { SESSION_STATUS: "0" }).status, 0);
  assert.doesNotMatch(f.log(), /npm:|tailscale:/);
});
