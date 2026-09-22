import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workflow = readFileSync(process.env.CI_WORKFLOW_PATH ?? new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const compose = readFileSync(new URL("../docker-compose.ci.yml", import.meta.url), "utf8");

// Extract only the repository's fixed indentation, not arbitrary YAML.
function job(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `Missing job: ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^  [\w-]+:$/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}
function step(name) {
  const text = job("docker-test");
  const start = text.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing step: ${name}`);
  const end = text.indexOf("\n      - name:", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}
function command(name) {
  const text = step(name);
  const start = text.indexOf("        run: ");
  assert.notEqual(start, -1, `Missing run command: ${name}`);
  const value = text.slice(start + "        run: ".length).trimEnd();
  if (!value.startsWith("|\n")) return value;
  return value.slice(2).split("\n").map((line) => line.slice(10)).join("\n");
}
function shell(program) {
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", program], { encoding: "utf8", timeout: 2000 });
}

test("frontend checks share one frozen install without dropping commands", () => {
  assert.equal((workflow.match(/run: bun install --frozen-lockfile/g) ?? []).length, 1);
  assert.equal((workflow.match(/uses: oven-sh\/setup-bun/g) ?? []).length, 1);
  const frontend = job("frontend-tests");
  for (const value of ["bun run lint", "bun x tsc --noEmit", "bun run build", "bun run test:run"]) {
    assert.ok(frontend.includes(`run: ${value}\n`), `Missing ${value}`);
  }
  assert.ok(frontend.indexOf("run: bun run build") < frontend.indexOf("run: bun run test:run"));
  assert.match(frontend, /node --test scripts\/ci-workflow-regression\.test\.mjs/);
  assert.doesNotMatch(workflow, /^  frontend-(lint|typecheck):/m);
});
test("independent jobs do not wait on lint or typecheck", () => {
  for (const name of ["backend-tests", "postgres-camera-token-test", "docker-test", "frontend-tests"]) {
    assert.doesNotMatch(job(name), /^    needs:/m);
  }
});
test("both full backend suites keep four duration-balanced shards", () => {
  for (const name of ["backend-tests", "docker-backend-tests"]) {
    const text = job(name);
    assert.match(text, /shard: \[1, 2, 3, 4\]/);
    assert.match(text, /fail-fast: false/);
    assert.match(text, /--splits 4 --group \$\{\{ matrix\.shard \}\}/);
    assert.match(text, /--splitting-algorithm least_duration/);
    assert.match(text, /--timeout=60 --timeout-method=thread/);
  }
  assert.match(job("postgres-camera-token-test"), /test_postgres_camera_token_expiry\.py/);
  assert.match(job("backend-lint"), /ruff check backend\//);
  assert.match(job("backend-lint"), /ruff format --check backend\//);
});
test("identical Docker test shards share one cache writer", () => {
  assert.match(job("docker-backend-tests"), /cache-from: type=gha,scope=backend-test/);
  assert.match(job("docker-backend-tests"), /cache-to: \$\{\{ matrix\.shard == 1 && 'type=gha,scope=backend-test,mode=max' \|\| '' \}\}/);
});
test("smoke tests reuse the loaded image without another build or pull", () => {
  const docker = job("docker-test");
  assert.equal((docker.match(/uses: docker\/build-push-action/g) ?? []).length, 1);
  assert.match(docker, /load: true/);
  assert.match(docker, /tags: bambuddy:test/);
  assert.match(docker, /COMPOSE_FILE: docker-compose\.test\.yml:docker-compose\.ci\.yml/);
  assert.match(compose, /integration:\n    image: bambuddy:test\n    pull_policy: never/);
  assert.doesNotMatch(compose, /\n\s+build:/);
  assert.doesNotMatch(docker, /compose[^\n]*\bbuild integration/);
  const start = command("Start integration container");
  assert.match(start, /--no-build/);
  assert.match(start, /--pull never/);
  assert.match(start, /--wait --wait-timeout 120/);
});
test("unhealthy startup fails rather than falling through a polling loop", () => {
  const start = command("Start integration container");
  assert.equal(shell(`docker() { echo healthy; return 0; }\n${start}`).status, 0);
  assert.notEqual(shell(`docker() { return 1; }\n${start}`).status, 0);
});
for (const [actual, success] of [["sha256:expected", true], ["sha256:wrong", false]]) {
  test(`image identity ${success ? "accepts" : "rejects"} ${actual}`, () => {
    const docker = `docker() {
      case "$1 $2" in
        "image inspect") echo sha256:expected ;;
        "compose ps") echo integration-id ;;
        "inspect integration-id") echo '${actual}' ;;
        *) return 1 ;;
      esac
    }`;
    assert.equal(shell(`${docker}\n${command("Verify integration image identity")}`).status === 0, success);
  });
}
test("all smoke HTTP checks fail on HTTP errors", () => {
  for (const name of ["Test health endpoint", "Test API endpoint", "Test static files served"]) {
    assert.match(command(name), /curl -fsS/);
    assert.notEqual(shell(`docker() { return 22; }\n${command(name)}`).status, 0);
  }
});
test("failure logs and unconditional cleanup use the same Compose project", () => {
  assert.match(step("Show logs on failure"), /if: failure\(\)/);
  assert.match(step("Cleanup"), /if: always\(\)/);
  assert.equal(command("Show logs on failure"), "docker compose logs");
  assert.equal(command("Cleanup"), "docker compose down -v --remove-orphans");
  assert.doesNotMatch(job("docker-test"), /docker compose -f/);
});
