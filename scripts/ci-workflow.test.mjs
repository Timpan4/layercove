import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workflow = readFileSync(process.env.CI_WORKFLOW_PATH ?? new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

// These helpers read the fixed indentation of our workflow, not arbitrary YAML.
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
  const lines = step(name).split("\n");
  const start = lines.findIndex((line) => line.startsWith("        run: "));
  assert.notEqual(start, -1, `Missing command: ${name}`);
  const value = lines[start].slice("        run: ".length);
  if (value !== "|") return value;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n").trimEnd();
}
function shell(program) {
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", program], { encoding: "utf8", timeout: 2000 });
  assert.ifError(result.error);
  return result.status;
}

test("frontend lint, typechecked build and tests share one frozen install", () => {
  assert.equal((workflow.match(/run: bun install --frozen-lockfile/g) ?? []).length, 1);
  assert.equal((workflow.match(/uses: oven-sh\/setup-bun/g) ?? []).length, 1);
  const frontend = job("frontend-tests");
  for (const value of ["bun run lint", "bun run build", "bun run test:run"]) {
    assert.ok(frontend.includes(`run: ${value}\n`), `Missing ${value}`);
  }
  assert.ok(frontend.indexOf("run: bun run build") < frontend.indexOf("run: bun run test:run"));
  assert.match(frontend, /node --test scripts\/ci-workflow\.test\.mjs/);
  assert.doesNotMatch(workflow, /^  frontend-(lint|typecheck):/m);
});
test("independent jobs do not wait for lint or typecheck", () => {
  for (const name of ["backend-tests", "postgres-camera-token-test", "docker-test", "frontend-tests"]) {
    assert.doesNotMatch(job(name), /^    needs:/m);
  }
});
test("both complete backend suites retain four duration-balanced shards", () => {
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
test("Docker test shards have one writer for their identical cache", () => {
  assert.match(job("docker-backend-tests"), /cache-from: type=gha,scope=backend-test/);
  assert.match(job("docker-backend-tests"), /cache-to: \$\{\{ matrix\.shard == 1 && 'type=gha,scope=backend-test,mode=max' \|\| '' \}\}/);
});
test("smoke tests use the loaded production image without rebuilding", () => {
  const docker = job("docker-test");
  assert.equal((docker.match(/uses: docker\/build-push-action/g) ?? []).length, 1);
  assert.match(docker, /load: true/);
  assert.match(docker, /tags: bambuddy:test/);
  assert.match(docker, /COMPOSE_FILE: docker-compose\.test\.yml:docker-compose\.ci\.yml/);
  const compose = readFileSync(new URL("../docker-compose.ci.yml", import.meta.url), "utf8");
  assert.match(compose, /integration:\n    image: bambuddy:test\n    pull_policy: never/);
  assert.doesNotMatch(docker, /compose[^\n]*\bbuild integration/);
  const start = command("Start integration container");
  for (const flag of ["--no-build", "--pull never", "--wait --wait-timeout 120"]) {
    assert.ok(start.includes(flag), `Missing ${flag}`);
  }
});
test("healthy startup succeeds", () => {
  assert.equal(shell(`docker() { return 0; }\n${command("Start integration container")}`), 0);
});
test("unhealthy must not pass because its text contains healthy", () => {
  const mock = `docker() {
    case " $* " in
      *" --wait "*) return 1 ;;
      *" ps "*) echo unhealthy ;;
      *) return 0 ;;
    esac
  }`;
  assert.notEqual(shell(`${mock}\n${command("Start integration container")}`), 0);
});
for (const [actual, success] of [["sha256:expected", true], ["sha256:wrong", false]]) {
  test(`smoke image identity ${success ? "accepts" : "rejects"} ${actual}`, () => {
    const mock = `docker() {
      case "$1 $2" in
        "image inspect") echo sha256:expected ;;
        "compose ps") echo integration-id ;;
        "inspect integration-id") echo '${actual}' ;;
        *) return 1 ;;
      esac
    }`;
    assert.equal(shell(`${mock}\n${command("Verify integration image identity")}`) === 0, success);
  });
}
test("an HTTP 500 fails the API smoke test", () => {
  const mock = `docker() {
    case " $* " in
      *" curl -fsS "*) return 22 ;;
      *) echo '{"error":"internal server error"}'; return 0 ;;
    esac
  }`;
  assert.notEqual(shell(`${mock}\n${command("Test API endpoint")}`), 0);
});
test("failure logs and unconditional cleanup share the Compose configuration", () => {
  assert.match(step("Show logs on failure"), /if: failure\(\)/);
  assert.match(step("Cleanup"), /if: always\(\)/);
  assert.equal(command("Show logs on failure"), "docker compose logs");
  assert.equal(command("Cleanup"), "docker compose down -v --remove-orphans");
  assert.doesNotMatch(job("docker-test"), /docker compose -f/);
});
