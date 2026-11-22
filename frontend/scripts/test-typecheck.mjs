import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const frontend = fileURLToPath(new URL('../', import.meta.url))

test('typecheck rejects incompatible assignments in both referenced projects', (t) => {
  // The fixture resolves installed types from the parent without sharing build state.
  const fixture = mkdtempSync(join(frontend, 'node_modules', 'typecheck-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
    copyFileSync(join(frontend, file), join(fixture, file))
  }

  mkdirSync(join(fixture, 'src'))
  const sources = ['src/app.ts', 'vite.config.ts']
  const typecheck = () => {
    const result = spawnSync('bun', ['run', 'typecheck'], { cwd: fixture, encoding: 'utf8' })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  }

  for (const file of sources) {
    writeFileSync(join(fixture, file), 'export const value: number = 42\n')
  }
  const valid = typecheck()
  assert.equal(valid.status, 0, valid.output)

  for (const file of sources) {
    writeFileSync(join(fixture, file), 'export const value: string = 42\n')
  }
  const invalid = typecheck()
  assert.ok(invalid.status > 0, invalid.output)
  assert.match(invalid.output, /src\/app\.ts.*TS2322/)
  assert.match(invalid.output, /vite\.config\.ts.*TS2322/)
})
